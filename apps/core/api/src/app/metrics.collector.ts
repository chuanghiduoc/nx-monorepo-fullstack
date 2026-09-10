import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  Database,
  OutboxRepository,
  WebhookRepository,
} from '@workspace/core-server-data-access-db';
import { METRICS, type Metrics } from '@workspace/core-server-observability';
import { QUEUE_CONNECTION, QueueService } from '@workspace/core-server-queue';
import type { Redis } from 'ioredis';

/**
 * Where whatever runs the backup records that one finished.
 *
 * On the queue's Redis rather than the cache's, because that instance is the
 * one checked at boot for `noeviction`. A backup age that disappeared because
 * a cache evicted the key would read as "no backup has ever run" — the alarm
 * this metric exists to raise, raised for the wrong reason.
 */
const BACKUP_KEY = 'app:backup:last-completed';

/** Every state the gauges publish, so one that empties reads as zero. */
const OUTBOX_STATES = ['PENDING', 'PROCESSING', 'ENQUEUED', 'DEAD'] as const;
const QUEUE_STATES = ['waiting', 'active', 'delayed', 'failed'] as const;
const DELIVERY_OUTCOMES = ['delivered', 'refused', 'unreachable'] as const;

/**
 * The queues this deployment runs.
 *
 * Named rather than discovered: BullMQ can only list the queues that have keys
 * in Redis, so a queue that has never had a job would be missing from a
 * discovered list — and a queue with no jobs is exactly the one worth showing
 * as zero.
 */
const QUEUES = [
  'events',
  'webhook-dispatch',
  'webhook-deliveries',
  'retention',
  'erasure',
  'files',
] as const;

/**
 * The numbers that live somewhere else, read when somebody scrapes.
 *
 * On the scrape rather than on a timer, because a timer is a second thing to
 * tune and a query nobody is reading. A scrape is every fifteen seconds by
 * convention; five small aggregates at that rate are cheaper than the
 * background job that would otherwise keep them fresh.
 *
 * **Every state is published, including the empty ones.** A gauge that
 * disappears when its state empties looks identical on a dashboard to a gauge
 * that stopped being collected, and the two need opposite responses.
 *
 * These are read from the API even though the worker is what produces most of
 * them. The worker deliberately has no HTTP surface — a worker that can serve a
 * request is an API with a confusing name — so anything scrapable has to be
 * readable from the database or from Redis, and all of this is.
 */
@Injectable()
export class MetricsCollector {
  private readonly logger = new Logger(MetricsCollector.name);
  private readonly metrics: Metrics;
  private readonly db: Database;
  private readonly outbox: OutboxRepository;
  private readonly webhooks: WebhookRepository;
  private readonly queue: QueueService;
  private readonly redis: Redis;

  constructor(
    @Inject(METRICS) metrics: Metrics,
    @Inject(Database) db: Database,
    @Inject(OutboxRepository) outbox: OutboxRepository,
    @Inject(WebhookRepository) webhooks: WebhookRepository,
    @Inject(QueueService) queue: QueueService,
    @Inject(QUEUE_CONNECTION) redis: Redis,
  ) {
    this.metrics = metrics;
    this.db = db;
    this.outbox = outbox;
    this.webhooks = webhooks;
    this.queue = queue;
    this.redis = redis;
  }

  /**
   * Refreshes what the process does not already know.
   *
   * Failures are logged and swallowed: a scrape that returned 500 because one
   * aggregate timed out would take every other number with it, including the
   * ones that would have explained the timeout.
   */
  async collect(): Promise<void> {
    await Promise.all([
      this.collectOutbox(),
      this.collectDeliveries(),
      this.collectQueues(),
      this.collectBackupAge(),
    ]);
  }

  /**
   * How long ago a backup finished, or nothing at all.
   *
   * **Absent rather than zero when no backup has ever run.** A gauge sitting at
   * zero reads as "a backup finished just now", which is the opposite of the
   * truth and the one direction this metric must never be wrong in. A missing
   * series is what an alert on `absent(backup_age_seconds)` is for.
   *
   * `tools/scripts/backup.sh` writes the key. Anything else that takes backups
   * has to write it too, or this reports on a backup nobody is taking.
   */
  private async collectBackupAge(): Promise<void> {
    try {
      const recorded = await this.redis.get(BACKUP_KEY);

      if (recorded === null) {
        this.metrics.backupAgeSeconds.reset();
        return;
      }

      const completedAt = Number(recorded);

      if (!Number.isFinite(completedAt) || completedAt <= 0) {
        // Something wrote nonsense into the key. Saying nothing is right;
        // publishing a number derived from it would be worse than silence.
        this.metrics.backupAgeSeconds.reset();
        this.logger.warn(
          `The backup timestamp in "${BACKUP_KEY}" is not a unix time: ${recorded}`,
        );
        return;
      }

      this.metrics.backupAgeSeconds.set(Date.now() / 1_000 - completedAt);
    } catch (failure) {
      this.warn('the backup timestamp', failure);
    }
  }

  private async collectOutbox(): Promise<void> {
    try {
      const counts = await this.db.withSystemTransaction(() =>
        this.outbox.countByState(),
      );

      for (const state of OUTBOX_STATES) {
        this.metrics.outboxRows.set({ state }, counts[state] ?? 0);
      }
    } catch (failure) {
      this.warn('the outbox', failure);
    }
  }

  private async collectDeliveries(): Promise<void> {
    try {
      const counts = await this.db.withSystemTransaction(() =>
        this.webhooks.countRecentDeliveries(),
      );

      for (const outcome of DELIVERY_OUTCOMES) {
        this.metrics.webhookDeliveries.set({ outcome }, counts[outcome] ?? 0);
      }
    } catch (failure) {
      this.warn('webhook deliveries', failure);
    }
  }

  private async collectQueues(): Promise<void> {
    for (const queue of QUEUES) {
      try {
        const depth = await this.queue.depth(queue);

        for (const state of QUEUE_STATES) {
          this.metrics.queueDepth.set({ queue, state }, depth[state] ?? 0);
        }
      } catch (failure) {
        this.warn(`the "${queue}" queue`, failure);
      }
    }
  }

  private warn(what: string, failure: unknown): void {
    this.logger.warn(
      `Could not read ${what} for the scrape: ${
        failure instanceof Error ? failure.message : String(failure)
      }`,
    );
  }
}
