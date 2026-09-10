import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  AuditRepository,
  Database,
  ProcessedEventRepository,
} from '@workspace/core-server-data-access-db';
import type { EnvelopedJob } from '@workspace/core-server-queue';

import type { OutboxDelivery } from './outbox.job.js';

/**
 * The name this consumer claims events under.
 *
 * A constant because it is half of a primary key in `processed_events`.
 * Renaming it does not rename the rows already there, so every event this
 * consumer has ever handled would look unhandled and the whole history would
 * be processed again.
 */
export const AUDIT_CONSUMER = 'audit';

/**
 * Records what happened.
 *
 * The first consumer of the outbox, and until it exists the relay refuses to
 * deliver at all — a queue nobody drains, on a Redis configured never to
 * evict, is a slow way to stop the whole system.
 *
 * It writes the record and its claim on the event in **one system
 * transaction**. Both tables are SYSTEM class: no tenant policy, and
 * unreachable by the API's role. The event's tenant is *data* in the record
 * rather than a scope to read under, which is why this never opens a tenant
 * transaction.
 */
@Injectable()
export class AuditConsumer {
  private readonly logger = new Logger(AuditConsumer.name);
  private readonly db: Database;
  private readonly processed: ProcessedEventRepository;
  private readonly audit: AuditRepository;

  constructor(
    @Inject(Database) db: Database,
    @Inject(ProcessedEventRepository) processed: ProcessedEventRepository,
    @Inject(AuditRepository) audit: AuditRepository,
  ) {
    this.db = db;
    this.processed = processed;
    this.audit = audit;
  }

  /**
   * Handles one delivery.
   *
   * An event type this code has never heard of is recorded anyway, with its
   * payload as it arrived. Refusing what it cannot interpret would lose
   * exactly the events that most need recording — the new ones, during the
   * deploy that introduced them — and an audit trail's job is to record, not
   * to interpret.
   */
  async handle(job: EnvelopedJob<OutboxDelivery>): Promise<void> {
    const { payload, envelope } = job;

    // A job written before the field existed carries no time of its own. The
    // envelope's is the moment the relay enqueued it, which is close but not
    // the same thing, so the record says which one it got rather than leaving
    // the two indistinguishable a year later.
    const inferred = payload.occurredAt === undefined;
    const occurredAt = new Date(payload.occurredAt ?? envelope.requestedAt);

    if (inferred) {
      this.logger.warn(
        `${payload.eventType} (${payload.eventId}) arrived without its own timestamp, so the ` +
          'record carries the moment it was enqueued. Expected only while jobs written before ' +
          'that field drain; if it continues, something is still producing the old shape.',
      );
    }

    await this.db.withSystemTransaction(async () => {
      const first = await this.processed.claim(AUDIT_CONSUMER, payload.eventId);

      if (!first) {
        // A second delivery, which at-least-once makes ordinary: the queue's
        // own deduplication expires, so this is the half that makes it once.
        return;
      }

      const written = await this.audit.record({
        eventId: payload.eventId,
        eventType: payload.eventType,
        aggregateType: payload.aggregateType,
        aggregateId: payload.aggregateId,
        aggregateVersion: payload.aggregateVersion,
        tenantId: envelope.tenantId ?? null,
        actorId: envelope.actorId ?? null,
        occurredAt,
        detail: inferred
          ? { ...asObject(payload.payload), occurredAtInferred: true }
          : payload.payload,
      });

      if (!written) {
        // Claimed the event and found the trail already holding it: the dedup
        // row and the record disagree. Committing anyway is right — the end
        // state is one record and one claim, and rolling back would redeliver
        // forever — but somebody has to be told, because the thing that was
        // supposed to make this impossible did not.
        this.logger.error(
          `The audit trail already held ${payload.eventType} (${payload.eventId}) even though this ` +
            'consumer had not recorded processing it. The record is intact and nothing was ' +
            'duplicated, but the two are out of step and that should not be possible.',
        );
      }
    });
  }
}

/** A payload the consumer can add a field to, whatever shape it arrived in. */
function asObject(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : { payload };
}
