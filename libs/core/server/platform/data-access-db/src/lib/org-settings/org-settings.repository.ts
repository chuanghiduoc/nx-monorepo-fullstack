import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { parseSetting, type SettingKey, type SettingValue } from '@workspace/core-server-core';

import { Database } from '../transaction/database.js';

/** A setting as stored, with the version a writer must quote to change it. */
export interface StoredSetting<K extends SettingKey = SettingKey> {
  readonly key: K;
  readonly value: SettingValue<K>;
  readonly version: number;
}

/**
 * An organization's settings.
 *
 * Every value is parsed against its registered schema on the way out as well
 * as on the way in: a row written before a schema changed would otherwise
 * reach the application as a shape nothing expects, and the failure would
 * surface wherever it happened to be used rather than here.
 */
@Injectable()
export class OrgSettingsRepository {
  private readonly db: Database;

  constructor(@Inject(Database) db: Database) {
    this.db = db;
  }

  /** The stored setting, or undefined when the organization has never set it. */
  async find<K extends SettingKey>(key: K): Promise<StoredSetting<K> | undefined> {
    return this.db.withRequestTransaction(async () => {
      const row = await this.db.tenant().orgSetting.findFirst({ where: { key } });

      if (!row) {
        return undefined;
      }

      return {
        key,
        value: parseSetting(key, row.value),
        version: row.version,
      };
    });
  }

  /**
   * Writes a setting, refusing a write based on a version that is no longer
   * current.
   *
   * Two administrators editing the same setting from the same starting point
   * would otherwise both succeed, and the second would silently erase the
   * first. `expectedVersion` is omitted only when creating.
   */
  async set<K extends SettingKey>(
    orgId: string,
    key: K,
    value: unknown,
    expectedVersion?: number,
  ): Promise<StoredSetting<K>> {
    const parsed = parseSetting(key, value);

    return this.db.withRequestTransaction(async () => {
      const settings = this.db.tenant().orgSetting;
      const existing = await settings.findFirst({ where: { key } });

      if (!existing) {
        const created = await settings.create({
          data: { orgId, key, value: parsed as never },
        });
        return { key, value: parsed, version: created.version };
      }

      if (expectedVersion !== undefined && expectedVersion !== existing.version) {
        throw new ConflictException(
          `"${key}" has changed since it was read. Read it again and reapply the change.`,
        );
      }

      // The version is part of the condition, not only of the payload: between
      // the read above and this update another writer may have committed, and
      // a plain update by id would overwrite them.
      const updated = await settings.updateMany({
        where: { id: existing.id, version: existing.version },
        data: { value: parsed as never, version: existing.version + 1 },
      });

      if (updated.count === 0) {
        throw new ConflictException(
          `"${key}" was changed by someone else. Read it again and reapply the change.`,
        );
      }

      return { key, value: parsed, version: existing.version + 1 };
    });
  }
}
