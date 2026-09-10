import { Client } from 'pg';
import { Redis } from 'ioredis';
import { Test, type TestingModule } from '@nestjs/testing';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { Logger } from '@nestjs/common';

import type { WorkerConfig } from '@workspace/core-server-core';
import { QueueService } from '@workspace/core-server-queue';
import {
  Database,
  DatabaseModule,
  OutboxRepository,
  ProcessedEventRepository,
} from '@workspace/core-server-data-access-db';
import { startPostgres, type TestPostgres } from '@workspace/core-server-testing';

import { OutboxRelay } from './outbox.relay.js';
import { outboxDelivery, webhookDispatch } from './outbox.job.js';

const REDIS_IMAGE = 'redis:8-alpine';
const REDIS_PORT = 6379;
const SUITE_TIMEOUT_MS = 300_000;
const DEADLINE_MS = 15_000;
const POLL_MS = 25;

const ORG = '0199a1b2-0000-7000-8000-00000000000a';
const USER = '0199a1b2-0000-7000-8000-0000000000aa';
const NOTE = '0199a1b2-0000-7000-8000-0000000000cc';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(
  describe: string,
  condition: () => Promise<boolean> | boolean,
): Promise<void> {
  const giveUpAt = Date.now() + DEADLINE_MS;

  for (;;) {
    if (await condition()) return;
    if (Date.now() > giveUpAt) {
      throw new Error(`Timed out waiting until ${describe}.`);
    }
    await sleep(POLL_MS);
  }
}

/**
 * The settings the relay reads.
 *
 * A stand-in rather than a real `WorkerConfig`, which would mean validating a
 * whole environment to change two numbers — and every key it can ask for is
 * listed, so a setting added later fails here loudly instead of arriving as
 * `undefined`.
 */
function settings(overrides: Record<string, number> = {}): WorkerConfig {
  const values: Record<string, number> = {
    OUTBOX_POLL_MS: 50,
    OUTBOX_BATCH: 10,
    // The lease has to outlast the enqueue it covers, and the relay now
    // refuses a configuration where it does not.
    OUTBOX_LEASE_MS: 5_000,
    OUTBOX_ENQUEUE_TIMEOUT_MS: 1_000,
    // Positive, because `env.schema.ts` requires it — a test that configured
    // the relay in a state the real schema forbids would be exercising a
    // relay nobody can deploy. One millisecond is due by the time the pass
    // reaches the gate, so it still runs every time.
    OUTBOX_RECLAIM_MS: 1,
    OUTBOX_SWEEP_EVERY_MS: 1,
    OUTBOX_SWEEP_BATCHES: 2,
    OUTBOX_MAX_ATTEMPTS: 3,
    OUTBOX_RETENTION_HOURS: 168,
    ...overrides,
  };

  return {
    get(key: string): number {
      const value = values[key];
      if (value === undefined) {
        throw new Error(
          `The relay asked for ${key}, which this test does not set.`,
        );
      }
      return value;
    },
  } as unknown as WorkerConfig;
}

/**
 * The relay, against a real database and a real queue.
 *
 * Driven a pass at a time rather than through its timer: what matters is what
 * one pass does to the rows and to the queue, and a suite that watched a timer
 * would be measuring sleeps.
 */
