import { Inject, Injectable, Logger } from '@nestjs/common';

import { Database, FlagRepository } from '@workspace/core-server-data-access-db';

/**
 * How long a global flag value may be stale.
 *
 * Also the answer to "how long until a change is visible everywhere", because
 * there is no invalidation message: every process reloads on its own clock.
 * Thirty seconds is short enough that a rollout is not a deployment and long
 * enough that the table is read twice a minute per replica rather than twice a
 * request.
 */
export const GLOBAL_FLAG_TTL_MS = 30_000;

/**
 * The global flag table, held in memory.
 *
 * The whole table in one read, refreshed on a clock. It is small by
 * construction — one row per flag the product has — and every request reads
 * from it, which is the shape a cache is actually for.
 *
 * **Per-tenant overrides are deliberately not cached.** Turning a flag on for
 * one customer is what happens during an incident, and a per-tenant cache
 * would need a bound and an eviction policy for a problem nobody has measured.
 * The override read is a primary-key lookup inside a transaction the caller
 * had already opened.
 *
 * **A failed refresh serves the values it already has.** A flag store that
 * throws when the database is unreachable turns one outage into every request
 * failing, which is the opposite of what a kill switch is for. The staleness
 * is logged at error level; the request continues.
 */
@Injectable()
export class GlobalFlagCache {
  private readonly logger = new Logger(GlobalFlagCache.name);
  private readonly db: Database;
  private readonly flags: FlagRepository;

  /** Empty until the first load, which is not the same as "no flags". */
  private values = new Map<string, unknown>();
  private loadedAt = 0;
  private loading: Promise<void> | undefined;

  constructor(
    @Inject(Database) db: Database,
    @Inject(FlagRepository) flags: FlagRepository,
  ) {
    this.db = db;
    this.flags = flags;
  }

  /**
   * The current global value for a key, or `undefined` when there is no such
   * flag — which is not an error and must not be one: an unknown key resolves
   * to the caller's default, so deleting a flag from the table is a safe
   * operation rather than an outage in every caller that still names it.
   */
  async get(key: string): Promise<unknown> {
    await this.refreshIfStale();

    return this.values.get(key);
  }

  /** Drops what is held, so the next read reloads. For tests and for a
   * future invalidation message that does not exist yet. */
  invalidate(): void {
    this.loadedAt = 0;
  }

  /**
   * Reads the table in whatever transaction the caller is already in.
   *
   * `feature_flags` is GLOBAL — no policy — so any transaction can read it,
   * and joining the caller's is not a compromise. Opening a system transaction
   * unconditionally *is* one: `run` refuses to join a transaction with a
   * different context, so a flag read inside a tenant transaction threw, the
   * failure was caught here, and the cache went on serving whatever it last
   * managed to load. Measured — a value written to the table was never picked
   * up again, and the only trace was an error line.
   */
  private async read(): Promise<{ key: string; value: unknown }[]> {
    if (this.db.currentTransactionContext() !== undefined) {
      return this.flags.allGlobal();
    }

    return this.db.withSystemTransaction(() => this.flags.allGlobal());
  }

  private async refreshIfStale(): Promise<void> {
    if (Date.now() - this.loadedAt < GLOBAL_FLAG_TTL_MS) {
      return;
    }

    // One reload, however many callers arrive at once. Without this, a cold
    // cache under load issues one query per concurrent request — the stampede
    // the cache exists to prevent, at exactly the moment it matters.
    this.loading ??= this.reload().finally(() => {
      this.loading = undefined;
    });

    await this.loading;
  }

  private async reload(): Promise<void> {
    try {
      const rows = await this.read();

      this.values = new Map(rows.map((row) => [row.key, row.value]));
      this.loadedAt = Date.now();
    } catch (failure) {
      // Deliberately not rethrown, and deliberately not marked loaded: the
      // values already held keep answering, and the next call tries again
      // rather than waiting out a window that never started.
      const reason = failure instanceof Error ? failure.message : String(failure);
      this.logger.error(
        `Could not reload feature flags, so ${this.values.size} value(s) from ` +
          `${new Date(this.loadedAt).toISOString()} are still being served: ${reason}`,
      );
    }
  }
}
