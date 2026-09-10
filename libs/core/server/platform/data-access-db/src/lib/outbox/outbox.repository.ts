import { Injectable } from '@nestjs/common';
import { injectTraceContext } from '@workspace/core-server-observability';

import { Prisma } from '../../generated/prisma/client.js';
import { activeTransaction } from '../transaction/transaction-context.js';

/**
 * The largest a payload may be.
 *
 * A payload is metadata, not content, so this should never be reached. The
 * database carries the same bound as a check constraint; this one exists so
 * the failure names the aggregate and happens where the stack still points at
 * whoever appended it, rather than as a constraint violation from inside a
 * transaction three layers down.
 */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

export type OutboxStatus = 'PENDING' | 'PROCESSING' | 'ENQUEUED' | 'DEAD';

export interface AppendEvent {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion?: number;
  readonly eventType: string;
  readonly payload: unknown;
}

export interface ClaimedEvent {
  readonly eventId: string;
  /** The trace the request that caused it was in, when there was one. */
  readonly traceParent?: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number | null;
  readonly tenantId: string | null;
  readonly actorId: string | null;
  /**
   * When the thing this describes happened.
   *
   * Carried rather than left to the consumer to infer: the only timestamp on a
   * job is the moment the relay enqueued it, which is neither the same moment
   * nor stable — a reclaimed re-enqueue produces a new one for the same event.
   * An audit trail built on that reports the wrong time for everything.
   */
  readonly occurredAt: Date;
  /** The lease clock and the fencing token; one value for a whole batch. */
  readonly lockedAt: Date;
}

export interface KilledEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly tenantId: string | null;
}

/** What `replay` did, and did not do, to the ids it was given. */
export interface ReplayOutcome {
  readonly replayed: string[];
  readonly refused: { eventId: string; reason: string }[];
}

/** What `markFailed` did to each row it was given. */
export interface FailedEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly tenantId: string | null;
  readonly status: OutboxStatus;
}

/** Raw rows come back with the column names, not the model's. */
interface ClaimRow {
  event_id: string;
  event_type: string;
  payload: unknown;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number | null;
  tenant_id: string | null;
  actor_id: string | null;
  occurred_at: Date;
  locked_at: Date;
  trace_parent: string | null;
}

function toClaimed(row: ClaimRow): ClaimedEvent {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    payload: row.payload,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    tenantId: row.tenant_id,
    actorId: row.actor_id,
    occurredAt: row.occurred_at,
    lockedAt: row.locked_at,
    ...(row.trace_parent === null ? {} : { traceParent: row.trace_parent }),
  };
}

/**
 * The outbox.
 *
 * Everything here is raw SQL, and that is not a style choice. `app_user` is
 * granted `INSERT` and nothing else — the point of the grant — and
 * `INSERT ... RETURNING` needs `SELECT` on the columns it returns, which
 * Prisma's `create()` always emits. Measured: `create()` fails with
 * `permission denied` inside the caller's transaction, so the business write
 * rolls back on the first request in any environment where the grants are
 * real, and never in a test that runs as the owner.
 *
 * The claim and the reclaim need `FOR UPDATE SKIP LOCKED`, which has no Prisma
 * Client API at all.
 *
 * Every bounded statement here is a **materialised CTE**, not
 * `IN (SELECT ... LIMIT n)`. Measured on PostgreSQL 18: written inline, the
 * planner produced a `Nested Loop Semi Join` and re-executed the subquery once
 * per candidate row — and each re-execution returned the *next* rows, because
 * the ones already updated no longer matched its predicate. A statement asked
 * for two rows took all five, and on a real table it would take everything
 * pending, which is the unbounded claim this whole design exists to avoid.
 * `WITH ... AS MATERIALIZED` is an optimisation fence: it runs once, and the
 * `LIMIT` means what it says.
 *
 * Because the statements are raw, they reach the transaction client directly
 * rather than through `Database.tenant()` or `Database.system()` — neither of
 * which accepts the other's context, and `append()` has to work inside both.
 * `guardTenantModels` guards property access and explicitly not SQL, so
 * nothing is bypassed and nothing is added to `Database`'s public surface.
 */
