import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import { WorkerConfig, withDeadline } from '@workspace/core-server-core';
import {
  Database,
  OutboxRepository,
  ProcessedEventRepository,
  type ClaimedEvent,
} from '@workspace/core-server-data-access-db';
import {
  parentContextFrom,
  withContext,
} from '@workspace/core-server-observability';
import { QueueService } from '@workspace/core-server-queue';

import { OUTBOX_CONSUMERS } from './outbox.job.js';

/** The batch size for one sweep statement; the count of them is configurable. */
const SWEEP_BATCH_SIZE = 1_000;

/**
 * How much longer a consumer's record of an event is kept than the event.
 *
 * A dedup row that expired first would let an event replayed at the edge of
 * its own window be processed a second time.
 */
const PROCESSED_EVENT_RETENTION_FACTOR = 2;

/** What one pass over the outbox did, for the caller and for the tests. */
export interface RelayRun {
  readonly delivered: number;
  readonly failed: number;
  readonly reclaimed: number;
  readonly died: number;
  readonly swept: number;
}

/**
 * Moves events from the database to the queue.
 *
 * A poll loop in this process, not a scheduled job. A schedule exists to make
 * recurring work happen *once* across replicas; this wants the opposite —
 * every replica polling, taking disjoint rows under `SKIP LOCKED`, so the
 * throughput grows with the number of workers. Putting it on the queue would
 * add a job per tick doing nothing and still need `SKIP LOCKED` underneath.
 *
 * Three steps, three transactions: claim, then enqueue, then mark. The
 * transaction contract forbids a network call inside a transaction, and
 * holding row locks across a Redis round trip is why. The window that opens
 * between the second and third step is what the stale reclaim closes.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly db: Database;
  private readonly outbox: OutboxRepository;
  private readonly processed: ProcessedEventRepository;
  private readonly queue: QueueService;
  private readonly config: WorkerConfig;

  private timer: NodeJS.Timeout | undefined;
  private running: Promise<RelayRun> | undefined;
  private stopped = false;
  private warnedAboutConsumer = false;
  private reclaimDueAt = 0;
  private sweepDueAt = 0;

  constructor(
    @Inject(Database) db: Database,
    @Inject(OutboxRepository) outbox: OutboxRepository,
    @Inject(ProcessedEventRepository) processed: ProcessedEventRepository,
    @Inject(QueueService) queue: QueueService,
    @Inject(WorkerConfig) config: WorkerConfig,
  ) {
    this.db = db;
    this.outbox = outbox;
    this.processed = processed;
    this.queue = queue;
    this.config = config;
  }

  onApplicationBootstrap(): void {
    const leaseMs = this.config.get('OUTBOX_LEASE_MS');
    const enqueueTimeoutMs = this.config.get('OUTBOX_ENQUEUE_TIMEOUT_MS');

    // A lease that outlives the queue's deduplication window turns every
    // reclaim into a real second delivery rather than a silently ignored one.
    // Checked here because the queue owns the number and this owns the lease.
    this.queue.assertDedupWindowExceeds(leaseMs, 'OUTBOX_LEASE_MS');

    // And the other end of the same bound, which is knowable here: an enqueue
    // is allowed to take `OUTBOX_ENQUEUE_TIMEOUT_MS`, so a lease shorter than
    // that expires while the enqueue is still in flight — every slow delivery
    // reclaimed and sent twice, with nothing in the log to say why.
    if (leaseMs <= enqueueTimeoutMs) {
      throw new Error(
        `OUTBOX_LEASE_MS is ${leaseMs}ms and OUTBOX_ENQUEUE_TIMEOUT_MS is ${enqueueTimeoutMs}ms. ` +
          'The lease has to outlast the enqueue it covers, or a delivery still in flight is ' +
          'reclaimed and sent a second time.',
      );
    }

    // The sweep has to remove rows at least as fast as the claim creates them.
    // Below that the outbox grows without bound inside its own retention
    // window — and adding replicas does not help, because it raises both sides
    // equally.
    const sweptPerSecond =
      (this.config.get('OUTBOX_SWEEP_BATCHES') * SWEEP_BATCH_SIZE * 1_000) /
      this.config.get('OUTBOX_SWEEP_EVERY_MS');
    const deliveredPerSecond =
      (this.config.get('OUTBOX_BATCH') * 1_000) /
      this.config.get('OUTBOX_POLL_MS');

    if (sweptPerSecond <= deliveredPerSecond) {
      throw new Error(
        `This relay would deliver ${deliveredPerSecond} events a second and remove ${sweptPerSecond}. ` +
          'Every delivered event becomes a row the sweep has to take, so the outbox would grow ' +
          'without bound inside its own retention window. Raise OUTBOX_SWEEP_BATCHES or lower ' +
          'OUTBOX_SWEEP_EVERY_MS.',
      );
    }

    // Started, not awaited. Nest runs bootstrap hooks in sequence, and waiting
    // for a first full batch here would delay the hook that registers the
    // queue's consumer.
    this.schedule(0);

    this.logger.log(
      `Relaying events every ${this.config.get('OUTBOX_POLL_MS')}ms, ` +
        `${this.config.get('OUTBOX_BATCH')} at a time.`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /**
   * Stops claiming, and waits for the pass in flight.
   *
   * Called from the signal handler *before* the queue drains: the relay is a
   * producer, so draining first would leave it filling a queue that had just
   * been emptied. Waiting for the pass in flight is what keeps `app.close()`
   * from disconnecting the database under an open claim.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;

    await this.running?.catch(() => undefined);
    this.running = undefined;
  }

  /**
   * One pass: recover, claim, deliver, record.
   *
   * Public because the tests drive it directly — a loop that can only be
   * observed through a timer is a loop whose behaviour is measured in sleeps.
   */
  async runOnce(): Promise<RelayRun> {
    const batch = this.config.get('OUTBOX_BATCH');
    const maxAttempts = this.config.get('OUTBOX_MAX_ATTEMPTS');
    const leaseMs = this.config.get('OUTBOX_LEASE_MS');

    const unconsumed = await this.unconsumedQueues();

    if (unconsumed.length > 0) {
      // Nothing drains one of the queues this relay fills, and they run on the
      // Redis configured never to evict — so every event delivered would stay
      // there until that Redis refused writes, taking the schedules and
      // everything else with it. Better to leave the events in the database,
      // where they are exactly as durable and cost nothing.
      //
      // Checked on the pass rather than at bootstrap: consumers register in
      // the same phase this starts in, and the first pass is a timer callback,
      // so by now they have.
      if (!this.warnedAboutConsumer) {
        this.warnedAboutConsumer = true;
        this.logger.error(
          `Nothing consumes ${unconsumed.map((queue) => `"${queue}"`).join(' or ')}, so the ` +
            'relay is not delivering. Events stay in the database and nothing is lost — but ' +
            'nothing arrives either, and they will not be delivered until a consumer is ' +
            'registered.',
        );
      }

      return { delivered: 0, failed: 0, reclaimed: 0, died: 0, swept: 0 };
    }

    const recovered = await this.recover(batch, leaseMs, maxAttempts);
    const swept = await this.sweep();

    // Delivered before anything else is claimed. A claim that throws would
    // otherwise strand the rows this pass just reclaimed: still `PROCESSING`,
    // an attempt spent, a fresh lease, and undeliverable until it expires.
    const recoveredDelivery = await this.deliver(recovered.events);

    const claimed = await this.db.withSystemTransaction(() =>
      this.outbox.claimPending(batch, maxAttempts),
    );
    const claimedDelivery = await this.deliver(claimed);

    return {
      delivered: recoveredDelivery.delivered + claimedDelivery.delivered,
      failed: recoveredDelivery.failed + claimedDelivery.failed,
      reclaimed: recovered.events.length,
      died: recovered.died,
      swept,
    };
  }

  /**
   * Enqueues a batch and records what happened to each event.
   *
   * `allSettled`, not a single `try`: one `add` that fails must not drag the
   * ninety-nine that succeeded back to `PENDING`, which is a second delivery
   * for every one of them.
   */
  private async deliver(
    events: readonly ClaimedEvent[],
  ): Promise<{ delivered: number; failed: number }> {
    if (events.length === 0) {
      return { delivered: 0, failed: 0 };
    }

    const timeoutMs = this.config.get('OUTBOX_ENQUEUE_TIMEOUT_MS');

    const outcomes = await Promise.allSettled(
      events.map((event) =>
        withDeadline(
          this.enqueueEverywhere(event),
          timeoutMs,
          `Enqueueing ${event.eventType}`,
        ),
      ),
    );

    const delivered: ClaimedEvent[] = [];
    const failed: { event: ClaimedEvent; reason: string }[] = [];

    outcomes.forEach((outcome, index) => {
      const event = events[index];
      if (!event) {
        return;
      }

      if (outcome.status === 'fulfilled') {
        delivered.push(event);
        return;
      }

      // Each event's own reason. One reason for the batch would write the last
      // failure onto every row that failed — including rows that failed for a
      // different reason entirely, and `last_error` is the only record of why
      // an event died.
      failed.push({
        event,
        reason:
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason),
      });
    });

    await this.record(delivered, failed);

    return { delivered: delivered.length, failed: failed.length };
  }

  /**
   * Which of the queues this relay fills has nobody draining it.
   *
   * The local answer first, because it costs nothing and is the answer in the
   * deployment this repository ships. Redis is asked only about the queues
   * this process does not consume itself — which is what makes a split
   * deployment work, where the audit consumer and the webhook dispatcher are
   * separate replicas and each has a relay that consumes only one of them.
   */
  private async unconsumedQueues(): Promise<string[]> {
    const answers = await Promise.all(
      OUTBOX_CONSUMERS.map(async (consumer) => ({
        queue: consumer.queue,
        consumed: await this.queue.anyoneConsumes(consumer.queue),
      })),
    );

    return answers.filter((answer) => !answer.consumed).map((a) => a.queue);
  }

  /**
   * Puts one event on every consumer's queue, or fails.
   *
   * `Promise.all` rather than `allSettled`: a partial fan-out is a failure of
   * the whole event, because the outbox row has one status and it cannot mean
   * "delivered to one of two". The consumers that did accept see the event
   * again when the batch is retried, which their own contracts allow.
   */
  private async enqueueEverywhere(event: ClaimedEvent): Promise<void> {
    // The trace the *request* was in, carried on the row since it was written.
    // Restored here so the jobs this relay creates hang off that request rather
    // than off the relay's own pass — which is a picture of a background loop,
    // not of the thing somebody did.
    const parent =
      event.traceParent === undefined
        ? undefined
        : parentContextFrom({ traceparent: event.traceParent });

    await withContext(parent, () => this.fanOut(event));
  }

  private async fanOut(event: ClaimedEvent): Promise<void> {
    await Promise.all(
      OUTBOX_CONSUMERS.map((consumer) =>
        this.queue.enqueue(
          consumer,
          {
            eventId: event.eventId,
            eventType: event.eventType,
            aggregateType: event.aggregateType,
            aggregateId: event.aggregateId,
            aggregateVersion: event.aggregateVersion,
            payload: event.payload,
            // A string, because the column arrives from PostgreSQL as a
            // `Date` and the schema wants ISO text. Without the conversion
            // `enqueue`'s own validation rejects it and the event walks to
            // `DEAD` without ever reaching the queue.
            occurredAt: event.occurredAt.toISOString(),
          },
          {
            ...(event.tenantId === null ? {} : { tenantId: event.tenantId }),
            ...(event.actorId === null ? {} : { actorId: event.actorId }),
          },
          // The event's own id, so a reclaim that re-enqueues is a no-op
          // while the completed job is still there. The same id on every
          // queue: it deduplicates within one and deliberately not across
          // them. An optimisation, not the guarantee — the consumer's own
          // record is that.
          { jobId: event.eventId },
        ),
      ),
    );
  }

  /** Marks what was delivered, and returns what was not for another attempt. */
  private async record(
    delivered: readonly ClaimedEvent[],
    failed: readonly { event: ClaimedEvent; reason: string }[],
  ): Promise<void> {
    const maxAttempts = this.config.get('OUTBOX_MAX_ATTEMPTS');

    for (const [claimedAt, group] of byClaim(delivered)) {
      const marked = await this.db.withSystemTransaction(() =>
        this.outbox.markEnqueued(group, claimedAt),
      );

      if (marked.length !== group.length) {
        // The rows this relay could not mark were taken by a reclaim while it
        // was enqueueing, so the other relay delivers them again. Harmless —
        // the consumer's record absorbs it — but a stream of this means the
        // lease is shorter than the enqueue round trip.
        this.logger.warn(
          `${group.length - marked.length} events were reclaimed while this relay was enqueueing them; ` +
            'they will be delivered again. If this repeats, OUTBOX_LEASE_MS is too short.',
        );
      }
    }

    if (failed.length > 0) {
      // One line per pass, at warning level, naming a reason.
      //
      // Without it the first thing anybody saw was "Giving up on ..." — after
      // ten attempts with `2^n` seconds of backoff capped at five minutes,
      // which is about thirteen and a half minutes of a queue Redis being
      // unreachable with **nothing** in the log. Measured: 300 events failing
      // to enqueue produced eighteen lines of output, every one of them an
      // INFO about booting. The only record of why was a column in the
      // database.
      //
      // Deduplicated by reason so a batch of a hundred identical failures is
      // one line rather than a hundred.
      const reasons = new Set(failed.map((entry) => entry.reason));
      this.logger.warn(
        `${failed.length} of ${delivered.length + failed.length} events could not be enqueued: ` +
          `${[...reasons].slice(0, 3).join('; ')}. They stay in the database and are retried ` +
          'with a growing delay.',
      );
    }

    // Grouped by the claim *and* the reason, so each row records why it
    // failed rather than why the last one in the batch did.
    for (const [key, group] of byClaimAndReason(failed)) {
      const outcomes = await this.db.withSystemTransaction(() =>
        this.outbox.markFailed(
          group.ids,
          key.claimedAt,
          key.reason,
          maxAttempts,
        ),
      );

      for (const outcome of outcomes) {
        if (outcome.status === 'DEAD') {
          this.logger.error(
            `Giving up on ${outcome.eventType} (${outcome.eventId}) for tenant ` +
              `${outcome.tenantId ?? 'none'} after ${maxAttempts} attempts: ${key.reason}. ` +
              'This is work the system committed to and did not do.',
          );
        }
      }
    }
  }

  /**
   * Takes back what a dead relay was holding, and buries what it cannot save.
   *
   * The kill runs first, so exhausted rows stop being a prefix the reclaim has
   * to scan past on its way to the ones it can still deliver.
   */
  private async recover(
    batch: number,
    leaseMs: number,
    maxAttempts: number,
  ): Promise<{ events: ClaimedEvent[]; died: number }> {
    if (Date.now() < this.reclaimDueAt) {
      return { events: [], died: 0 };
    }
    this.reclaimDueAt = Date.now() + this.config.get('OUTBOX_RECLAIM_MS');

    const died = await this.db.withSystemTransaction(() =>
      this.outbox.killExhausted(batch, leaseMs, maxAttempts),
    );

    for (const event of died) {
      this.logger.error(
        `Giving up on ${event.eventType} (${event.eventId}) for tenant ${event.tenantId ?? 'none'}: ` +
          'its relay stopped while holding it and its attempts are spent.',
      );
    }

    const events = await this.db.withSystemTransaction(() =>
      this.outbox.reclaimStale(batch, leaseMs, maxAttempts),
    );

    if (events.length > 0) {
      // A re-enqueue is a no-op only while the original completed job is still
      // in Redis. That window is bounded by a job *count* as well as an age —
      // at a hundred events a second the count bound is ten seconds — and no
      // boot check can see it, so the number goes in the line somebody reads
      // when they are wondering why a consumer saw something twice.
      this.logger.warn(
        `Reclaimed ${events.length} events from a relay that stopped holding them. ` +
          `Each is re-enqueued under its own id, which deduplicates only while the original ` +
          `job is still there — ${this.queue.dedupWindowJobs} completed jobs on this queue, or ` +
          `${this.queue.dedupWindowMs}ms, whichever comes first. Past that the consumer sees it twice ` +
          'and its own record is what makes that harmless.',
      );
    }

    return { events, died: died.length };
  }

  /**
   * Removes delivered events past the retention window.
   *
   * On the relay's cadence rather than the retention job's, because the
   * arithmetic has to work: the relay delivers `OUTBOX_BATCH` every
   * `OUTBOX_POLL_MS`, and every delivered event becomes a row this has to
   * remove. At the retention job's hourly interval the sweep would clear a
   * twentieth of what one replica produces, and adding replicas raises both
   * sides equally.
   */
  private async sweep(): Promise<number> {
    if (Date.now() < this.sweepDueAt) {
      return 0;
    }
    this.sweepDueAt = Date.now() + this.config.get('OUTBOX_SWEEP_EVERY_MS');

    const hours = this.config.get('OUTBOX_RETENTION_HOURS');

    // Both tables the relay fills, each with its own budget rather than a
    // shared one: split between them, each would clear 83 rows a second
    // against 100 written, which is the same unbounded growth one step
    // smaller.
    //
    // A consumer's record of an event must outlive the event, or an event
    // replayed at the edge of its window is processed twice — hence the
    // factor, which lives here because this is now the only thing that sweeps
    // that table.
    const outbox = await this.repeat((limit) =>
      this.outbox.sweepEnqueued(hours, limit),
    );
    const dedup = await this.repeat((limit) =>
      this.processed.sweep(hours * PROCESSED_EVENT_RETENTION_FACTOR, limit),
    );

    return outbox + dedup;
  }

  /** Runs bounded deletes until one comes back empty, or the budget is spent. */
  private async repeat(
    remove: (limit: number) => Promise<number>,
  ): Promise<number> {
    const batches = this.config.get('OUTBOX_SWEEP_BATCHES');
    let swept = 0;

    for (let run = 0; run < batches; run += 1) {
      const removed = await this.db.withSystemTransaction(() =>
        remove(SWEEP_BATCH_SIZE),
      );
      swept += removed;

      if (removed === 0) {
        break;
      }
    }

    return swept;
  }

  /**
   * Runs a pass and books the next one.
   *
   * A self-scheduling timeout rather than an interval: an interval with an
   * async callback overlaps whenever a pass takes longer than the gap, which
   * multiplies pressure on the connection pool exactly when the relay is
   * already behind.
   *
   * The pacing signal is **delivery**, not the size of the claim. A full batch
   * that failed to enqueue means the queue is unreachable, and running again
   * immediately would drain the whole outbox into `PROCESSING` as fast as the
   * database could answer.
   */
  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      this.running = this.runOnce();

      void this.running
        .then((run) =>
          run.failed === 0 && run.delivered >= this.config.get('OUTBOX_BATCH')
            ? 0
            : this.config.get('OUTBOX_POLL_MS'),
        )
        .catch((failure: unknown) => {
          // An unhandled rejection in a timer callback ends the process on
          // Node 24, and a relay that dies silently is an outbox that stops.
          this.logger.error(
            `The relay could not complete a pass: ${failure instanceof Error ? failure.message : String(failure)}`,
          );
          return this.config.get('OUTBOX_POLL_MS');
        })
        .then((next) => {
          this.schedule(next);
        })
        .catch((failure: unknown) => {
          // The end of the chain. Everything above it is handled, but an
          // unhandled rejection here would end the process — and the whole
          // point of the handler above is that it must not.
          this.logger.error(
            `The relay could not reschedule itself: ${failure instanceof Error ? failure.message : String(failure)}`,
          );
        });
    }, delayMs);

    // Otherwise this timer alone would hold the process open after everything
    // else had stopped.
    this.timer.unref();
  }
}

