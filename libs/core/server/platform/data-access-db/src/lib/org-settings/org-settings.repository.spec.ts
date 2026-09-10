import { ConflictException } from '@nestjs/common';
import {
  UnknownSettingError,
  withRequestContext,
  type RequestContext,
} from '@workspace/core-server-core';
import {
  POSTGRES_START_TIMEOUT_MS,
  startPostgres,
  type TestPostgres,
} from '@workspace/core-server-testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../prisma.service.js';
import { Database } from '../transaction/database.js';
import { OrgSettingsRepository } from './org-settings.repository.js';

const ORG = '0199a1b2-0000-7000-8000-00000000000a';
const OTHER_ORG = '0199a1b2-0000-7000-8000-00000000000b';
const USER = '0199a1b2-0000-7000-8000-0000000000aa';

const requestAs = (orgId: string): RequestContext => ({
  principal: { type: 'user', id: USER, orgId, roles: ['owner'] },
  tenant: { kind: 'org', orgId, userId: USER },
});

describe('organization settings', () => {
  let postgres: TestPostgres;
  let prisma: PrismaService;
  let db: Database;
  let settings: OrgSettingsRepository;

  beforeAll(async () => {
    postgres = await startPostgres();
    prisma = new PrismaService('DATABASE_URL', 'DATABASE_POOL_MAX');
    await prisma.$connect();
    db = new Database(prisma);
    settings = new OrgSettingsRepository(db);
  }, POSTGRES_START_TIMEOUT_MS);

  afterAll(async () => {
    await prisma?.$disconnect();
    await postgres?.stop();
  });

  beforeEach(async () => {
    const { Client } = await import('pg');
    const owner = new Client({ connectionString: postgres.migrationUri });
    await owner.connect();
    try {
      await owner.query('DELETE FROM org_settings');
    } finally {
      await owner.end();
    }
  });

  const asOrg = <T>(orgId: string, work: () => Promise<T>): Promise<T> =>
    withRequestContext(requestAs(orgId), work);

  it('returns nothing for a setting never configured', async () => {
    const found = await asOrg(ORG, () => settings.find('security.ipAllowlist'));

    expect(found).toBeUndefined();
  });

  it('stores a value and reads it back', async () => {
    await asOrg(ORG, () =>
      settings.set(ORG, 'security.ipAllowlist', ['10.0.0.0/8']),
    );

    const found = await asOrg(ORG, () => settings.find('security.ipAllowlist'));

    expect(found?.value).toEqual(['10.0.0.0/8']);
    expect(found?.version).toBe(1);
  });

  it('refuses a value the schema rejects', async () => {
    const bad = asOrg(ORG, () =>
      settings.set(ORG, 'security.sessionIdleDays', 0),
    );

    // The registry is what stops key-value storage from meaning anything goes.
    await expect(bad).rejects.toThrow();
  });

  it('refuses a key nobody registered', async () => {
    const bad = asOrg(ORG, () =>
      settings.set(ORG, 'security.madeUp' as never, true),
    );

    await expect(bad).rejects.toThrow(UnknownSettingError);
  });

  it('raises the version on every write', async () => {
    await asOrg(ORG, () => settings.set(ORG, 'security.sessionIdleDays', 14));
    const second = await asOrg(ORG, () =>
      settings.set(ORG, 'security.sessionIdleDays', 21),
    );

    expect(second.version).toBe(2);
  });

  it('refuses a write based on a version that has moved on', async () => {
    const first = await asOrg(ORG, () =>
      settings.set(ORG, 'security.sessionIdleDays', 14),
    );

    // Someone else edits it.
    await asOrg(ORG, () =>
      settings.set(ORG, 'security.sessionIdleDays', 21, first.version),
    );

    // The first administrator writes from the value they read.
    const stale = asOrg(ORG, () =>
      settings.set(ORG, 'security.sessionIdleDays', 30, first.version),
    );

    await expect(stale).rejects.toThrow(ConflictException);
  });

  it('keeps one organization out of another’s settings', async () => {
    await asOrg(ORG, () =>
      settings.set(ORG, 'security.ipAllowlist', ['10.0.0.0/8']),
    );

    const fromOther = await asOrg(OTHER_ORG, () =>
      settings.find('security.ipAllowlist'),
    );

    // Row-level security, not a `where` clause the repository remembered to
    // write: the query above asks for a key, not for an organization.
    expect(fromOther).toBeUndefined();
  });

  it('needs a request context, and says so without one', async () => {
    await expect(settings.find('security.ipAllowlist')).rejects.toThrow(
      /no request context/i,
    );
  });
});