@Injectable()
export class OutboxRepository {
  /**
   * Records that something happened, in the transaction that made it happen.
   *
   * This is the whole guarantee: the event and the aggregate commit together
   * or neither does, so there is no "did the event get sent" failure mode.
   * It therefore **refuses to open a transaction of its own**, which is the
   * opposite of what every other repository here does — one that opened its
   * own would commit the event separately from the aggregate, which is exactly
   * the failure the outbox exists to remove.
   */
  async append(event: AppendEvent): Promise<void> {
    const active = activeTransaction();

    if (!active) {
      throw new Error(
        'append() must run inside the transaction that writes the aggregate — that is the whole ' +
          'guarantee. Wrap the call in withTenantTransaction(context, ...) or withSystemTransaction(...).',
      );
    }

    if (active.context.kind === 'user') {
      // A user context knows who but not which organization, so the event
      // would land with a null tenant — indistinguishable from one the system
      // raised for itself. A consumer reading that opens a system transaction
      // and handles a tenant's event with no tenant scoping.
      throw new Error(
        'append() cannot record an event from a transaction that knows a user but no organization: ' +
          'the event would be indistinguishable from one the system raised for itself. Open the ' +
          'transaction with an organization, or decide deliberately that this event has no tenant.',
      );
    }

    const serialised = JSON.stringify(event.payload ?? null);

    if (Buffer.byteLength(serialised, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new Error(
        `The payload for ${event.eventType} on ${event.aggregateType} ${event.aggregateId} is ` +
          `${Buffer.byteLength(serialised, 'utf8')} bytes, over the ${MAX_PAYLOAD_BYTES} an event may carry. ` +
          'A payload is metadata — a consumer that needs the record reads the aggregate.',
      );
    }

    const tenantId =
      active.context.kind === 'org' ? active.context.orgId : null;
    const actorId =
      active.context.kind === 'org' ? active.context.userId : null;

    // No RETURNING: app_user has INSERT and not SELECT, deliberately.
    await active.client.$executeRaw`
      INSERT INTO "outbox_events"
        (aggregate_type, aggregate_id, aggregate_version, event_type, payload,
         tenant_id, actor_id, trace_parent)
      VALUES (${event.aggregateType}, ${event.aggregateId}::uuid,
              ${event.aggregateVersion ?? null}, ${event.eventType},
              ${serialised}::jsonb,
              ${tenantId}::uuid, ${actorId}::uuid,
              -- The trace the request is in, so the relay can pick it up in a
              -- different process minutes later and still be part of the same
              -- picture. Null when nothing is tracing, or when a schedule
              -- caused the event and there is no request behind it.
              ${injectTraceContext()['traceparent'] ?? null})`;
  }

  /**
   * How many events are in each state, for the scrape.
   *
   * A system transaction and no tenant: this is the whole table's shape, and
   * an operator asking "has delivery stopped" is not asking about one
   * organization. The numbers carry no tenant, so nothing here can leak one.
   *
   * States with no rows are absent rather than zero. The caller sets the
   * gauges it knows about, so a state that emptied reads as zero rather than
   * disappearing from the dashboard.
   */
  async countByState(): Promise<Record<string, number>> {
    // A view, not the table. `app_user` deliberately cannot read
    // `outbox_events` — measured: `permission denied for table outbox_events`
    // — and the view exposes the aggregate with none of the rows behind it.
    const rows = await this.client().$queryRaw<
      { status: string; count: bigint }[]
    >`SELECT status, count FROM "outbox_state_counts"`;

    return Object.fromEntries(
      rows.map((row) => [row.status, Number(row.count)]),
    );
  }

  /**
   * Takes a batch of events that are due.
   *
   * `SKIP LOCKED` so replicas take disjoint rows instead of one waiting on
   * another's locks and then finding nothing left. Ordered, unlike the
   * retention sweep, because the index carries the ordering — and because an
   * unordered scan returns rows in physical order, which lets a row that keeps
   * failing be passed over forever while lower blocks keep supplying a batch.
   *
   * `event_id` is the tiebreak: `now()` is transaction-stable, so two events
   * appended in one business transaction share an `available_at` exactly.
   */
  async claimPending(
    limit: number,
    maxAttempts: number,
  ): Promise<ClaimedEvent[]> {
    const rows = await this.client().$queryRaw<ClaimRow[]>`
      WITH claimed AS MATERIALIZED (
        SELECT event_id FROM "outbox_events"
         WHERE status = 'PENDING' AND available_at <= now() AND attempts < ${maxAttempts}
         ORDER BY available_at, event_id
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED)
      UPDATE "outbox_events"
         SET status = 'PROCESSING', locked_at = now(), attempts = attempts + 1
       WHERE event_id IN (SELECT event_id FROM claimed)
         AND status = 'PENDING' AND attempts < ${maxAttempts}
      RETURNING event_id, event_type, payload, aggregate_type, aggregate_id,
                aggregate_version, tenant_id, actor_id, occurred_at, locked_at,
                trace_parent`;

    return rows.map(toClaimed);
  }

  /**
   * Takes back events whose relay died holding them.
   *
   * A recovery path, not the retry mechanism — a relay that is alive returns
   * its own failures to `PENDING` with a backoff. This is for the one case
   * that cannot: a process that stopped between the claim and anything else.
   *
   * It returns the same columns the claim does, `trace_parent` among them.
   * Left out of this list it read as `undefined` rather than `null`, so the
   * relay saw no parent and re-enqueued the job hanging off its own pass
   * instead of the request that caused the event — silently, and precisely
   * when somebody is following a trace to find out why a delivery was late.
   */
  async reclaimStale(
    limit: number,
    leaseMs: number,
    maxAttempts: number,
  ): Promise<ClaimedEvent[]> {
    const rows = await this.client().$queryRaw<ClaimRow[]>`
      WITH stale AS MATERIALIZED (
        SELECT event_id FROM "outbox_events"
         WHERE status = 'PROCESSING'
           AND locked_at < now() - ${`${leaseMs} milliseconds`}::interval
           AND attempts < ${maxAttempts}
         ORDER BY locked_at, event_id
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED)
      UPDATE "outbox_events"
         SET locked_at = now(), attempts = attempts + 1
       WHERE event_id IN (SELECT event_id FROM stale)
         AND status = 'PROCESSING' AND attempts < ${maxAttempts}
      RETURNING event_id, event_type, payload, aggregate_type, aggregate_id,
                aggregate_version, tenant_id, actor_id, occurred_at, locked_at,
                trace_parent`;

    return rows.map(toClaimed);
  }

  /**
   * Gives up on events whose relay died and whose attempts are spent.
   *
   * Runs before the reclaim in the same tick, so exhausted rows stop being a
   * filtered prefix the reclaim has to scan past. A `LIMIT` and `SKIP LOCKED`
   * like every other statement here: unbounded, two replicas running it after
   * a long outage block on each other for as long as the table is large.
   */
  async killExhausted(
    limit: number,
    leaseMs: number,
    maxAttempts: number,
  ): Promise<KilledEvent[]> {
    return this.client().$queryRaw<KilledEvent[]>`
      WITH exhausted AS MATERIALIZED (
        SELECT event_id FROM "outbox_events"
         WHERE status = 'PROCESSING'
           AND attempts >= ${maxAttempts}
           AND locked_at < now() - ${`${leaseMs} milliseconds`}::interval
         ORDER BY locked_at, event_id
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED)
      UPDATE "outbox_events"
         SET status = 'DEAD',
             last_error = coalesce(last_error, 'attempt ceiling reached')
       WHERE event_id IN (SELECT event_id FROM exhausted)
         AND status = 'PROCESSING' AND attempts >= ${maxAttempts}
      RETURNING event_id AS "eventId", event_type AS "eventType", tenant_id AS "tenantId"`;
  }

  /**
   * Records that a batch reached the queue.
   *
   * Fenced on `locked_at`: a relay whose lease expired must not write over the
   * work of the one that took its rows. Fewer rows back than were delivered
   * means a reclaim took them mid-enqueue — harmless, because the other relay
   * delivers them again and the consumer's dedup absorbs it, but the caller
   * says so rather than swallowing it.
   *
   * `enqueued_at` is written here and nowhere else, which is what lets the
   * sweep and its index trust the column.
   */
  async markEnqueued(eventIds: string[], claimedAt: Date): Promise<string[]> {
    if (eventIds.length === 0) {
      return [];
    }

    const rows = await this.client().$queryRaw<{ event_id: string }[]>`
      UPDATE "outbox_events" SET status = 'ENQUEUED', enqueued_at = now()
       WHERE event_id = ANY(${eventIds}::uuid[])
         AND status = 'PROCESSING' AND locked_at = ${claimedAt}
      RETURNING event_id`;

    return rows.map((row) => row.event_id);
  }

  /**
   * Returns a batch that could not be delivered, or gives up on it.
   *
   * The `CASE` is the part that matters. Leaving an exhausted row at `PENDING`
   * strands it: the claim's `attempts < max` excludes it, the ceiling
   * transition only looks at `PROCESSING`, and the sweep only at `ENQUEUED` —
   * so it sits at the head of the claim's own ordering forever, filtered out
   * on every tick, while nothing ever reports that the work did not happen.
   */
  async markFailed(
    eventIds: string[],
    claimedAt: Date,
    error: string,
    maxAttempts: number,
  ): Promise<FailedEvent[]> {
    if (eventIds.length === 0) {
      return [];
    }

    return this.client().$queryRaw<FailedEvent[]>`
      UPDATE "outbox_events"
         SET status = CASE WHEN attempts >= ${maxAttempts} THEN 'DEAD' ELSE 'PENDING' END,
             locked_at = NULL,
             last_error = ${error},
             available_at = CASE WHEN attempts >= ${maxAttempts} THEN available_at
                            ELSE now() + (least(2 ^ least(attempts, 10), 300) || ' seconds')::interval
                            END
       WHERE event_id = ANY(${eventIds}::uuid[])
         AND status = 'PROCESSING' AND locked_at = ${claimedAt}
      RETURNING event_id AS "eventId", event_type AS "eventType",
                tenant_id AS "tenantId", status`;
  }

  /**
   * Removes delivered events past the retention window.
   *
   * `DEAD` rows are deliberately not swept: a dead event is evidence, and
   * disposing of one is a decision somebody makes.
   */
  async sweepEnqueued(olderThanHours: number, limit: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1_000);

    return this.client().$executeRaw`
      WITH delivered AS MATERIALIZED (
        SELECT event_id FROM "outbox_events"
         WHERE status = 'ENQUEUED' AND enqueued_at < ${cutoff}
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED)
      DELETE FROM "outbox_events"
       WHERE event_id IN (SELECT event_id FROM delivered)
         AND status = 'ENQUEUED' AND enqueued_at < ${cutoff}`;
  }