describe('the outbox relay', () => {
  let postgres: TestPostgres;
  let redisContainer: StartedTestContainer;
  let owner: Client;
  let moduleRef: TestingModule;
  let db: Database;
  let outbox: OutboxRepository;
  let processed: ProcessedEventRepository;
  let queue: QueueService;
  let redis: Redis;
  const consumed: string[] = [];
  const tenants: string[] = [];

  /**
   * Seeds an event as the owner rather than through `append()`.
   *
   * `append()` runs as `app_user`, which is the only role granted INSERT here,
   * and it is covered by the repository's own suite. This file is about what
   * the relay does with a row once it exists.
   */
  const seed = async (count = 1): Promise<void> => {
    for (let index = 0; index < count; index += 1) {
      await owner.query(
        `INSERT INTO outbox_events
           (aggregate_type, aggregate_id, aggregate_version, event_type, payload, tenant_id, actor_id)
         VALUES ('note', $1::uuid, 1, 'note.created', $2::jsonb, $3::uuid, $4::uuid)`,
        [
          NOTE,
          JSON.stringify({ noteId: NOTE, orgId: ORG, titleLength: 5, bodyLength: 9 }),
          ORG,
          USER,
        ],
      );
    }
  };

  const countBy = async (status: string): Promise<number> => {
    const result = await owner.query<{ n: string }>(
      'SELECT count(*) AS n FROM outbox_events WHERE status = $1',
      [status],
    );
    return Number(result.rows[0]?.n ?? 0);
  };

  const relayWith = (overrides?: Record<string, number>): OutboxRelay =>
    new OutboxRelay(db, outbox, processed, queue, settings(overrides));

  beforeAll(async () => {
    [postgres, redisContainer] = await Promise.all([
      startPostgres(),
      new GenericContainer(REDIS_IMAGE)
        .withCommand(['redis-server', '--maxmemory-policy', 'noeviction'])
        .withExposedPorts(REDIS_PORT)
        .withWaitStrategy(Wait.forListeningPorts())
        .start(),
    ]);

    process.env['WORKER_DATABASE_URL'] = postgres.workerUri;

    owner = new Client({ connectionString: postgres.migrationUri });
    await owner.connect();

    // The sanctioned way to a database handle: the root client stays inside
    // the module, and this test sees `Database` and the repository, the same
    // two things the relay does.
    moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule.forRoot('WORKER_DATABASE_URL', 'WORKER_DATABASE_POOL_MAX')],
    }).compile();
    await moduleRef.init();

    db = moduleRef.get(Database);
    outbox = moduleRef.get(OutboxRepository);
    processed = moduleRef.get(ProcessedEventRepository);

    const connection = {
      host: redisContainer.getHost(),
      port: redisContainer.getMappedPort(REDIS_PORT),
      maxRetriesPerRequest: null,
    } as const;

    redis = new Redis(connection);
    queue = new QueueService(new Redis(connection));

    // The relay refuses to fill a queue nothing drains, so the suite is what
    // drains it. Registered once: a worker takes every job on its queue, and
    // `consume` refuses a second registration for the same one.
    queue.consume(outboxDelivery, async (job) => {
      consumed.push(job.payload.eventId);
      if (job.envelope.tenantId) {
        tenants.push(job.envelope.tenantId);
      }
    });

    // The relay fans out across every queue in `OUTBOX_CONSUMERS` and refuses
    // to deliver while any of them has nobody draining it, so the suite drains
    // this one too. What it does with the job does not matter here; that it
    // exists does.
    queue.consume(webhookDispatch, async () => undefined);
  }, SUITE_TIMEOUT_MS);

  afterAll(async () => {
    await queue?.onApplicationShutdown();
    redis?.disconnect();
    await moduleRef?.close();
    await owner?.end();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
  });

  beforeEach(async () => {
    await owner.query('DELETE FROM outbox_events');
    consumed.length = 0;
    tenants.length = 0;
  });

  it('delivers a pending event and records that it went', async () => {
    await seed();

    const run = await relayWith().runOnce();

    expect(run.delivered).toBe(1);
    expect(await countBy('ENQUEUED')).toBe(1);

    // And it reaches a consumer, under the event's own id — which is what
    // makes a reclaimed re-enqueue a no-op while the job is still there.
    const [eventId] = (
      await owner.query<{ event_id: string }>('SELECT event_id FROM outbox_events')
    ).rows.map((row) => row.event_id);

    await until('the consumer has seen it', () => consumed.includes(eventId));
  });

  it('carries the tenant to the job, because that is what opens the transaction', async () => {
    await seed();
    await relayWith().runOnce();

    // Without it the consumer has no tenant to scope its reads to, and a job
    // that reads nothing looks exactly like a bug in the query.
    await until('a tenant has reached the consumer', () => tenants.length > 0);
    expect(tenants[0]).toBe(ORG);
  });

  it('takes nothing when there is nothing to take', async () => {
    const run = await relayWith().runOnce();

    expect(run).toMatchObject({ delivered: 0, failed: 0 });
  });

  it('backs a failed delivery off rather than draining the outbox into PROCESSING', async () => {
    await seed(3);

    // A queue whose Redis is gone. The claim is a database operation and keeps
    // working, which is exactly the trap: a relay that read "a full batch" as
    // a reason to run again would take every pending row to PROCESSING as fast
    // as the database could answer.
    const unreachable = new QueueService(
      new Redis({ host: '127.0.0.1', port: 1, maxRetriesPerRequest: null, lazyConnect: true }),
    );
    // A consumer is registered on it, so the relay's "is anything draining
    // this?" check passes and the failure under test is the enqueue itself.
    // Constructing a worker against a dead Redis is fine — it connects lazily.
    unreachable.consume(outboxDelivery, async () => undefined);
    unreachable.consume(webhookDispatch, async () => undefined);

    const failing = new OutboxRelay(
      db,
      outbox,
      processed,
      unreachable,
      settings({ OUTBOX_ENQUEUE_TIMEOUT_MS: 300 }),
    );

    // What a person watching the logs would see. Before this line existed the
    // answer was nothing at all: the first message was "Giving up on ..."
    // after ten attempts with growing backoff — about thirteen and a half
    // minutes of an unreachable queue with the reason only in a database
    // column. Measured, on 300 events: eighteen lines of output, all INFO.
    const warnings: string[] = [];
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((message: unknown) => {
        warnings.push(String(message));
      });

    const run = await failing.runOnce();
    warn.mockRestore();
    await unreachable.onApplicationShutdown().catch(() => undefined);

    expect(run.failed).toBe(3);
    expect(run.delivered).toBe(0);

    expect(
      warnings.some((line) => /could not be enqueued/.test(line)),
      `expected a warning naming the failure, got: ${warnings.join(' | ')}`,
    ).toBe(true);

    // Back to PENDING with a future due time, not stranded in PROCESSING.
    expect(await countBy('PROCESSING')).toBe(0);
    expect(await countBy('PENDING')).toBe(3);

    const next = await relayWith().runOnce();
    expect(next.delivered).toBe(0);
  });

  it('gives up on an event whose attempts are spent, and says so', async () => {
    await seed();
    await owner.query(
      `UPDATE outbox_events SET status='PROCESSING', attempts=3,
              locked_at = now() - interval '1 hour'`,
    );

    const run = await relayWith().runOnce();

    // Its relay stopped while holding it and there are no attempts left. The
    // row has to end somewhere a person can find it, not sit in PROCESSING.
    expect(run.died).toBe(1);
    expect(await countBy('DEAD')).toBe(1);
  });

  it('takes back an event whose relay stopped holding it', async () => {
    await seed();
    await owner.query(
      `UPDATE outbox_events SET status='PROCESSING', attempts=1,
              locked_at = now() - interval '1 hour'`,
    );

    const run = await relayWith().runOnce();

    // The window between "enqueue" and "record that we enqueued" is what this
    // closes; the job id makes the re-delivery harmless.
    expect(run.reclaimed).toBe(1);
    expect(run.delivered).toBe(1);
    expect(await countBy('ENQUEUED')).toBe(1);
  });

  it('removes delivered events past the window and keeps dead ones', async () => {
    await seed(2);
    await owner.query(
      `UPDATE outbox_events SET status='ENQUEUED', enqueued_at = now() - interval '400 hours'`,
    );
    await owner.query(
      `UPDATE outbox_events SET status='DEAD'
        WHERE event_id IN (SELECT event_id FROM outbox_events LIMIT 1)`,
    );

    const run = await relayWith().runOnce();

    expect(run.swept).toBe(1);
    expect(await countBy('DEAD')).toBe(1);
  });

  it('stops without leaving a pass in flight', async () => {
    await seed(2);
    const running = relayWith();

    try {
      running.onApplicationBootstrap();
      await until(
        'the relay has delivered',
        async () => (await countBy('ENQUEUED')) === 2,
      );
    } finally {
      // In `finally`, because a timeout above would otherwise leave the relay
      // polling through the next test's cleanup and past `afterAll`.
      await running.stop();
    }

    // Nothing may still be claiming when the database client disconnects.
    const before = await countBy('PENDING');
    await seed();
    await sleep(200);

    expect(await countBy('PENDING')).toBe(before + 1);
  });

  it('delivers when the consumer is in another process', async () => {
    await seed(2);

    // This `QueueService` consumes nothing. The suite's own does, on the same
    // Redis, which is what a deployment running the audit consumer and the
    // webhook dispatcher as separate replicas looks like from either side.
    //
    // The check used to ask "does *this process* consume it", so each replica
    // saw a queue it did not drain locally and stopped delivering to it — for
    // a consumer running perfectly well next door. It asks Redis now.
    const orphaned = new QueueService(
      new Redis({
        host: redisContainer.getHost(),
        port: redisContainer.getMappedPort(REDIS_PORT),
        maxRetriesPerRequest: null,
      }),
    );

    try {
      const run = await new OutboxRelay(
        db,
        outbox,
        processed,
        orphaned,
        settings(),
      ).runOnce();

      expect(run.delivered).toBe(2);
      expect(await countBy('ENQUEUED')).toBe(2);
    } finally {
      await orphaned.onApplicationShutdown();
    }
  });

  it('will not fill a queue nothing anywhere drains', async () => {
    await seed(2);

    // A Redis of its own, and it has to be: BullMQ answers "who is consuming
    // this queue" from `CLIENT LIST`, which is per **server** and not per
    // database — selecting `db: 1` on the shared one still saw the suite's own
    // workers. Measured, when this test was written that way and delivered
    // two events it should have refused.
    const empty = await new GenericContainer(REDIS_IMAGE)
      .withCommand(['redis-server', '--maxmemory-policy', 'noeviction'])
      .withExposedPorts(REDIS_PORT)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();

    const nowhere = new QueueService(
      new Redis({
        host: empty.getHost(),
        port: empty.getMappedPort(REDIS_PORT),
        maxRetriesPerRequest: null,
      }),
    );

    try {
      const run = await new OutboxRelay(
        db,
        outbox,
        processed,
        nowhere,
        settings(),
      ).runOnce();

      // Delivering into a queue nothing drains would leave the jobs on the
      // Redis configured never to evict, until it refused writes and took
      // every other queue with it. The events are exactly as durable where
      // they are.
      expect(run.delivered).toBe(0);
      expect(await countBy('PENDING')).toBe(2);
    } finally {
      await nowhere.onApplicationShutdown();
      await empty.stop();
    }
  });

  it('marks a reclaimed batch and a fresh batch under their own tokens', async () => {
    await seed(1);
    await owner.query(
      `UPDATE outbox_events SET status='PROCESSING', attempts=1,
              locked_at = now() - interval '1 hour'`,
    );
    await seed(1);

    // One pass holding two claims: the reclaimed row carries the lock this
    // pass gave it, the fresh row carries a different one. Marked under a
    // single token, one of the two groups would be fenced out and left in
    // PROCESSING to be delivered all over again.
    const run = await relayWith().runOnce();

    expect(run.reclaimed).toBe(1);
    expect(run.delivered).toBe(2);
    expect(await countBy('ENQUEUED')).toBe(2);
    expect(await countBy('PROCESSING')).toBe(0);
  });

  it('refuses a lease shorter than the enqueue it has to cover', () => {
    // An enqueue may take OUTBOX_ENQUEUE_TIMEOUT_MS, so a shorter lease
    // expires while one is still in flight — every slow delivery reclaimed and
    // sent twice, with nothing in the log to say why.
    expect(() =>
      relayWith({
        OUTBOX_LEASE_MS: 5_000,
        OUTBOX_ENQUEUE_TIMEOUT_MS: 10_000,
      }).onApplicationBootstrap(),
    ).toThrow(/outlast the enqueue/);
  });

  it('refuses to sweep more slowly than it delivers', () => {
    // Every delivered event becomes a row the sweep has to take. Below the
    // delivery rate the outbox grows without bound inside its own retention
    // window, and replicas do not help because they raise both sides.
    expect(() =>
      relayWith({
        OUTBOX_BATCH: 1_000,
        OUTBOX_POLL_MS: 1_000,
        OUTBOX_SWEEP_BATCHES: 1,
        OUTBOX_SWEEP_EVERY_MS: 60_000,
      }).onApplicationBootstrap(),
    ).toThrow(/grow[\s\S]*without bound/);
  });

  it('refuses a lease that outlives the queue deduplication window', () => {
    // Past that window a reclaim's re-enqueue is a real second delivery rather
    // than a silently ignored one. Correct, because the consumer is
    // idempotent — but it means the job id has quietly stopped doing anything.
    expect(() =>
      relayWith({ OUTBOX_LEASE_MS: queue.dedupWindowMs + 1 }).onApplicationBootstrap(),
    ).toThrow(/deduplication window/);
  });
});
