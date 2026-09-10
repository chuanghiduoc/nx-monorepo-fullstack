import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { Logger } from '@nestjs/common';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { z } from 'zod';

import { FIRST_ATTEMPT } from './job-envelope.js';
import {
  JOB_LOCK_MS,
  QueueService,
  type JobDefinition,
} from './queue.service.js';

const REDIS_IMAGE = 'redis:8-alpine';
const REDIS_PORT = 6379;
const START_TIMEOUT_MS = 180_000;

const ORG = '0199a1b2-0000-7000-8000-00000000000a';
const USER = '0199a1b2-0000-7000-8000-0000000000aa';

const echo: JobDefinition<{ value: string }> = {
  queue: 'queue-service-test',
  name: 'echo',
  payload: z.object({ value: z.string() }),
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long a wait for a queue to reach some state gives up after. */
const DEADLINE_MS = 10_000;
const POLL_MS = 25;

/**
 * Enough for five attempts at the real backoff.
 *
 * The exponential policy is the thing under test, so it is not shortened for
 * the test: one, two, four and eight seconds between attempts is what a
 * deployment gets, and a test that ran a different policy would be proving
 * something about the test.
 */
const CEILING_TIMEOUT_MS = 45_000;

/** Well past the grace a schedule gets before it counts as abandoned. */
const LONG_ABANDONED_MS = 60 * 60 * 24 * 7 * 1_000;

/**
 * Waits for something to become true, rather than for a fixed number of
 * milliseconds.
 *
 * A sleep long enough to be reliable on a loaded machine is far longer than
 * the work takes on an idle one, so a suite built on sleeps is both slow and
 * flaky. This is neither: it returns as soon as the queue has done the thing,
 * and when it does not it says what it was waiting for.
 */
async function until(
  describe: string,
  condition: () => Promise<boolean> | boolean,
  deadlineMs = DEADLINE_MS,
): Promise<void> {
  const giveUpAt = Date.now() + deadlineMs;

  for (;;) {
    if (await condition()) {
      return;
    }

    if (Date.now() > giveUpAt) {
      throw new Error(`Timed out after ${deadlineMs}ms waiting until ${describe}.`);
    }

    await sleep(POLL_MS);
  }
}

/**
 * The queue, against a real Redis.
 *
 * Every claim here is about what the queue actually does — dedup that is
 * silent, a drain that waits, a schedule that survives being registered twice.
 * A double would confirm the calls were made and none of the behaviour.
 */
describe('the queue', () => {
  let container: StartedTestContainer;
  let redis: Redis;
  let connection: () => Redis;
  let service: QueueService;
  const extraServices: QueueService[] = [];

  /** A service of its own, closed for the test that made it. */
  const another = (): QueueService => {
    const made = new QueueService(connection());
    extraServices.push(made);
    return made;
  };

  beforeAll(async () => {
    container = await new GenericContainer(REDIS_IMAGE)
      .withCommand(['redis-server', '--maxmemory-policy', 'noeviction'])
      .withExposedPorts(REDIS_PORT)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();

    const options = {
      host: container.getHost(),
      port: container.getMappedPort(REDIS_PORT),
      maxRetriesPerRequest: null,
    } as const;

    connection = () => new Redis(options);
    redis = new Redis(options);
    service = new QueueService(connection());
  }, START_TIMEOUT_MS);

  /**
   * Reads the queue back with a client of the spec's own.
   *
   * The service deliberately exposes no way to list jobs, because nothing in
   * the application needs one. The test opens its own queue rather than
   * widening that surface for its own convenience.
   */
  const inspect = async <T>(
    name: string,
    read: (queue: Queue) => Promise<T>,
  ): Promise<T> => {
    const queue = new Queue(name, { connection: connection() });
    try {
      return await read(queue);
    } finally {
      await queue.close();
    }
  };

  afterEach(async () => {
    // Each service owns a connection, and a test that made one has finished
    // with it. Without this they accumulate for the length of the file.
    await Promise.all(extraServices.splice(0).map((made) => made.onApplicationShutdown()));
  });

  afterAll(async () => {
    await service?.onApplicationShutdown();
    redis?.disconnect();
    await container?.stop();
  });

  it('carries the tenant, the actor and the attempt to the worker', async () => {
    const seen: {
      tenantId?: string;
      actorId?: string;
      value?: string;
      attempt?: number;
    } = {};

    service.consume(echo, async (job) => {
      seen.tenantId = job.envelope.tenantId;
      seen.actorId = job.envelope.actorId;
      seen.attempt = job.envelope.attempt;
      seen.value = job.payload.value;
    });

    await service.enqueue(
      echo,
      { value: 'hello' },
      { tenantId: ORG, actorId: USER },
    );
    await until('the handler has run', () => seen.value !== undefined);

    // The tenant is how the worker opens its transaction; without it the job
    // reads nothing and looks like a bug in the query. The actor is who to
    // attribute the work to. The attempt counts from one, not from zero: the
    // queue's own count is zero-based inside the processor, and a handler that
    // logged "attempt 0 of 8" would be reporting a number nobody recognises.
    expect(seen).toEqual({
      tenantId: ORG,
      actorId: USER,
      value: 'hello',
      attempt: FIRST_ATTEMPT,
    });
  });

  it('refuses a payload the consumer could not have read, before it is queued', async () => {
    const definition = { ...echo, queue: 'queue-service-producer-check' };

    // Left to the consumer this is a dead-lettered job in another process,
    // minutes later, with a stack that names the queue library. Here it is a
    // throw at the line that got it wrong.
    await expect(
      service.enqueue(definition, { value: 42 } as never),
    ).rejects.toThrow();

    expect(await redis.exists(`bull:${definition.queue}:meta`)).toBe(0);
  });

  it('refuses a second job with the same identity, and says nothing about it', async () => {
    const definition = { ...echo, queue: 'queue-service-dedup' };
    const jobId = 'a-natural-identity';

    await service.enqueue(definition, { value: 'first' }, {}, { jobId });
    await service.enqueue(definition, { value: 'second' }, {}, { jobId });

    // Silent on purpose in the library, and worth a test because of it: the
    // second call throws nothing, and a caller reading the returned job would
    // see the payload that was rejected.
    const stored = await redis.hget(
      `bull:queue-service-dedup:${jobId}`,
      'data',
    );

    expect(JSON.parse(stored ?? '{}').payload.value).toBe('first');
  });

  it('says how long an identity keeps deduplicating, and refuses a lease that outlives it', () => {
    // The outbox relay's lease decides how long a claim can go unconfirmed
    // before another replica re-enqueues it. Longer than this window and that
    // re-enqueue is a real second delivery rather than a no-op — still correct,
    // because the consumer is idempotent, but the deduplication has quietly
    // stopped doing anything.
    expect(service.dedupWindowMs).toBeGreaterThan(0);
    expect(service.dedupWindowJobs).toBeGreaterThan(0);

    expect(() =>
      service.assertDedupWindowExceeds(service.dedupWindowMs, 'a lease'),
    ).toThrow(/deduplication window/);

    expect(() =>
      service.assertDedupWindowExceeds(service.dedupWindowMs - 1, 'a lease'),
    ).not.toThrow();
  });

  it('stops deduplicating an identity once the completed job is gone', async () => {
    const definition = { ...echo, queue: 'queue-service-dedup-expiry' };
    const jobId = 'an-outbox-event-id';
    const handled: string[] = [];
    const runner = another();

    runner.consume(definition, async (job) => {
      handled.push(job.payload.value);
    });

    await runner.enqueue(definition, { value: 'first' }, {}, { jobId });
    await until('the first delivery has happened', () => handled.length === 1);

    // The completed job is what deduplicates; remove it and the id is free
    // again. This is what a `removeOnComplete` age or count bound does on its
    // own schedule, and it is why the outbox cannot rely on `jobId` for
    // correctness — measured here rather than argued.
    await redis.del(`bull:${definition.queue}:${jobId}`);
    await redis.zrem(`bull:${definition.queue}:completed`, jobId);

    await runner.enqueue(definition, { value: 'second' }, {}, { jobId });
    await until('the second delivery has happened', () => handled.length === 2);

    expect(handled).toEqual(['first', 'second']);
  });

  it('gives up immediately on a job it cannot read', async () => {
    const definition = { ...echo, queue: 'queue-service-unreadable' };
    let handled = 0;

    service.consume(definition, async () => {
      handled += 1;
    });

    // Written straight to Redis, the way a message from a deploy that disagrees
    // about the envelope would arrive. Going through `enqueue` cannot produce
    // this any more: the producer validates.
    await service.enqueue(
      { ...definition, payload: z.any() },
      { notTheRightShape: true },
    );

    await until(
      'the job has failed',
      async () => (await redis.zcard(`bull:${definition.queue}:failed`)) === 1,
    );

    expect(handled).toBe(0);
  });

  it('retries a failure that might pass next time', async () => {
    const definition = { ...echo, queue: 'queue-service-retry' };
    const attempts: number[] = [];
    const runner = another();

    runner.consume(definition, async (job) => {
      attempts.push(job.envelope.attempt);
      if (attempts.length < 2) {
        throw Object.assign(new Error('not now'), { code: 'ECONNRESET' });
      }
    });

    await runner.enqueue(definition, { value: 'eventually' });
    await until('the second attempt has succeeded', () => attempts.length === 2);

    expect(attempts).toEqual([1, 2]);
  });

  it(
    'stops an unclassified failure at the ceiling, short of the job budget',
    async () => {
      const definition = { ...echo, queue: 'queue-service-unclassified' };
      const attempts: number[] = [];
      const runner = another();

      runner.consume(definition, async (job) => {
        attempts.push(job.envelope.attempt);
        // No code, no status: nothing has classified this.
        throw new Error('nobody has seen this before');
      });

      await runner.enqueue(definition, { value: 'never, but politely' });
      await until(
        'the job has been given up on',
        async () => (await redis.zcard(`bull:${definition.queue}:failed`)) === 1,
        CEILING_TIMEOUT_MS,
      );

      // This is what makes the pair a test of the classifier rather than of
      // BullMQ's retry: without the ceiling the same failure would be tried
      // the job's full budget of eight times, and the test above would go on
      // passing either way.
      expect(attempts).toEqual([1, 2, 3, 4, 5]);
    },
    CEILING_TIMEOUT_MS,
  );

  it('does not retry a failure that cannot pass', async () => {
    const definition = { ...echo, queue: 'queue-service-fatal' };
    const attempts: number[] = [];
    const runner = another();

    runner.consume(definition, async (job) => {
      attempts.push(job.envelope.attempt);
      throw Object.assign(new Error('the caller is wrong'), { status: 422 });
    });

    await runner.enqueue(definition, { value: 'never' });
    await until(
      'the job has failed',
      async () => (await redis.zcard(`bull:${definition.queue}:failed`)) === 1,
    );

    // Five attempts on a 422 would delay the dead-letter a human has to read
    // and change nothing about the answer.
    expect(attempts).toEqual([FIRST_ATTEMPT]);
  });

  it('reports the attempt a job actually failed on', async () => {
    const definition = { ...echo, queue: 'queue-service-failed-log' };
    const runner = another();
    const logged: string[] = [];
    const spy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((message: unknown) => {
        logged.push(String(message));
      });

    try {
      runner.consume(definition, async () => {
        throw Object.assign(new Error('the caller is wrong'), { status: 422 });
      });

      await runner.enqueue(definition, { value: 'doomed' });
      await until(
        'the failure has been logged',
        () => logged.some((line) => line.includes(definition.queue)),
      );
    } finally {
      spy.mockRestore();
    }

    // BullMQ has already counted the attempt by the time it emits `failed`,
    // so the number here is one ahead of the one the handler saw. Reporting
    // "attempt 2" for a job that ran once sends whoever reads it looking for
    // a first attempt that never happened.
    const line = logged.find((entry) => entry.includes(definition.queue));
    expect(line).toMatch(/failed on attempt 1 and will not be retried/);
  });

  it('keeps the stack of the failure the handler threw', async () => {
    const definition = { ...echo, queue: 'queue-service-stack' };
    const runner = another();

    runner.consume(definition, async () => {
      throw Object.assign(new Error('the caller is wrong'), { status: 400 });
    });

    await runner.enqueue(definition, { value: 'doomed' });
    await until(
      'the job has failed',
      async () => (await redis.zcard(`bull:${definition.queue}:failed`)) === 1,
    );

    const [id] = await redis.zrange(`bull:${definition.queue}:failed`, '0', '0');
    const stack = await redis.hget(`bull:${definition.queue}:${id}`, 'stacktrace');

    // Wrapping the failure in the queue's own error class would replace this
    // with a stack that points at the queue library — and the stack is the
    // only part of a dead-lettered job worth opening.
    expect(stack).toMatch(/queue\.service\.spec/);
  });

  it('gives a scheduled job the same retry budget as an enqueued one', async () => {
    const definition = { ...echo, queue: 'queue-service-schedule-opts' };
    const runner = another();

    await runner.schedule(definition, 'sweep:every-100ms', { everyMs: 100 }, {
      value: 'tick',
    });

    const [tick] = await inspect(definition.queue, (queue) =>
      queue.getJobs(['wait', 'delayed', 'active']),
    );

    // BullMQ's own default is `attempts: 0`, which means no retry at all. A
    // schedule registered without these would lose a whole tick to one
    // connection reset, silently, while an enqueued job beside it was tried
    // eight times.
    expect(tick?.opts.attempts).toBeGreaterThan(1);
    expect(tick?.opts.backoff).toBeDefined();
  });

  it('stamps a tick with the time of the tick, not of the registration', async () => {
    const definition = { ...echo, queue: 'queue-service-schedule-clock' };
    const runner = another();
    const registeredAt = Date.now();
    const seen: string[] = [];

    runner.consume(definition, async (job) => {
      seen.push(job.envelope.requestedAt);
    });

    await sleep(300);
    await runner.schedule(definition, 'clock:every-100ms', { everyMs: 100 }, {
      value: 'tick',
    });

    await until('two ticks have run', () => seen.length >= 2);

    // The template is written once and copied to every tick after it, so its
    // own timestamp reports the age of the schedule — a number that grows
    // without bound and says nothing about the work.
    for (const requestedAt of seen) {
      expect(Date.parse(requestedAt)).toBeGreaterThanOrEqual(registeredAt + 300);
    }
  });

  it('registers a schedule once however many replicas ask for it', async () => {
    const definition = { ...echo, queue: 'queue-service-schedule' };
    const first = another();
    const second = another();

    await first.schedule(definition, 'nightly:every-60s', { everyMs: 60_000 }, {
      value: 'sweep',
    });
    await second.schedule(definition, 'nightly:every-60s', { everyMs: 60_000 }, {
      value: 'sweep',
    });

    // Two replicas both calling this at boot is the normal case, not the
    // exception. Two *services* with two connections, not two calls on one
    // object: the idempotency being tested is Redis's, not this class's.
    expect(await first.listSchedules(definition.queue)).toEqual([
      'nightly:every-60s',
    ]);

    // And one job per tick, which is the property the count above stands for.
    const pending = await inspect(definition.queue, (queue) =>
      queue.getJobs(['wait', 'delayed', 'active']),
    );
    expect(pending).toHaveLength(1);
  });

  it('leaves a schedule it does not claim while that schedule is still due', async () => {
    const definition = { ...echo, queue: 'queue-service-reconcile-live' };
    const service = another();

    await service.schedule(definition, 'ours', { everyMs: 60_000 }, {
      value: 'new',
    });
    await service.schedule(definition, 'theirs', { everyMs: 60_000 }, {
      value: 'from the other half of the deploy',
    });

    await service.reconcileSchedules(definition.queue, ['ours']);

    // "This process does not claim it" is not "nothing claims it". During a
    // rolling deploy the two images disagree about the set of jobs, and a
    // version that deleted whatever it did not recognise would delete the
    // schedule the other version had just registered — over and over, for the
    // length of the rollout.
    expect(await service.listSchedules(definition.queue)).toEqual([
      'ours',
      'theirs',
    ]);
  });

  it('removes one nothing claims that has stopped running', async () => {
    const definition = { ...echo, queue: 'queue-service-reconcile-orphan' };
    const service = another();

    await service.schedule(definition, 'ours', { everyMs: 60_000 }, {
      value: 'new',
    });
    await service.schedule(definition, 'abandoned', { everyMs: 60_000 }, {
      value: 'deleted from the code two deploys ago',
    });

    // A scheduler advances when its job is produced, so one whose job no
    // longer exists is one whose next run has fallen into the past. That is
    // reproduced here by moving it there, because waiting two days is not a
    // test.
    await redis.zadd(
      `bull:${definition.queue}:repeat`,
      String(Date.now() - LONG_ABANDONED_MS),
      'abandoned',
    );

    await service.reconcileSchedules(definition.queue, ['ours']);

    // Without this a recurring job deleted from the code keeps firing: the
    // scheduler lives in Redis, and nothing removes it when the last line that
    // created it is gone.
    expect(await service.listSchedules(definition.queue)).toEqual(['ours']);
  });

  it('refuses an identity containing a colon, which is its own separator', async () => {
    const definition = { ...echo, queue: 'queue-service-colon' };

    // Measured, after a dispatcher built ids as `${eventId}:${endpointId}` and
    // every dispatch failed five times and dead-lettered. BullMQ uses the
    // colon as the separator in its own Redis keys and refuses one in a custom
    // id — and the refusal arrives as a rejected `add`, which a caller that
    // only counts failures reports as "could not enqueue" with no reason.
    //
    // Pinned here so the next caller that builds a composite id learns it from
    // a test rather than from a dead letter.
    await expect(
      service.enqueue(definition, { value: 'x' }, {}, { jobId: 'a:b' }),
    ).rejects.toThrow(/custom id cannot contain/i);

    // The shape that works, and the one the dispatcher uses.
    await expect(
      service.enqueue(definition, { value: 'x' }, {}, { jobId: 'a-b' }),
    ).resolves.toBeUndefined();
  });

  it('refuses a second handler on one queue rather than splitting its jobs', async () => {
    const definition = { ...echo, queue: 'queue-service-one-handler' };
    const runner = another();

    runner.consume(definition, async () => undefined);

    // A BullMQ worker is handed every job on its queue whatever name it was
    // added under, so the second handler would receive the first one's jobs
    // and dead-letter them for a payload mismatch.
    expect(() => runner.consume(definition, async () => undefined)).toThrow(
      /already consumes/,
    );
  });

  it('lets a job in flight finish when it is asked to stop', async () => {
    const definition = { ...echo, queue: 'queue-service-drain' };
    let started = false;
    let finished = false;

    const draining = another();
    draining.consume(definition, async () => {
      started = true;
      await sleep(600);
      finished = true;
    });

    await draining.enqueue(definition, { value: 'in flight' });
    await until('the job has started', () => started);

    // The container is being replaced. Killing here would leave the work
    // half-done and the queue waiting on a stalled check minutes later.
    await draining.drain();

    expect(finished).toBe(true);
  });

  it('gives a job back when the worker holding it is killed', async () => {
    const definition = { ...echo, queue: 'queue-service-killed' };
    let started = false;
    let completedBy = '';

    // A container that dies mid-job. Its Redis connection is severed rather
    // than closed: a drain is the graceful path and this is the other one, so
    // the lock is never renewed and never released.
    const doomedConnection = connection();
    const doomed = new QueueService(doomedConnection);
    doomed.consume(definition, async () => {
      started = true;
      await sleep(JOB_LOCK_MS * 4);
    });

    await doomed.enqueue(definition, { value: 'survives a kill' });
    await until('the doomed worker has started', () => started);
    doomedConnection.disconnect();

    // Its replacement. Nothing hands the job over: the queue notices a lock
    // that was never renewed and makes the job available again. That recovery
    // time is `JOB_LOCK_MS`, which is why it is stated in the service rather
    // than inherited from a library default nobody would find.
    const replacement = another();
    replacement.consume(definition, async (job) => {
      completedBy = job.payload.value;
    });

    await until(
      'the replacement has finished the job',
      () => completedBy !== '',
      JOB_LOCK_MS * 4,
    );

    expect(completedBy).toBe('survives a kill');
  }, JOB_LOCK_MS * 8);

  it('drains before the connection closes, and survives being asked twice', async () => {
    const definition = { ...echo, queue: 'queue-service-drain-twice' };
    const draining = another();
    draining.consume(definition, async () => undefined);

    await draining.onApplicationShutdown();

    // Nest reaches shutdown from a signal handler and from an explicit
    // `app.close()`; closing a worker twice throws.
    await expect(draining.onApplicationShutdown()).resolves.toBeUndefined();
  });
});
