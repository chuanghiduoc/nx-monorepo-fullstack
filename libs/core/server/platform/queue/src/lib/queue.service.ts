import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  SpanKind,
  injectTraceContext,
  parentContextFrom,
  withContext,
  withSpan,
} from '@workspace/core-server-observability';
import { Queue, Worker } from 'bullmq';
import type { Job, JobsOptions, RepeatOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { z } from 'zod';

import { QUEUE_CONNECTION } from './queue.tokens.js';
import {
  FIRST_ATTEMPT,
  createEnvelope,
  parseEnvelope,
  type EnvelopedJob,
} from './job-envelope.js';
import { classifyFailure } from './retry-policy.js';

/** How many times an unclassified failure is tried before it is given up on. */
const UNKNOWN_ATTEMPTS = 5;

/** The attempt budget every job gets; a fatal failure stops short of it. */
const MAX_ATTEMPTS = 8;

const BACKOFF_MS = 1_000;
const MILLISECONDS_PER_SECOND = 1_000;

/**
 * How far into the past a schedule's next run must be before it is treated as
 * abandoned. Long enough that an interval nobody would call recurring — a
 * daily sweep, say — is never mistaken for one that has stopped.
 */
const ORPHAN_GRACE_MS = 60 * 60 * 24 * 2 * 1_000;

/**
 * How long a completed job is kept, and how many.
 *
 * Both bounds, not one: an idle queue would otherwise keep its last jobs
 * forever, and a busy one would pass any count within the age window.
 */
const COMPLETED_RETENTION_SECONDS = 60 * 60;
const COMPLETED_RETENTION_COUNT = 1_000;

/**
 * How long a failed job is kept.
 *
 * The failed set is the dead letter, so it is not cleared on success — but it
 * cannot be unbounded either: this is the Redis that must never evict, and an
 * unbounded set on it is a slow way to run it out of memory. A failure nobody
 * has looked at in a fortnight is not going to be looked at.
 */
const FAILED_RETENTION_SECONDS = 60 * 60 * 24 * 14;

/**
 * How long a worker's claim on a job survives without being renewed, and how
 * often the queue looks for claims that were not.
 *
 * Stated rather than inherited. These are BullMQ's own defaults, and writing
 * them down is what makes them a decision: they are the recovery time after a
 * worker is killed mid-job — the container is replaced, the lock is never
 * renewed, and thirty seconds later another worker picks the job up from the
 * start.
 *
 * Lowering either would recover faster and start declaring live workers dead:
 * the lock is renewed on a timer that the handler's own event-loop work can
 * delay. Raising them makes a killed worker's job sit longer. Thirty seconds
 * is the trade BullMQ chose and there is no measurement here to beat it.
 */
export const JOB_LOCK_MS = 30_000;
const STALLED_CHECK_MS = 30_000;

/**
 * How many times a job may be recovered from a dead worker before it is failed
 * for good.
 *
 * One, because the second time is evidence of something other than a killed
 * container — a handler that blocks the event loop past the lock, most likely
 * — and retrying that forever would hide it. A job that reaches the limit
 * fails with a message naming the stall, which is what somebody needs to read.
 */
const MAX_STALLED_RECOVERIES = 1;

/**
 * What every job is enqueued with unless the caller says otherwise.
 *
 * Applied to scheduled work too. A schedule registered without them would
 * inherit BullMQ's own defaults — `attempts: 0`, which means no retry at all —
 * so one connection reset would silently lose that tick while an enqueued job
 * beside it was tried eight times.
 */
const DEFAULT_JOB_OPTIONS = {
  attempts: MAX_ATTEMPTS,
  backoff: { type: 'exponential', delay: BACKOFF_MS },
  removeOnComplete: {
    age: COMPLETED_RETENTION_SECONDS,
    count: COMPLETED_RETENTION_COUNT,
  },
  removeOnFail: { age: FAILED_RETENTION_SECONDS },
} as const satisfies JobsOptions;

export interface EnqueueContext {
  readonly tenantId?: string;
  readonly actorId?: string;
  readonly traceparent?: string;
}

/**
 * What a caller may vary about a single job.
 *
 * Deliberately not the queue driver's own options type. `bullmq` is banned
 * outside this library, so a caller that named the driver's type in a variable
 * would fail lint — and every option the driver offers that this workspace has
 * not decided about would become part of the contract by accident.
 */
export interface EnqueueOptions {
  /**
   * A natural identity for the work — an outbox event id, say.
   *
   * The queue then refuses a second job with the same id, which is how a crash
   * between "enqueue" and "record that we enqueued" stops being a duplicate.
   * It refuses it *silently*: nothing throws.
   *
   * **The refusal expires.** Deduplication is the completed job still being
   * there, so it lasts until that job is cleaned up — whichever of the age and
   * count bounds comes first. Measured: past either one, the same id was
   * accepted again and the work ran twice. Anything that needs delivery to
   * happen once regardless has to record that it happened, in its own
   * transaction. This is an optimisation, not a guarantee.
   */
  readonly jobId?: string;

  /** Hold the job back this long before any worker may pick it up. */
  readonly delayMs?: number;
}

/** How often recurring work runs. */
export type Schedule =
  | { readonly everyMs: number }
  | { readonly cron: string; readonly timeZone?: string };

export interface JobDefinition<Payload> {
  /** The queue this job lives on, and the name it is enqueued under. */
  readonly queue: string;
  readonly name: string;
  readonly payload: z.ZodType<Payload>;
}

export type JobHandler<Payload> = (job: EnvelopedJob<Payload>) => Promise<void>;

/**
 * The only place that talks to the queue.
 *
 * Everything else asks for work to happen; nothing else knows what happens
 * next, which is what makes replacing the queue a change to one library rather
 * than a search across the codebase. The module boundary rule enforces it —
 * `bullmq` is banned from every tag but the one this library carries.
 *
 * It is handed a connection rather than connection options. Measured against
 * bullmq 6.3.4: given options, every `Queue` and every `Worker` opens a client
 * of its own and closes it; given an instance, the connection is marked shared
 * and BullMQ never closes it. Owning one connection is what lets the module
 * check the eviction policy before this class exists at all, and it makes this
 * class the single thing responsible for closing it.
 */
@Injectable()
export class QueueService implements OnApplicationShutdown {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues = new Map<string, Queue>();
  private readonly workers = new Map<string, Worker>();
  private readonly connection: Redis;
  private draining: Promise<void> | undefined;
  private closing: Promise<void> | undefined;

  constructor(@Inject(QUEUE_CONNECTION) connection: Redis) {
    this.connection = connection;
  }

  /** Asks for work to happen. */
  async enqueue<Payload>(
    definition: JobDefinition<Payload>,
    payload: Payload,
    context: EnqueueContext = {},
    options: EnqueueOptions = {},
  ): Promise<void> {
    // Checked here, where the stack still points at whoever asked. Left to the
    // consumer it surfaces as a dead-lettered job whose stack names this file,
    // minutes later and in a different process.
    const validated = definition.payload.parse(payload);

    // The trace comes from whatever is running, unless the caller named one.
    // Without this a job is a trace of its own and `api → queue → worker` is
    // three unrelated pictures of one request.
    const carried = injectTraceContext()['traceparent'];

    const envelope = createEnvelope({
      ...context,
      ...(context.traceparent ?? carried === undefined
        ? {}
        : { traceparent: carried }),
    });

    await withSpan(
      `enqueue ${definition.queue}/${definition.name}`,
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          'messaging.system': 'bullmq',
          'messaging.destination.name': definition.queue,
          'messaging.operation.name': definition.name,
        },
      },
      async () => {
        await this.queueFor(definition.queue).add(
          definition.name,
          { envelope, payload: validated },
          {
            ...DEFAULT_JOB_OPTIONS,
            ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
            ...(options.delayMs === undefined
              ? {}
              : { delay: options.delayMs }),
          },
        );
      },
    );
  }

  /**
   * Registers a schedule, idempotently.
   *
   * Keyed by the scheduler's id, so every replica calling this at boot leaves
   * exactly one schedule and one job per tick. That is the property that makes
   * it the right tool for recurring work when more than one worker is running:
   * an in-process timer would fire once per replica, on the same rows.
   *
   * The registration is last-writer-wins, not a merge: BullMQ overwrites the
   * schedule under an id without comparing it or saying anything. During a
   * rolling deploy the two images disagree, and whichever replica booted last
   * decides for everyone. That is why the id has to name the schedule it
   * stands for, and why `reconcileSchedules` removes the ones nobody claims.
   */
  async schedule<Payload>(
    definition: JobDefinition<Payload>,
    id: string,
    schedule: Schedule,
    payload: Payload,
  ): Promise<void> {
    const validated = definition.payload.parse(payload);

    await this.queueFor(definition.queue).upsertJobScheduler(
      id,
      repeatOptions(schedule),
      {
        name: definition.name,
        // The envelope in a template is written once and copied to every tick,
        // so its timestamp says when the schedule was registered. `consume`
        // replaces it with the queue's own stamp for the tick.
        data: { envelope: createEnvelope({}), payload: validated },
        opts: DEFAULT_JOB_OPTIONS,
      },
    );
  }

  /**
   * Removes schedules on a queue that nothing claims and that have stopped
   * running.
   *
   * Without something like this, a recurring job deleted from the code keeps
   * firing: the scheduler lives in Redis, not in the source, and nothing
   * removes it when the last line that created it is gone.
   *
   * **Not boot work.** Two conditions, not one, because "this process does not
   * claim it" is not the same as "nothing claims it": during a rolling deploy
   * the two images disagree about the set of jobs, and a version that ran this
   * at boot would delete the schedule the other version had just registered,
   * over and over. A schedule whose next run is still ahead of it is therefore
   * left alone whatever the claim list says — an orphan is a schedule nobody
   * has advanced, and its next run has fallen into the past.
   */
  async reconcileSchedules(
    queue: string,
    keep: readonly string[],
    staleAfterMs = ORPHAN_GRACE_MS,
  ): Promise<void> {
    const claimed = new Set(keep);
    const target = this.queueFor(queue);
    const staleBefore = Date.now() - staleAfterMs;

    for (const scheduler of await target.getJobSchedulers()) {
      if (claimed.has(scheduler.key)) {
        continue;
      }

      if (scheduler.next !== undefined && scheduler.next > staleBefore) {
        this.logger.log(
          `Leaving the schedule "${scheduler.key}" on "${queue}": nothing here claims it, but it is still due.`,
        );
        continue;
      }

      this.logger.log(
        `Removing the schedule "${scheduler.key}" on "${queue}": nothing claims it and it has stopped running.`,
      );
      await target.removeJobScheduler(scheduler.key);
    }
  }

  /**
   * How long a completed job's id keeps deduplicating a re-enqueue.
   *
   * Asked rather than exported: a caller that has to survive a duplicate — the
   * outbox relay, whose lease decides how long a claim can go unconfirmed —
   * needs the number, and reading it from a constant of its own would be two
   * numbers that drift apart. No driver type crosses the boundary either way.
   */
  get dedupWindowMs(): number {
    return COMPLETED_RETENTION_SECONDS * MILLISECONDS_PER_SECOND;
  }

  /**
   * How many completed jobs on one queue before the oldest ids stop
   * deduplicating.
   *
   * The bound that usually binds, and the one no boot check can enforce: at a
   * hundred jobs a second this window is ten seconds, far shorter than any
   * sensible lease. It is here so a caller can say so in its own logs.
   */
  get dedupWindowJobs(): number {
    return COMPLETED_RETENTION_COUNT;
  }

  /**
   * Refuses a lease that outlives deduplication.
   *
   * A lease longer than the window means every reclaim is a real second
   * delivery rather than a silently ignored one — correct, because the
   * consumer is idempotent, but it turns an optimisation into dead weight
   * without anybody noticing. This is the half of the bound that can be
   * checked at boot; the count bound above can only be watched at runtime.
   */
  assertDedupWindowExceeds(leaseMs: number, describe: string): void {
    if (leaseMs >= this.dedupWindowMs) {
      throw new Error(
        `${describe} is ${leaseMs}ms, which is not shorter than the queue's deduplication window of ` +
          `${this.dedupWindowMs}ms. Past that window a re-enqueue is a second delivery rather than a ` +
          'no-op, so the lease has to expire first.',
      );
    }
  }

  /**
   * Answers if the queue's Redis is reachable.
   *
   * Exposed so a liveness check can say something true. A worker whose queue
   * is unreachable is not doing its job, and a check that proved only that the
   * event loop was turning would report it as healthy for as long as it sat
   * there. The connection itself stays private: handing it out would make this
   * class one of several things that could close it.
   */
  async ping(): Promise<void> {
    await this.connection.ping();
  }

  /**
   * Whether this process is consuming a queue.
   *
   * Asked by anything that produces onto a queue it also expects to be drained
   * here. A queue with no consumer is not slow — it grows, on the Redis that is
   * configured never to evict, until that Redis refuses writes and takes every
   * other queue with it.
   */
  consumes(queue: string): boolean {
    return this.workers.has(queue);
  }

  /**
   * Whether **anything, anywhere** is consuming a queue.
   *
   * `consumes` answers for this process, which is the wrong question the
   * moment consumers are deployed as separate replicas: a relay in the audit
   * image would see the webhook queue unconsumed locally and stop feeding it,
   * for a consumer that is running perfectly well next door.
   *
   * BullMQ keeps a registry of connected workers per queue, so the answer is
   * in Redis. It costs a round trip, which is why the caller asks only when
   * the local answer is already no.
   */
  async anyoneConsumes(queue: string): Promise<boolean> {
    if (this.workers.has(queue)) {
      return true;
    }

    return (await this.queueFor(queue).getWorkers()).length > 0;
  }

  /** The schedules registered on a queue, by id. */
  /**
   * How many jobs are waiting, running, delayed or failed on a queue.
   *
   * The states are the driver's, named here so the label values are a list
   * this code chose rather than whatever the driver happens to return — a
   * driver that added a state would otherwise add a time series nobody
   * decided on.
   */
  async depth(queue: string): Promise<Record<string, number>> {
    const counts = await this.queueFor(queue).getJobCounts(
      'waiting',
      'active',
      'delayed',
      'failed',
    );

    return {
      waiting: counts['waiting'] ?? 0,
      active: counts['active'] ?? 0,
      delayed: counts['delayed'] ?? 0,
      failed: counts['failed'] ?? 0,
    };
  }

  async listSchedules(queue: string): Promise<string[]> {
    const schedulers = await this.queueFor(queue).getJobSchedulers();

    return schedulers.map((scheduler) => scheduler.key).sort();
  }

  /**
   * Starts consuming a queue.
   *
   * The handler receives a parsed envelope and a parsed payload, or is never
   * called: a message this consumer cannot read is failed immediately rather
   * than retried, because its shape will not change between attempts.
   *
   * One handler per queue. A BullMQ worker is handed every job on its queue
   * regardless of the name it was added under, so a second handler here would
   * be given the first one's jobs and fail to read them.
   */
  consume<Payload>(
    definition: JobDefinition<Payload>,
    handler: JobHandler<Payload>,
    concurrency = 1,
  ): void {
    if (this.workers.has(definition.queue)) {
      throw new Error(
        `This process already consumes "${definition.queue}". A worker receives every job on its ` +
          'queue whatever name it was added under, so a second handler would be given the other one’s jobs.',
      );
    }

    const worker = new Worker(
      definition.queue,
      async (job) => {
        try {
          const parsed = parseEnvelope(job.data, definition.payload);

          // The trace the job was enqueued in, restored here so the worker's
          // spans hang off the request that caused the work rather than
          // starting a picture of their own.
          const parent =
            parsed.envelope.traceparent === undefined
              ? undefined
              : parentContextFrom({ traceparent: parsed.envelope.traceparent });

          await withContext(parent, () =>
            withSpan(
              `consume ${definition.queue}/${definition.name}`,
              {
                kind: SpanKind.CONSUMER,
                attributes: {
                  'messaging.system': 'bullmq',
                  'messaging.destination.name': definition.queue,
                  'messaging.operation.name': definition.name,
                  'messaging.message.retry.count': job.attemptsMade,
                },
              },
              () =>
                handler({
                  payload: parsed.payload,
                  envelope: {
                    ...parsed.envelope,
                    attempt: job.attemptsMade + FIRST_ATTEMPT,
                    requestedAt: requestedAtOf(job, parsed.envelope.requestedAt),
                  },
                }),
            ),
          );
        } catch (failure) {
          throw this.classify(failure, definition.queue, job.attemptsMade);
        }
      },
      {
        connection: this.connection,
        concurrency,
        lockDuration: JOB_LOCK_MS,
        stalledInterval: STALLED_CHECK_MS,
        maxStalledCount: MAX_STALLED_RECOVERIES,
      },
    );

    // Without a listener BullMQ falls back to console.error: no level, no
    // queue name, and outside the one log stream everything else is in.
    worker.on('error', (failure: Error) => {
      this.logger.error(
        `The worker on "${definition.queue}" reported: ${failure.message}`,
        failure.stack,
      );
    });

    worker.on('failed', (job: Job | undefined, failure: Error) => {
      // Not `+ FIRST_ATTEMPT` here, unlike inside the processor: BullMQ has
      // already counted this attempt by the time it emits `failed`, so adding
      // one would report every first failure as the second.
      const attempt = job?.attemptsMade ?? FIRST_ATTEMPT;
      const final = failure.name === 'UnrecoverableError';

      this.logger.error(
        `Job ${job?.name ?? 'unknown'}#${job?.id ?? '?'} on "${definition.queue}" failed on attempt ` +
          `${attempt}${final ? ' and will not be retried' : ''}: ${failure.message}`,
        failure.stack,
      );
    });

    this.workers.set(definition.queue, worker);
  }

  /**
   * Lets every job in flight finish, and starts no new one.
   *
   * Separate from shutdown, and public, because of the order Nest runs its
   * hooks in: `onModuleDestroy` — where the database client disconnects —
   * runs before `onApplicationShutdown`. A drain expressed as a shutdown hook
   * would faithfully wait for a job whose transaction had already lost its
   * connection. The process calls this itself, on the signal, before it closes
   * the application.
   *
   * There is deliberately no deadline: the only way to impose one is to
   * abandon a transaction half-done, which is the failure this exists to
   * avoid. The deadline belongs to whatever sent the signal, and it is spelled
   * `stop_grace_period`.
   */
  drain(): Promise<void> {
    this.draining ??= this.closeWorkers();
    return this.draining;
  }

  /**
   * Closes every worker, and does not let one failure abandon the others.
   *
   * `Promise.all` rejects on the first failure while the remaining workers are
   * still draining, so a single close that goes wrong would cut short the job
   * every other worker was waiting to finish. Every close is therefore awaited,
   * and the failures are reported together afterwards.
   */
  private async closeWorkers(): Promise<void> {
    const outcomes = await Promise.allSettled(
      [...this.workers.values()].map((worker) => worker.close()),
    );

    const failures = outcomes
      .filter((outcome) => outcome.status === 'rejected')
      .map((outcome) => outcome.reason as unknown);

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `${failures.length} of ${outcomes.length} workers did not close cleanly.`,
      );
    }
  }

  onApplicationShutdown(): Promise<void> {
    // Nest can reach this more than once — a signal handler and an explicit
    // `app.close()` both arrive here — and closing twice throws.
    this.closing ??= this.closeEverything();
    return this.closing;
  }

  private async closeEverything(): Promise<void> {
    try {
      await this.drain();
    } finally {
      // In `finally` because a worker that failed to close still leaves its
      // queue open, and a leaked queue holds a client that keeps the process
      // alive after everything else has stopped.
      try {
        await Promise.allSettled(
          [...this.queues.values()].map((queue) => queue.close()),
        );
      } finally {
        await this.closeConnection();
      }
    }
  }

  /** BullMQ never closes a connection it was handed, so this class does. */
  private async closeConnection(): Promise<void> {
    if (this.connection.status === 'end') {
      return;
    }

    try {
      await this.connection.quit();
    } catch (failure) {
      // The client going away is the outcome; it is not worth failing a
      // shutdown that has otherwise finished. Anything else is worth a line.
      this.logger.warn(
        `The queue connection did not close cleanly: ${String(failure)}`,
      );
      this.connection.disconnect();
    }
  }

  private queueFor(name: string): Queue {
    const existing = this.queues.get(name);
    if (existing) {
      return existing;
    }

    const queue = new Queue(name, { connection: this.connection });
    queue.on('error', (failure: Error) => {
      this.logger.error(
        `The queue "${name}" reported: ${failure.message}`,
        failure.stack,
      );
    });
    this.queues.set(name, queue);
    return queue;
  }

  /**
   * Turns a handler's failure into the queue's own vocabulary.
   *
   * BullMQ stops retrying on `err.name === 'UnrecoverableError'`, so the name
   * is set on the error the handler actually threw rather than wrapping it.
   * Wrapping replaces the stack with one that points here, and the stack is
   * the only part of a dead-lettered job worth reading.
   */
  private classify(
    failure: unknown,
    queue: string,
    attemptsMade: number,
  ): Error {
    const error =
      failure instanceof Error ? failure : new Error(String(failure));
    const attempt = attemptsMade + FIRST_ATTEMPT;
    const kind = classifyFailure(failure);

    if (kind === 'fatal') {
      error.name = 'UnrecoverableError';
      return error;
    }

    if (kind === 'unknown' && attempt >= UNKNOWN_ATTEMPTS) {
      // Retried to a ceiling rather than forever: nobody has classified this
      // failure, so it gets a bounded benefit of the doubt and then a person.
      this.logger.error(
        `Giving up on "${queue}" after ${attempt} attempts on a failure nobody has classified.`,
      );
      error.name = 'UnrecoverableError';
      return error;
    }

    return error;
  }
}

function repeatOptions(schedule: Schedule): RepeatOptions {
  return 'everyMs' in schedule
    ? { every: schedule.everyMs }
    : { pattern: schedule.cron, tz: schedule.timeZone };
}

/**
 * When the work behind a job was asked for.
 *
 * A scheduler's template is written once, when the schedule is registered, and
 * copied to every tick after it — so its own `requestedAt` reports the age of
 * the schedule, growing without bound. `job.timestamp` is stamped by the queue
 * when it creates the job, which for a tick is the moment being asked about.
 */
function requestedAtOf(job: Job, fromEnvelope: string): string {
  return job.opts.repeatJobKey
    ? new Date(job.timestamp).toISOString()
    : fromEnvelope;
}
