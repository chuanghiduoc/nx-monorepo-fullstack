import { Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client.js';
import { activeTransaction } from '../transaction/transaction-context.js';
import { windowStart, type QuotaWindow } from './window.js';

export interface ConsumeRequest {
  readonly entitlement: string;
  readonly window: QuotaWindow;
  /** The ceiling in force right now, resolved by the caller before it asks. */
  readonly limit: number;
  readonly amount: number;
}

export interface RecordRequest {
  readonly entitlement: string;
  readonly window: QuotaWindow;
  readonly amount: number;
}

export interface ReserveRequest extends ConsumeRequest {
  /** When the sweep may take the units back if nothing has settled it. */
  readonly expiresAt: Date;
}

/**
 * What an organization has used, and what is being held for it.
 *
 * **The counter has no `limit` column.** The ceiling is an argument to the
 * statement, which enforces it on every write. Storing it was measured on
 * PostgreSQL 18 and made lowering a plan's limit below current usage fail with
 * a constraint violation — which is to say it made downgrading impossible for
 * exactly the tenants who do it.
 *
 * Every statement here is one statement. That is not terseness: a read
 * followed by a write is write-skew on an aggregate, and two transactions at
 * READ COMMITTED both reading `used = 8` against a limit of 10 and both adding
 * 2 is the oversell this table exists to prevent. A conditional upsert takes
 * the row lock itself, so READ COMMITTED needs no explicit lock and no
 * serializable retry.
 *
 * Raw SQL because none of these shapes has a Prisma Client API: `ON CONFLICT
 * ... DO UPDATE ... WHERE` has no `upsert()` equivalent, and the answer these
 * calls return — whether the row moved — is the entire point of making them.
 *
 * **Lock order.** Closing a reservation locks the reservation and then the
 * counter; `reserve` locks the counter and then inserts a reservation nobody
 * else can be holding, because it did not exist a moment ago. There is no
 * cycle, so there is no deadlock to order around.
 */
@Injectable()
export class QuotaRepository {
  /**
   * Takes units, or reports that they do not fit.
   *
   * `true` means the units are charged and will commit with whatever else this
   * transaction does. `false` means over quota — the caller's 429 — and it is
   * the *only* refusal: a request larger than the entire limit gets `false`
   * too, rather than the constraint violation an unguarded insert would raise
   * inside the caller's transaction and roll the business write back with.
   *
   * The boundary is `<=`: a limit of ten permits the tenth unit.
   */
  async consume(request: ConsumeRequest): Promise<boolean> {
    const { orgId, client } = this.tenant();
    const start = windowStart(request.window, new Date());

    const taken = await client.$executeRaw`
      INSERT INTO "org_quota_counters" (org_id, entitlement, window_start, used)
      SELECT ${orgId}::uuid, ${request.entitlement}, ${start}, ${request.amount}::bigint
       WHERE ${request.amount}::bigint <= ${request.limit}::bigint
      ON CONFLICT (org_id, entitlement, window_start)
      DO UPDATE SET used = "org_quota_counters".used + ${request.amount}::bigint,
                    updated_at = now()
       WHERE "org_quota_counters".used + ${request.amount}::bigint <= ${request.limit}::bigint`;

    return taken > 0;
  }

  /**
   * Counts units that have already been spent.
   *
   * No ceiling, and that is the whole difference from `consume`. Some costs
   * are not knowable before they are incurred — the tokens a completion turns
   * out to use are the case this exists for — and refusing to record them
   * because they went over would drop the count in exactly the situation where
   * it matters most.
   *
   * A caller that wants a ceiling on this kind of usage reads `usage` before
   * doing the work and refuses there. That ceiling is **soft**: work already in
   * flight can carry the total past it, and no amount of machinery here would
   * change that, because the amount was not known when the decision was made.
   *
   * Still one statement, for the same reason every other one is: two
   * transactions recording against the same counter must not lose one of the
   * two increments.
   */
  async record(request: RecordRequest): Promise<void> {
    const { orgId, client } = this.tenant();
    const start = windowStart(request.window, new Date());

    await client.$executeRaw`
      INSERT INTO "org_quota_counters" (org_id, entitlement, window_start, used)
      VALUES (${orgId}::uuid, ${request.entitlement}, ${start}, ${request.amount}::bigint)
      ON CONFLICT (org_id, entitlement, window_start)
      DO UPDATE SET used = "org_quota_counters".used + ${request.amount}::bigint,
                    updated_at = now()`;
  }

  /**
   * Takes units and records that something is holding them.
   *
   * The units are charged now, not when the reservation is committed: a
   * reservation that had not charged would be a promise the counter cannot
   * keep, and two concurrent reservations for six units each against a limit
   * of ten would both succeed.
   *
   * Returns the reservation's id, or `null` when the units do not fit — in
   * which case nothing was written, because the counter update is the first
   * step of the same statement.
   */
  async reserve(request: ReserveRequest): Promise<string | null> {
    const { orgId, client } = this.tenant();
    const start = windowStart(request.window, new Date());

    const rows = await client.$queryRaw<{ id: string }[]>`
      WITH taken AS (
        INSERT INTO "org_quota_counters" (org_id, entitlement, window_start, used)
        SELECT ${orgId}::uuid, ${request.entitlement}, ${start}, ${request.amount}::bigint
         WHERE ${request.amount}::bigint <= ${request.limit}::bigint
        ON CONFLICT (org_id, entitlement, window_start)
        DO UPDATE SET used = "org_quota_counters".used + ${request.amount}::bigint,
                      updated_at = now()
         WHERE "org_quota_counters".used + ${request.amount}::bigint <= ${request.limit}::bigint
        RETURNING org_id, entitlement, window_start)
      INSERT INTO "quota_reservations"
        (org_id, entitlement, window_start, amount, expires_at)
      SELECT t.org_id, t.entitlement, t.window_start,
             ${request.amount}::bigint, ${request.expiresAt}
        FROM taken t
      RETURNING id`;

    return rows[0]?.id ?? null;
  }

  /**
   * Closes a reservation and keeps its units.
   *
   * Only the state moves; the counter was charged when the reservation was
   * created. `false` means it was not open — already committed, already
   * released, expired, or another tenant's.
   */
  async commit(reservationId: string): Promise<boolean> {
    const { client } = this.tenant();

    const closed = await client.$executeRaw`
      UPDATE "quota_reservations"
         SET state = 'COMMITTED', closed_at = now()
       WHERE id = ${reservationId}::uuid AND state = 'RESERVED'`;

    return closed > 0;
  }

  /**
   * Closes a reservation and gives its units back.
   *
   * Idempotent through the state machine rather than through a flag: the
   * update moves a row only out of `RESERVED`, so a retried release refunds
   * once and honestly reports that the second call changed nothing. A flag
   * would need a read to check it, and a read before a write is the race this
   * whole file is written to avoid.
   *
   * The refund goes to the window the reservation *charged*, which it carries
   * itself. A job that started on the 31st and failed on the 1st must not
   * credit a month that was never charged and leave the charged one short.
   */
  async release(reservationId: string): Promise<boolean> {
    const { client } = this.tenant();

    const refunded = await client.$executeRaw`
      WITH released AS (
        UPDATE "quota_reservations"
           SET state = 'RELEASED', closed_at = now()
         WHERE id = ${reservationId}::uuid AND state = 'RESERVED'
        RETURNING org_id, entitlement, window_start, amount)
      UPDATE "org_quota_counters" c
         SET used = c.used - r.amount, updated_at = now()
        FROM released r
       WHERE c.org_id = r.org_id
         AND c.entitlement = r.entitlement
         AND c.window_start = r.window_start`;

    return refunded > 0;
  }

  /** What this organization has used in the current window. */
  async usage(entitlement: string, window: QuotaWindow): Promise<number> {
    const { orgId, client } = this.tenant();
    const start = windowStart(window, new Date());

    const rows = await client.$queryRaw<{ used: bigint }[]>`
      SELECT used FROM "org_quota_counters"
       WHERE org_id = ${orgId}::uuid
         AND entitlement = ${entitlement}
         AND window_start = ${start}`;

    const used = rows[0]?.used;

    // No row means nothing has been consumed in this window, which is zero
    // rather than an error: the row is created by the first consume.
    return used === undefined ? 0 : toSafeNumber(used);
  }

  /**
   * Returns the units of reservations nobody settled.
   *
   * Runs on the worker, in a system transaction with no tenant set. It reaches
   * every tenant's rows through a policy that names `worker_user`, not by the
   * table having no policy: as a SYSTEM table these would be unprotected, and
   * `app_user` needs INSERT, SELECT and UPDATE here to consume.
   *
   * `FOR UPDATE SKIP LOCKED` so replicas take disjoint rows, and the state is
   * checked again in the outer statement against a row that may have been
   * settled between the select and the update — a job that finished while the
   * sweep was running, whose units would otherwise be refunded twice.
   *
   * **The refunds are summed per counter before they are applied.** A batch
   * usually holds several reservations for one organization and one
   * entitlement, and PostgreSQL updates a target row at most once per
   * statement: written as a plain join, three expired reservations of one unit
   * each refunded one unit, and the other two were lost with the row marked
   * EXPIRED. A test asked for a batch of two, and that is what found it.
   *
   * Returns how many reservations expired, not how many counters moved — the
   * two differ by exactly the grouping above, and the reservation count is the
   * number that means something to whoever reads the log line.
   */
  async sweepExpired(limit: number): Promise<number> {
    const client = this.system();

    const rows = await client.$queryRaw<{ expired: number }[]>`
      WITH overdue AS MATERIALIZED (
        SELECT id FROM "quota_reservations"
         WHERE state = 'RESERVED' AND expires_at < now()
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED),
      expired AS (
        UPDATE "quota_reservations"
           SET state = 'EXPIRED', closed_at = now()
         WHERE id IN (SELECT id FROM overdue) AND state = 'RESERVED'
        RETURNING org_id, entitlement, window_start, amount),
      owed AS (
        SELECT org_id, entitlement, window_start, sum(amount) AS total
          FROM expired GROUP BY org_id, entitlement, window_start),
      refunded AS (
        UPDATE "org_quota_counters" c
           SET used = c.used - o.total, updated_at = now()
          FROM owed o
         WHERE c.org_id = o.org_id
           AND c.entitlement = o.entitlement
           AND c.window_start = o.window_start
        RETURNING c.org_id)
      SELECT (SELECT count(*) FROM expired)::int AS expired`;

    return rows[0]?.expired ?? 0;
  }

  /**
   * The transaction a request consumes in, and the organization it belongs to.
   *
   * The organization comes from the transaction rather than from the caller
   * for the same reason the outbox reads its tenant there: the caller passing
   * it is the place to get it wrong, and the transaction already knows. The
   * policy would refuse a mismatch anyway — this makes the mismatch
   * impossible to write.
   */
  private tenant(): { orgId: string; client: Prisma.TransactionClient } {
    const active = activeTransaction();

    if (!active || active.context.kind !== 'org') {
      throw new Error(
        'Quota is consumed inside the transaction that does the work it pays for, in an ' +
          'organization context. Wrap the call in withTenantTransaction(context, ...).',
      );
    }

    return { orgId: active.context.orgId, client: active.client };
  }

  /** The worker's transaction, which has no tenant and needs none. */
  private system(): Prisma.TransactionClient {
    const active = activeTransaction();

    if (!active) {
      throw new Error(
        'The quota sweep runs in a transaction. Wrap the call in withSystemTransaction(...).',
      );
    }

    return active.client;
  }
}

/** `bigint` at the boundary, `number` inside, and loud when that is a lie. */
function toSafeNumber(value: bigint): number {
  const used = Number(value);

  if (!Number.isSafeInteger(used)) {
    throw new Error(
      `A quota counter reached ${value}, which JavaScript cannot represent exactly. ` +
        'The column is bigint deliberately; whatever reads it has to be too.',
    );
  }

  return used;
}