  /**
   * Puts events back in the queue's path.
   *
   * Resetting `attempts` is the part a hand-typed `UPDATE` forgets: a `DEAD`
   * row is at the ceiling by construction, so changing only the status leaves
   * it where the claim excludes it — never delivered, and the operator sees
   * the status change and believes it worked.
   *
   * The window is checked on `occurred_at`, not `enqueued_at`: a row that died
   * on the ceiling never enqueued successfully, so a guard on `enqueued_at`
   * refuses every row this method exists to rescue, silently.
   */
  async replay(
    eventIds: string[],
    retentionHours: number,
  ): Promise<ReplayOutcome> {
    if (eventIds.length === 0) {
      return { replayed: [], refused: [] };
    }

    const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1_000);

    const rows = await this.client().$queryRaw<{ event_id: string }[]>`
      UPDATE "outbox_events"
         SET status = 'PENDING', attempts = 0, locked_at = NULL,
             available_at = now(), last_error = NULL
       WHERE event_id = ANY(${eventIds}::uuid[])
         AND status <> 'PENDING'
         AND occurred_at > ${cutoff}
      RETURNING event_id`;

    const replayed = rows.map((row) => row.event_id);
    const took = new Set(replayed);

    // What it would not touch, and why. Reporting only successes is how an
    // operator working from the queue's failed set — which keeps a job for a
    // fortnight, twice as long as an event stays replayable — reads the ids,
    // calls this, and is told nothing at all.
    return {
      replayed,
      refused: eventIds
        .filter((eventId) => !took.has(eventId))
        .map((eventId) => ({
          eventId,
          reason:
            'It is gone, already pending, or older than the replay window — ' +
            `events stay replayable for ${retentionHours} hours, and the queue keeps a failed job longer than that.`,
        })),
    };
  }

  /**
   * The transaction the caller opened.
   *
   * Every method but `append` runs in the relay's own system transaction, and
   * `append` runs in the business one; both reach it the same way, and both
   * fail the same way when there is none.
   */
  private client(): Prisma.TransactionClient {
    const active = activeTransaction();

    if (!active) {
      throw new Error(
        'The outbox is reached inside a transaction. Wrap the call in withSystemTransaction(...).',
      );
    }

    return active.client;
  }
}
