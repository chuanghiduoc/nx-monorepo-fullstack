import { Inject, Injectable, Logger } from '@nestjs/common';

import { WorkerConfig } from '@workspace/core-server-core';
import { Database, WebhookRepository } from '@workspace/core-server-data-access-db';
import type { EnvelopedJob } from '@workspace/core-server-queue';
import {
  deliver,
  pinDestination,
  UnsafeDestinationError,
} from '@workspace/core-server-webhooks';

import type { WebhookDeliveryJob } from './webhook.job.js';

/** Statuses that mean "ask again later" rather than "you are wrong". */
const RETRYABLE_CLIENT_STATUSES = new Set([408, 425, 429]);

/**
 * Sends one delivery to one endpoint, and records what happened.
 *
 * **The endpoint is read now, not taken from the job.** A delivery job can sit
 * on the queue for as long as its retries take, and an endpoint deleted,
 * disabled or repointed in the meantime must not be delivered to from a copy
 * the queue kept — the secret above all, because a rotated one would keep
 * signing with the old key for a fortnight.
 *
 * **The address is validated on every attempt**, not once when the endpoint
 * was created. The address a name resolves to is not a property of the string,
 * and the gap between creation and delivery is exactly where a rebinding
 * attack lives.
 */
@Injectable()
export class WebhookSender {
  private readonly logger = new Logger(WebhookSender.name);
  private readonly db: Database;
  private readonly webhooks: WebhookRepository;
  private readonly config: WorkerConfig;

  constructor(
    @Inject(Database) db: Database,
    @Inject(WebhookRepository) webhooks: WebhookRepository,
    @Inject(WorkerConfig) config: WorkerConfig,
  ) {
    this.db = db;
    this.webhooks = webhooks;
    this.config = config;
  }

  async handle(job: EnvelopedJob<WebhookDeliveryJob>): Promise<void> {
    const { payload, envelope } = job;

    const [target] = await this.db.withSystemTransaction(() =>
      this.webhooks.targetsFor(payload.orgId, payload.eventType),
    ).then((targets) =>
      targets.filter((candidate) => candidate.id === payload.endpointId),
    );

    if (target === undefined) {
      // Deleted, disabled, or its filter no longer wants this type. Not a
      // failure: the endpoint's owner changed their mind, which is allowed,
      // and retrying would deliver something they switched off.
      this.logger.log(
        `Endpoint ${payload.endpointId} no longer wants ${payload.eventType}; dropping the delivery.`,
      );
      return;
    }

    const requireHttps = this.config.get('NODE_ENV') === 'production';

    let destination;
    try {
      destination = await pinDestination(target.url, { requireHttps });
    } catch (failure) {
      if (failure instanceof UnsafeDestinationError) {
        await this.record(payload, envelope.attempt, {
          status: null,
          error: failure.message,
          durationMs: 0,
        });

        // Fatal: the address will be just as private in thirty seconds, and
        // eight identical refusals only delay the dead letter somebody has to
        // read. `fatal` is what `classifyFailure` looks for.
        throw Object.assign(failure, { fatal: true });
      }
      throw failure;
    }

    const outcome = await deliver(destination, {
      secret: target.secret,
      eventId: payload.eventId,
      body: payload.body,
      timeoutMs: this.config.get('WEBHOOK_TIMEOUT_MS'),
    });

    await this.record(payload, envelope.attempt, {
      status: outcome.status ?? null,
      error: outcome.error ?? null,
      durationMs: outcome.durationMs,
    });

    this.assertDelivered(payload, outcome.status, outcome.error);
  }

  /**
   * Turns a response into a success, a retry or a dead letter.
   *
   * A 4xx is the receiver saying the request is wrong, and it will say so
   * again — except for the three that mean "later": 408 and 425 are timing,
   * and 429 is the receiver asking for exactly what the backoff already does.
   */
  private assertDelivered(
    payload: WebhookDeliveryJob,
    status: number | undefined,
    error: string | undefined,
  ): void {
    if (status !== undefined && status >= 200 && status < 300) {
      return;
    }

    const describe =
      status === undefined
        ? `did not answer (${error ?? 'no reason given'})`
        : `answered ${status}`;

    const failure = new Error(
      `The endpoint for ${payload.eventType} (${payload.eventId}) ${describe}.`,
    );

    if (
      status !== undefined &&
      status >= 400 &&
      status < 500 &&
      !RETRYABLE_CLIENT_STATUSES.has(status)
    ) {
      throw Object.assign(failure, { fatal: true });
    }

    // Everything else — 5xx, a timeout, a refused connection, a 429 — is worth
    // asking again. `retryable` is what the queue's classification reads.
    throw Object.assign(failure, { retryable: true });
  }

  private async record(
    payload: WebhookDeliveryJob,
    attempt: number,
    outcome: { status: number | null; error: string | null; durationMs: number },
  ): Promise<void> {
    await this.db.withSystemTransaction(() =>
      this.webhooks.recordAttempt({
        orgId: payload.orgId,
        endpointId: payload.endpointId,
        eventId: payload.eventId,
        eventType: payload.eventType,
        attempt,
        ...outcome,
      }),
    );
  }
}
