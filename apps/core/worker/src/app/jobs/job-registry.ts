import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import { WorkerConfig } from '@workspace/core-server-core';
import { QueueService, type Schedule } from '@workspace/core-server-queue';

import { AuditConsumer } from '../outbox/audit.consumer.js';
import { outboxDelivery, webhookDispatch } from '../outbox/outbox.job.js';
import { RetentionSweep, retentionSweep } from './retention.job.js';
import { ErasureSweep, erasureSweep } from '../erasure/erasure.job.js';
import { FileScanner, fileScan } from '../files/file-scanner.job.js';
import { WebhookDispatcher } from '../webhooks/webhook.dispatcher.js';
import { WebhookSender } from '../webhooks/webhook.sender.js';
import { webhookDelivery } from '../webhooks/webhook.job.js';

/**
 * Everything this worker consumes and everything it schedules.
 *
 * One place, on purpose: a job registered from inside whichever module happens
 * to own it is a job nobody can enumerate, and enumerating them is what makes
 * it possible to say later which schedules in Redis still belong to something.
 *
 * `onApplicationBootstrap` rather than `onModuleInit`, because Nest runs every
 * `onModuleInit` first and the queue's connection is checked while resolving
 * its factory — so by the time this runs, the Redis is known not to evict and
 * the database client has connected.
 *
 * **Schedule ids are stable, and nothing is removed here.** BullMQ's
 * registration is last-writer-wins under an id: it overwrites without
 * comparing and without saying anything. A stable id makes that converge — a
 * changed interval is written by every replica of the new image, so once the
 * old ones are gone the new interval is what is left. Encoding the interval in
 * the id instead would make the two schedules different objects, which sounds
 * safer and is not: something then has to delete the loser, and at boot the
 * only thing that knows is a replica which cannot tell "this deploy dropped
 * that job" from "the other half of this deploy has not booted yet". Two
 * versions doing that to each other is a schedule that flaps for the length of
 * the rollout.
 *
 * Removing a schedule whose job is gone from the code is therefore a
 * deliberate step rather than a side effect of booting;
 * `QueueService.reconcileSchedules` is what performs it, and it refuses to
 * touch a schedule that is still due.
 */
/**
 * The retention sweep's concurrency.
 *
 * One, because the schedule produces one job an hour and every extra worker
 * would sit idle holding a database connection. It is the event consumers that
 * need the configured concurrency — they see an event per write.
 */
const SWEEP_CONCURRENCY = 1;

/**
 * How many consumers run at `WORKER_CONCURRENCY`.
 *
 * The audit consumer, the webhook dispatcher and the webhook sender. Each job
 * of each holds a database connection for as long as its transaction is open —
 * the sender's is brief and twice, around a network call that is not inside
 * one, which is what keeps the count honest at one connection per job in
 * flight rather than one held across the request.
 */
const EVENT_CONSUMERS = 3;

/**
 * The scheduled sweeps, each at concurrency one.
 *
 * Retention, the abandoned-upload sweep and erasure. The erasure job's
 * connection is **not** counted: it opens one as `erasure_role` for the minute
 * it runs and closes it again, so it belongs to that role's budget rather than
 * to this pool.
 */
const SCHEDULED_SWEEPS = 3;

/** The relay's own transaction, which it holds one at a time. */
const RELAY_CONNECTIONS = 1;

@Injectable()
export class JobRegistry implements OnApplicationBootstrap {
  private readonly logger = new Logger(JobRegistry.name);
  private readonly queue: QueueService;
  private readonly config: WorkerConfig;
  private readonly retention: RetentionSweep;
  private readonly erasure: ErasureSweep;
  private readonly fileScanner: FileScanner;
  private readonly dispatcher: WebhookDispatcher;
  private readonly sender: WebhookSender;
  private readonly audit: AuditConsumer;

  constructor(
    @Inject(QueueService) queue: QueueService,
    @Inject(WorkerConfig) config: WorkerConfig,
    @Inject(RetentionSweep) retention: RetentionSweep,
    @Inject(ErasureSweep) erasure: ErasureSweep,
    @Inject(FileScanner) fileScanner: FileScanner,
    @Inject(WebhookDispatcher) dispatcher: WebhookDispatcher,
    @Inject(WebhookSender) sender: WebhookSender,
    @Inject(AuditConsumer) audit: AuditConsumer,
  ) {
    this.queue = queue;
    this.config = config;
    this.retention = retention;
    this.erasure = erasure;
    this.fileScanner = fileScanner;
    this.dispatcher = dispatcher;
    this.sender = sender;
    this.audit = audit;
  }

