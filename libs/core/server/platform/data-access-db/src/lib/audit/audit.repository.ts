import { Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client.js';
import { activeTransaction } from '../transaction/transaction-context.js';

export interface AuditEntry {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number | null;
  readonly tenantId: string | null;
  readonly actorId: string | null;
  readonly occurredAt: Date;
  /** The event's payload, plus whatever the consumer knows about the delivery. */
  readonly detail: unknown;
}

/**
 * What happened, kept.
 *
 * Raw SQL, for the same two reasons the outbox uses it. `create()` has no
 * `ON CONFLICT` API at all, and it always emits `RETURNING`, which needs
 * `SELECT` on the returned columns — a distinction that cost this workspace a
 * bug once already, in a grant that looked satisfied because the test ran as
 * the owner.
 *
 * The signature carries no Prisma type on purpose. `type:app` bans `@prisma/*`,
 * so a `Prisma.InputJsonValue` here would fail lint in the worker that calls
 * it, and the natural way to make that error go away is to widen the boundary.
 *
 * It refuses to open a transaction of its own, like the outbox and the dedup
 * repositories: the record and the consumer's claim on the event have to commit
 * together, or a crash between them leaves the trail disagreeing with itself.
 */
@Injectable()
export class AuditRepository {
  /**
   * Writes a record, unless the trail already holds this event.
   *
   * Returns whether it wrote one. `ON CONFLICT DO NOTHING` rather than a bare
   * insert because the unique index is a backstop, not a control flow: the
   * dedup row is what should have prevented a second delivery, and the day it
   * did not, an exception thrown from inside a queue handler would be retried
   * five times and dead-lettered rather than reported.
   *
   * The caller decides what a `false` means. When it claimed the event and
   * then found the record already there, the two are out of step and it says
   * so at error level — which is the alarm this constraint exists to raise.
   */
  async record(entry: AuditEntry): Promise<boolean> {
    const written = await this.client().$executeRaw`
      INSERT INTO "audit_records"
        (event_id, event_type, aggregate_type, aggregate_id, aggregate_version,
         tenant_id, actor_id, occurred_at, detail)
      VALUES (${entry.eventId}::uuid, ${entry.eventType}, ${entry.aggregateType},
              ${entry.aggregateId}::uuid, ${entry.aggregateVersion},
              ${entry.tenantId}::uuid, ${entry.actorId}::uuid,
              ${entry.occurredAt}, ${JSON.stringify(entry.detail ?? null)}::jsonb)
      ON CONFLICT (event_id) DO NOTHING`;

    return written > 0;
  }

  private client(): Prisma.TransactionClient {
    const active = activeTransaction();

    if (!active) {
      throw new Error(
        'An audit record is written inside the transaction that also records the event as ' +
          'processed — the two have to commit together. Wrap the call in withSystemTransaction(...).',
      );
    }

    return active.client;
  }
}
