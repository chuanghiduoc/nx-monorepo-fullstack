import { Inject, Injectable } from '@nestjs/common';

import { Database } from '../transaction/database.js';

/**
 * How many rows one statement removes.
 *
 * Bounded so a sweep never holds a long transaction over a table the API is
 * writing to. The caller repeats the call until a run comes back empty, so the
 * bound costs throughput, not completeness.
 */
export const SWEEP_BATCH = 1_000;

/**
 * Deleting rows that have expired.
 *
 * Every statement here follows the same shape, and the shape is the point:
 *
 * ```sql
 * WITH expired AS MATERIALIZED (
 *   SELECT id FROM t WHERE <expired> LIMIT n FOR UPDATE SKIP LOCKED)
 * DELETE FROM t WHERE id IN (SELECT id FROM expired) AND <expired>
 * ```
 *
 * The CTE is `MATERIALIZED` on purpose. Written inline as
 * `IN (SELECT ... LIMIT n)`, the planner is free to turn it into a semi-join
 * and re-execute the subquery per candidate row — and because each row it
 * takes stops matching the predicate, every re-execution returns the *next*
 * rows until there are none. Measured on PostgreSQL 18: a statement asked for
 * two took all five. The batch would then bound nothing at all.
 *
 * `FOR UPDATE SKIP LOCKED` so two replicas sweeping at once take disjoint rows
 * instead of one waiting on the other's locks and then finding nothing left.
 *
 * The predicate is repeated in the outer `WHERE` against a row that changes
 * between being selected and being deleted — a session a request renewed while
 * the sweep was running. Measured on PostgreSQL 18: either that or the
 * `FOR UPDATE` alone is enough, because READ COMMITTED re-evaluates the qual
 * of whichever node holds the lock, and only with both removed is the renewed
 * session deleted. They are kept together because they guard the two halves of
 * the statement, and a later edit is far more likely to touch one than both.
 *
 * **There is deliberately no `ORDER BY`.** It reads as a harmless nicety —
 * oldest first — and it is the thing that can stop the batch from bounding any
 * work. An ordered result no index can supply has to be sorted, and a sort
 * sees every qualifying row before it yields the first: the `LIMIT` then
 * bounds what is deleted and locked but not what is read. Which rows a sweep
 * takes first does not matter — the next batch takes the rest.
 *
 * Measured on PostgreSQL 18 at 500 000 rows with 5 000 sweepable. On the real
 * table `ORDER BY id` costs about a quarter more pages for the same batch; on
 * a narrower one, where the planner reaches for a bitmap scan over both
 * indexes instead, it read five times the rows and five times the pages. The
 * size of the difference is the planner's business. That nothing has to sort
 * is not, and it is what the plan test pins.
 *
 * Raw SQL because `FOR UPDATE SKIP LOCKED` has no Prisma Client API. Row-level
 * security still applies to raw statements; none of these tables carries a
 * tenant policy, and all three are reached through grants.
 */
@Injectable()
export class RetentionRepository {
  private readonly db: Database;

  constructor(@Inject(Database) db: Database) {
    this.db = db;
  }

  /**
   * Removes sessions that have expired.
   *
   * Safe because the row's own `expires_at` is the whole truth: better-auth
   * writes a new one on every sliding refresh, and a request that presents a
   * session the database does not have gets the same answer as one that
   * presents an expired session — the cookie is cleared and the response is
   * null.
   */
  async sweepExpiredSessions(limit = SWEEP_BATCH): Promise<number> {
    return this.db.system().$executeRaw`
      WITH expired AS MATERIALIZED (
        SELECT id FROM "session"
         WHERE expires_at < now()
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED)
      DELETE FROM "session"
       WHERE id IN (SELECT id FROM expired)
         AND expires_at < now()`;
  }

  /** Removes verification tokens that have expired. */
  async sweepExpiredVerifications(limit = SWEEP_BATCH): Promise<number> {
    return this.db.system().$executeRaw`
      WITH expired AS MATERIALIZED (
        SELECT id FROM "verification"
         WHERE expires_at < now()
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED)
      DELETE FROM "verification"
       WHERE id IN (SELECT id FROM expired)
         AND expires_at < now()`;
  }

  /**
   * Removes idempotency records nobody will replay.
   *
   * Two kinds, not one. A record that finished — `complete()` and `fail()`
   * both stamp `completed_at` — stops being replayable once the retention
   * window has passed. A record that never finished has `completed_at` NULL
   * forever, because a process that died mid-claim leaves the row for the next
   * attempt to reclaim rather than to close; sweeping only on `completed_at`
   * would leak exactly those.
   *
   * One statement, not two. Splitting it so each half could be driven by its
   * own index was measured and is worse: unordered, the two indexes combine
   * under a single scan that stops at the batch, while the split pays for a
   * second round trip and, for the abandoned half, a scan with no index that
   * covers both of its conditions.
   *
   * The window has to stay far above the claim lease. Deleting a record resets
   * the fence token, so a writer from a long-abandoned attempt could come back,
   * find a fresh row at the same token, and overwrite a response that a later
   * caller had already been given.
   */
  async sweepIdempotencyRecords(
    olderThanHours: number,
    limit = SWEEP_BATCH,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1_000);

    return this.db.system().$executeRaw`
      WITH stale AS MATERIALIZED (
        SELECT id FROM "idempotency_records"
         WHERE completed_at < ${cutoff}
            OR (completed_at IS NULL AND lease_until < ${cutoff})
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED)
      DELETE FROM "idempotency_records"
       WHERE id IN (SELECT id FROM stale)
         AND (completed_at < ${cutoff}
           OR (completed_at IS NULL AND lease_until < ${cutoff}))`;
  }
}