  /**
   * Refuses a concurrency the connection pool cannot hold.
   *
   * Every event consumer runs at this concurrency and each job opens a
   * transaction; each scheduled sweep holds one at concurrency one, and the
   * relay holds one more. The heartbeat is not counted — it pings Redis and
   * writes a file, and never opens a database connection.
   *
   * Without the check, raising the concurrency to clear a backlog exhausts the
   * pool, and exhaustion surfaces as a transaction timeout: retried, then
   * eventually dead-lettered. The knob for clearing a backlog becomes the knob
   * that loses it.
   */
  private assertFitsThePool(concurrency: number): void {
    const poolMax = this.config.get('WORKER_DATABASE_POOL_MAX');
    const needed =
      concurrency * EVENT_CONSUMERS +
      SWEEP_CONCURRENCY * SCHEDULED_SWEEPS +
      RELAY_CONNECTIONS;

    if (needed > poolMax) {
      throw new Error(
        `WORKER_CONCURRENCY is ${concurrency}, so this worker would want ${needed} database ` +
          `connections (${EVENT_CONSUMERS} event consumers at that concurrency, ` +
          `${SWEEP_CONCURRENCY * SCHEDULED_SWEEPS} for the scheduled sweeps and ` +
          `${RELAY_CONNECTIONS} for the relay) ` +
          `from a pool of ${poolMax}. Raise WORKER_DATABASE_POOL_MAX, or lower the concurrency: ` +
          'running out of connections arrives as a transaction timeout, not as anything naming ' +
          'a pool.',
      );
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    const concurrency = this.config.get('WORKER_CONCURRENCY');
    this.assertFitsThePool(concurrency);

    // Registered before any `await` in this method. The relay refuses to
    // deliver into a queue nothing drains, so a slow Redis here would leave it
    // idle for as long as the await took — and every event with it.
    this.queue.consume(
      outboxDelivery,
      (job) => this.audit.handle(job),
      concurrency,
    );

    this.queue.consume(
      webhookDispatch,
      (job) => this.dispatcher.handle(job),
      concurrency,
    );

    this.queue.consume(
      webhookDelivery,
      (job) => this.sender.handle(job),
      concurrency,
    );

    this.queue.consume(
      retentionSweep,
      async () => {
        await this.retention.run();
      },
      SWEEP_CONCURRENCY,
    );

    // Erasure is optional, and this is what makes it so rather than merely
    // saying so. Its connection string is the switch: without a role of its
    // own there is nothing that may delete a person, and registering the
    // schedule anyway meant the job ran on the next tick, threw
    // `ERASURE_DATABASE_URL is required`, and did it again a day later
    // forever — measured, and it is what made the worker's own suite red.
    //
    // A deployment that has not set it up gets one line at boot instead.
    const erasureConfigured = this.config.get('ERASURE_DATABASE_URL') !== undefined;

    if (erasureConfigured) {
      this.queue.consume(
        erasureSweep,
        async () => {
          await this.erasure.run();
        },
        SWEEP_CONCURRENCY,
      );
    }

    this.queue.consume(
      fileScan,
      async () => {
        await this.fileScanner.run();
      },
      SWEEP_CONCURRENCY,
    );

    const sweep: Schedule = { everyMs: this.retention.intervalMs };
    await this.queue.schedule(retentionSweep, retentionSweep.name, sweep, {});

    const scanning: Schedule = { everyMs: this.fileScanner.intervalMs };
    await this.queue.schedule(fileScan, fileScan.name, scanning, {});

    if (erasureConfigured) {
      const erasing: Schedule = { everyMs: this.erasure.intervalMs };
      await this.queue.schedule(erasureSweep, erasureSweep.name, erasing, {});
      this.logger.log(
        `Erasing accounts past their grace window every ${erasing.everyMs}ms.`,
      );
    } else {
      // Not a warning: a deployment with no erasure role is a deployment that
      // has not asked for this, and shouting at it every boot trains people to
      // ignore the log. It is still said, because "why is nobody erased" is a
      // question somebody will eventually ask.
      this.logger.log(
        'ERASURE_DATABASE_URL is not set, so nothing erases accounts past their grace ' +
          'window. Requests to be forgotten are recorded and left pending.',
      );
    }

    this.logger.log(
      `Consuming "${outboxDelivery.queue}", "${webhookDispatch.queue}" and ` +
        `"${webhookDelivery.queue}" at concurrency ${concurrency}, and ` +
        `"${retentionSweep.queue}" and "${fileScan.queue}" at ${SWEEP_CONCURRENCY}; ` +
        `schedule "${retentionSweep.name}" every ${sweep.everyMs}ms and ` +
        `"${fileScan.name}" every ${scanning.everyMs}ms.`,
    );
  }
}