/**
 * Groups events by the claim they belong to.
 *
 * `locked_at` is the fencing token, and a pass can hold more than one: the
 * rows it reclaimed carry a different one from the rows it claimed. Marking
 * them all under a single token would fence out every row but one group.
 */
function byClaim(events: readonly ClaimedEvent[]): Map<Date, string[]> {
  const groups = new Map<number, { at: Date; ids: string[] }>();

  for (const event of events) {
    const key = event.lockedAt.getTime();
    const group = groups.get(key) ?? { at: event.lockedAt, ids: [] };
    group.ids.push(event.eventId);
    groups.set(key, group);
  }

  return new Map(
    [...groups.values()].map((group) => [group.at, group.ids] as const),
  );
}

/** The same grouping, plus the reason, so `last_error` is per row. */
function byClaimAndReason(
  failures: readonly { event: ClaimedEvent; reason: string }[],
): Map<{ claimedAt: Date; reason: string }, { ids: string[] }> {
  const groups = new Map<
    string,
    { key: { claimedAt: Date; reason: string }; ids: string[] }
  >();

  for (const { event, reason } of failures) {
    const id = `${event.lockedAt.getTime()}::${reason}`;
    const group = groups.get(id) ?? {
      key: { claimedAt: event.lockedAt, reason },
      ids: [],
    };
    group.ids.push(event.eventId);
    groups.set(id, group);
  }

  return new Map(
    [...groups.values()].map(
      (group) => [group.key, { ids: group.ids }] as const,
    ),
  );
}
