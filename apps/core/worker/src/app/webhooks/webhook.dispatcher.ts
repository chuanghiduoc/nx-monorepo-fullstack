import { Inject, Injectable, Logger } from '@nestjs/common';

import { Database, WebhookRepository } from '@workspace/core-server-data-access-db';
import { QueueService, type EnvelopedJob } from '@workspace/core-server-queue';

import type { OutboxDelivery } from '../outbox/outbox.job.js';
import { webhookDelivery } from './webhook.job.js';

/**
 * Turns one event into one delivery per endpoint that wants it.
 *
 * It is deliberately the *only* thing this consumer does. Sending is slow and
 * frequently fails; fanning out is a read and some enqueues. Doing both here
 * would mean a receiver that times out for an hour delays the fan-out of every
 * other event on the queue.
 *
 * **It does not claim the event in `processed_events`.** That table is the
 * exactly-once guarantee for a consumer whose whole effect is a write to this
 * database, and this consumer's effect is jobs on a queue. Claiming would be
 * worse than useless: the claim would commit and the enqueues would not be
 * part of that transaction, so a crash between them would leave an event
 * marked handled and never dispatched.
 *
 * A repeat therefore fans out again, and the duplicate is absorbed by the
 * delivery queue's own `jobId` — and, past that window, by the receiver, which
 * the contract tells to deduplicate on `X-Webhook-Event-Id`.
 */
@Injectable()
export class WebhookDispatcher {
  private readonly logger = new Logger(WebhookDispatcher.name);
  private readonly db: Database;
  private readonly webhooks: WebhookRepository;
  private readonly queue: QueueService;

  constructor(
    @Inject(Database) db: Database,
    @Inject(WebhookRepository) webhooks: WebhookRepository,
    @Inject(QueueService) queue: QueueService,
  ) {
    this.db = db;
    this.webhooks = webhooks;
    this.queue = queue;
  }

  async handle(job: EnvelopedJob<OutboxDelivery>): Promise<void> {
    const { payload, envelope } = job;
    const orgId = envelope.tenantId;

    if (orgId === undefined) {
      // A system event belongs to no tenant, and a webhook endpoint belongs to
      // exactly one. There is nobody to send it to, and that is not a failure.
      return;
    }

    const targets = await this.db.withSystemTransaction(() =>
      this.webhooks.targetsFor(orgId, payload.eventType),
    );

    if (targets.length === 0) {
      return;
    }

    // Serialised once, here, so every attempt at every endpoint signs the same
    // bytes. Re-serialising per attempt would produce a different signature
    // for the same event whenever key order changed, and a receiver comparing
    // two deliveries would see two different bodies.
    const body = JSON.stringify({
      eventId: payload.eventId,
      eventType: payload.eventType,
      aggregateType: payload.aggregateType,
      aggregateId: payload.aggregateId,
      aggregateVersion: payload.aggregateVersion,
      occurredAt: payload.occurredAt ?? envelope.requestedAt,
      data: payload.payload,
    });

    const outcomes = await Promise.allSettled(
      targets.map((target) =>
        this.queue.enqueue(
          webhookDelivery,
          {
            endpointId: target.id,
            orgId: target.orgId,
            eventId: payload.eventId,
            eventType: payload.eventType,
            body,
          },
          {
            tenantId: target.orgId,
            ...(envelope.actorId === undefined
              ? {}
              : { actorId: envelope.actorId }),
          },
          // One job per endpoint per event: the same event dispatched twice
          // is a no-op while the first delivery's job is still known.
          //
          // A hyphen, not a colon. BullMQ refuses a custom id containing one —
          // it is the separator in its own Redis keys — and the refusal
          // arrives as a rejected `add`, which this method reports as "could
          // not enqueue" without saying why. Measured: every dispatch failed
          // five times and dead-lettered.
          { jobId: `${payload.eventId}-${target.id}` },
        ),
      ),
    );

    const failed = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === 'rejected',
    );

    if (failed.length > 0) {
      // Throwing retries the whole fan-out, which re-enqueues the endpoints
      // that did accept — absorbed by their job ids, and by the receiver past
      // that. Losing the ones that did not is the alternative.
      // The reason, not just the count. Without it the dead letter says only
      // that something did not work — which is what this message did say, for
      // five attempts, while the actual cause was a character in a job id.
      const reason =
        failed[0]?.reason instanceof Error
          ? failed[0].reason.message
          : String(failed[0]?.reason);

      throw new Error(
        `Could not enqueue ${failed.length} of ${targets.length} webhook deliveries for ` +
          `${payload.eventType} (${payload.eventId}): ${reason}`,
      );
    }

    this.logger.debug(
      `Dispatched ${payload.eventType} (${payload.eventId}) to ${targets.length} endpoint(s).`,
    );
  }
}
