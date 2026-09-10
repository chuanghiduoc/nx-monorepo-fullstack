import { Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client.js';
import { activeTransaction } from '../transaction/transaction-context.js';

/** An endpoint as a request may see it: everything except the secret. */
export interface WebhookEndpointView {
  readonly id: string;
  readonly url: string;
  readonly eventTypes: string[];
  readonly enabled: boolean;
  readonly createdAt: Date;
}

/** An endpoint as the dispatcher needs it, which includes the secret. */
export interface WebhookTarget {
  readonly id: string;
  readonly orgId: string;
  readonly url: string;
  readonly secret: string;
}

export interface CreateEndpoint {
  readonly url: string;
  readonly secret: string;
  readonly eventTypes: string[];
}

export interface AttemptRecord {
  readonly orgId: string;
  readonly endpointId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly attempt: number;
  readonly status: number | null;
  readonly error: string | null;
  readonly durationMs: number;
}

/** Nothing a receiver said is worth more of the log than this. */
const MAX_ERROR = 512;

/**
 * Webhook endpoints and what happened when they were called.
 *
 * **Every statement names its columns**, and that is not a style choice.
 * `app_user` holds a column-level `SELECT` that excludes `secret`, so Prisma's
 * `findMany` — which emits `SELECT` for every column of the model — fails with
 * `permission denied for column secret`, in production and never in a test
 * that runs as the owner. It is the same trap `RETURNING` set for the outbox.
 */
@Injectable()
export class WebhookRepository {
  /**
   * Creates an endpoint and returns its id.
   *
   * The secret is written and never read back by this role: the caller
   * generated it and returns it in that single response. `RETURNING id` is
   * safe because `app_user` may select `id`.
   */
  async create(orgId: string, endpoint: CreateEndpoint): Promise<string> {
    const rows = await this.client().$queryRaw<{ id: string }[]>`
      INSERT INTO "webhook_endpoints" (org_id, url, secret, event_types)
      VALUES (${orgId}::uuid, ${endpoint.url}, ${endpoint.secret},
              ${endpoint.eventTypes}::text[])
      RETURNING id`;

    const id = rows[0]?.id;

    if (id === undefined) {
      // The policy's `WITH CHECK` refused the row, which means the transaction
      // is acting for a different organization than the one being written to.
      throw new Error(
        'The webhook endpoint was not created: the transaction’s organization does not match.',
      );
    }

    return id;
  }

  /** This organization's endpoints, as a request may see them. */
  async list(orgId: string): Promise<WebhookEndpointView[]> {
    return this.client().$queryRaw<WebhookEndpointView[]>`
      SELECT id, url, event_types AS "eventTypes", enabled, created_at AS "createdAt"
        FROM "webhook_endpoints"
       WHERE org_id = ${orgId}::uuid
       ORDER BY created_at DESC`;
  }

  /** Turns one on or off, or points it somewhere else. Not its secret. */
  async update(
    orgId: string,
    id: string,
    changes: { url?: string; eventTypes?: string[]; enabled?: boolean },
  ): Promise<boolean> {
    const changed = await this.client().$executeRaw`
      UPDATE "webhook_endpoints"
         SET url = COALESCE(${changes.url ?? null}, url),
             event_types = COALESCE(${changes.eventTypes ?? null}::text[], event_types),
             enabled = COALESCE(${changes.enabled ?? null}::boolean, enabled),
             updated_at = now()
       WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid`;

    return changed > 0;
  }

  async remove(orgId: string, id: string): Promise<boolean> {
    const removed = await this.client().$executeRaw`
      DELETE FROM "webhook_endpoints"
       WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid`;

    return removed > 0;
  }

  /**
   * The endpoints one event should be sent to.
   *
   * Read by the dispatcher, in a system transaction, through the policy that
   * names `worker_user` — so `org_id` is in the predicate rather than left to
   * the policy, for the same reason the flag override read names it: under
   * that policy the row set is every tenant's.
   *
   * An empty `event_types` means every type, which is the useful default for a
   * first endpoint and the wrong one for a busy integration. The filter is in
   * SQL rather than in the dispatcher so an organization with a hundred
   * endpoints does not send a hundred rows over the wire to discard ninety.
   */
  async targetsFor(orgId: string, eventType: string): Promise<WebhookTarget[]> {
    return this.client().$queryRaw<WebhookTarget[]>`
      SELECT id, org_id AS "orgId", url, secret
        FROM "webhook_endpoints"
       WHERE org_id = ${orgId}::uuid
         AND enabled
         AND (cardinality(event_types) = 0 OR ${eventType} = ANY(event_types))
       ORDER BY created_at`;
  }

  /**
   * Records one attempt.
   *
   * One row per attempt, not per delivery: the question somebody asks is "why
   * did this not arrive", and the answer is the sequence — 503, 503, timeout —
   * which a row per delivery overwrites with its own last line.
   */
  async recordAttempt(attempt: AttemptRecord): Promise<void> {
    await this.client().$executeRaw`
      INSERT INTO "webhook_deliveries"
        (org_id, endpoint_id, event_id, event_type, attempt, status, error, duration_ms)
      VALUES (${attempt.orgId}::uuid, ${attempt.endpointId}::uuid,
              ${attempt.eventId}::uuid, ${attempt.eventType}, ${attempt.attempt},
              ${attempt.status}, ${attempt.error?.slice(0, MAX_ERROR) ?? null},
              ${attempt.durationMs})`;
  }

  /**
   * Removes delivery rows past their window.
   *
   * **No `FOR UPDATE SKIP LOCKED`, deliberately.** The lock hint needs the
   * UPDATE privilege — measured on PostgreSQL 18, `DELETE` does not imply it —
   * and `worker_user` has no UPDATE here because nothing ever edits an attempt
   * record. It does not need the hint either: this runs on the hourly
   * retention job, which is a scheduled job and therefore one replica per
   * tick, unlike the dedup sweep that moved onto the relay and had to pay for
   * a column-level grant.
   *
   * The materialised CTE stays. Written as `IN (SELECT ... LIMIT n)` the
   * planner re-executes the subquery per candidate row and the limit bounds
   * nothing — measured, and the reason every bounded statement here has this
   * shape.
   */
  async sweepDeliveries(olderThanHours: number, limit: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1_000);

    return this.client().$executeRaw`
      WITH stale AS MATERIALIZED (
        SELECT id FROM "webhook_deliveries"
         WHERE created_at < ${cutoff}
         LIMIT ${limit})
      DELETE FROM "webhook_deliveries"
       WHERE id IN (SELECT id FROM stale)
         AND created_at < ${cutoff}`;
  }

  /**
   * Delivery attempts in a recent window, grouped by what happened.
   *
   * The window is the view's — an hour — and it is a window rather than the
   * whole table because that table records every attempt ever made: "how many
   * have ever failed" only goes up and answers nothing. "How many failed in the
   * last hour" is the question somebody asks at three in the morning.
   *
   * `delivered` is a 2xx, `refused` is anything else the endpoint said, and
   * `unreachable` is nothing answering at all — which is a different failure
   * and a different fix.
   */
  async countRecentDeliveries(): Promise<Record<string, number>> {
    // A view, and the window is in it: a view cannot take a parameter, and the
    // table itself is behind row-level security that a system transaction with
    // no tenant reads as empty — which is worse than a refusal, because a gauge
    // that reads zero looks exactly like one with nothing to report.
    const rows = await this.client().$queryRaw<
      { outcome: string; count: bigint }[]
    >`SELECT outcome, count FROM "webhook_delivery_outcomes"`;

    return Object.fromEntries(rows.map((row) => [row.outcome, Number(row.count)]));
  }

  private client(): Prisma.TransactionClient {
    const active = activeTransaction();

    if (!active) {
      throw new Error(
        'A webhook endpoint is read or written inside a transaction — a tenant one for a ' +
          'request, a system one for the dispatcher. Wrap the call in ' +
          'withTenantTransaction(context, ...) or withSystemTransaction(...).',
      );
    }

    return active.client;
  }
}
