import { Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client.js';
import { activeTransaction } from '../transaction/transaction-context.js';

/**
 * What a consumer has already done.
 *
 * This is the exactly-once guarantee. The queue's job-id deduplication is not:
 * measured, it stops applying once the completed job has been cleaned up,
 * which is an hour or a thousand completed jobs on that queue, whichever comes
 * first.
 *
 * It is correct only for a consumer whose whole effect is a write to this
 * database, because the row and the effect have to commit together. One that
 * sends an email or calls a webhook cannot do that and gets at-least-once with
 * no deduplication — a different problem, needing a different answer.
 *
 * Raw SQL for the same reason the outbox uses it: `ON CONFLICT DO NOTHING` has
 * no Prisma Client API that reports whether the row was new, and that answer
 * is the entire point of the call.
 */
@Injectable()
export class ProcessedEventRepository {
  /**
   * Claims an event for a consumer, inside that consumer's own transaction.
   *
   * Returns whether this is the first time. A second delivery gets `false` and
   * the handler does nothing — which is why the insert must be in the same
   * transaction as the work, not before it or after it.
   */
  async claim(consumer: string, eventId: string): Promise<boolean> {
    const inserted = await this.client().$executeRaw`
      INSERT INTO "processed_events" (consumer, event_id)
      VALUES (${consumer}, ${eventId}::uuid)
      ON CONFLICT (consumer, event_id) DO NOTHING`;

    return inserted > 0;
  }

  /**
   * Removes dedup rows past their retention window.
   *
   * That window is deliberately longer than the outbox's own: a dedup row has
   * to outlive the event it dedups, or an event replayed at the edge of its
   * window is processed a second time.
   *
   * `FOR UPDATE SKIP LOCKED`, and it took a column-level grant to get it.
   * Locking a row for update needs the UPDATE privilege, which `DELETE` does
   * not imply — measured on PostgreSQL 18 — so `worker_user` holds
   * `UPDATE (processed_at)` here and nothing wider. Table-level would also
   * allow `SET event_id`, which forges a dedup row for an event nobody
   * processed: the consumer then finds a claim, does nothing, and the event
   * disappears from the audit trail with no error anywhere.
   *
   * This statement ran without the lock hint while it lived on the hourly
   * retention job, where one replica swept per tick. It runs on the relay now,
   * on every replica, and unlocked they contend for the same rows: measured,
   * three concurrent sweepers removed exactly what one removes, because the
   * two that lose see an empty batch and stop for the whole tick.
   */
  async sweep(olderThanHours: number, limit: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1_000);

    return this.client().$executeRaw`
      WITH stale AS MATERIALIZED (
        SELECT consumer, event_id FROM "processed_events"
         WHERE processed_at < ${cutoff}
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED)
      DELETE FROM "processed_events"
       WHERE (consumer, event_id) IN (SELECT consumer, event_id FROM stale)
         AND processed_at < ${cutoff}`;
  }

  private client(): Prisma.TransactionClient {
    const active = activeTransaction();

    if (!active) {
      throw new Error(
        'A processed-event row is written inside the transaction that does the work it records. ' +
          'Wrap the call in withTenantTransaction(context, ...) or withSystemTransaction(...).',
      );
    }

    return active.client;
  }
}
