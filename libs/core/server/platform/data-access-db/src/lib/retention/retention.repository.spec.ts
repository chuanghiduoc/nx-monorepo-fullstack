import {
  POSTGRES_START_TIMEOUT_MS,
  startPostgres,
  type TestPostgres,
} from '@workspace/core-server-testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../prisma.service.js';
import { SWEEP_BATCH } from './retention.repository.js';
import { Database } from '../transaction/database.js';
import { RetentionRepository } from './retention.repository.js';

const HOUR_MS = 60 * 60 * 1_000;
const RETENTION_HOURS = 24;

/** How long the stand-in for another replica holds its rows. */
const HELD_MS = 2_000;
const HOLD_TIMEOUT_MS = 15_000;

/**
 * Enough rows that the planner has a real choice to make.
 *
 * Below a few hundred pages a sequential scan is the cheapest plan for
 * everything, so a smaller table would report that the two forms are
 * equivalent — a true statement about a table nobody has.
 */
const PLAN_ROWS = 500_000;

/** Seeding half a million rows and planning three queries is not a unit test. */
const PLAN_TIMEOUT_MS = 180_000;


/**
 * The most rows any node in a plan produced.
 *
 * A plan that sorts reports the sort's full input here, which is what makes it
 * the number to look at: it is the one a `LIMIT` above a sort cannot reduce.
 */
/** How many pages a plan's top node touched. */
function pagesRead(planText: string): number {
  const line = /shared hit=(\d+)(?: read=(\d+))?/.exec(planText);

  if (!line) {
    throw new Error(`No buffer counts in the plan:\n${planText}`);
  }

  return Number(line[1]) + Number(line[2] ?? 0);
}

function returnedRows(planText: string): number {
  const counts = [...planText.matchAll(/actual rows=(\d+(?:\.\d+)?)/g)].map(
    ([, value]) => Number(value),
  );

  return Math.max(...counts);
}

const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);

/**
 * The sweep, against a real PostgreSQL.
 *
 * `FOR UPDATE SKIP LOCKED`, the re-checked predicate and the interaction
 * between two concurrent transactions are all properties of the database.
 * Nothing here can be established against a double.
 */
describe('the retention sweep', () => {
  let postgres: TestPostgres;
  let prisma: PrismaService;
  let db: Database;
  let retention: RetentionRepository;

  const sweepSessions = () =>
    db.withSystemTransaction(() => retention.sweepExpiredSessions());
  const sweepVerifications = () =>
    db.withSystemTransaction(() => retention.sweepExpiredVerifications());
  const sweepIdempotency = (hours = RETENTION_HOURS) =>
    db.withSystemTransaction(() => retention.sweepIdempotencyRecords(hours));

  /** The plan a query actually ran under, as text. */
  const plan = async (sql: string): Promise<string> => {
    const rows = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
      `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) ${sql}`,
    );

    return rows.map((row) => row['QUERY PLAN']).join('\n');
  };

  const aUser = async (email: string) =>
    prisma.user.create({
      data: { email, name: 'Someone', emailVerified: false },
    });

  beforeAll(async () => {
    postgres = await startPostgres();
    prisma = new PrismaService('DATABASE_URL', 'DATABASE_POOL_MAX');
    await prisma.$connect();
    db = new Database(prisma);
    retention = new RetentionRepository(db);
  }, POSTGRES_START_TIMEOUT_MS);

  afterAll(async () => {
    await prisma?.$disconnect();
    await postgres?.stop();
  });

  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.verification.deleteMany();
    await prisma.idempotencyRecord.deleteMany();
    await prisma.user.deleteMany();
  });

  it('deletes an expired session and leaves a live one', async () => {
    const user = await aUser('expired@example.com');

    await prisma.session.createMany({
      data: [
        { token: 'stale', userId: user.id, expiresAt: ago(HOUR_MS) },
        { token: 'live', userId: user.id, expiresAt: ahead(HOUR_MS) },
      ],
    });

    expect(await sweepSessions()).toBe(1);
    expect(await prisma.session.findMany({ select: { token: true } })).toEqual([
      { token: 'live' },
    ]);
  });

  it('leaves a session a request renewed while the sweep was running', async () => {
    const user = await aUser('renewed@example.com');
    const session = await prisma.session.create({
      data: { token: 'renewed', userId: user.id, expiresAt: ago(HOUR_MS) },
    });

    // The sweep selects the row, and a request slides its expiry forward
    // before the delete commits. Somebody who was using the application is
    // then signed out, with nothing in any log to say why.
    //
    // Reproduced by taking the row's lock first, so the sweep has to wait for
    // the renewal to commit and then decide again. Measured: this deletes the
    // renewed session if *both* the `FOR UPDATE` and the repeated predicate
    // are removed, and neither one alone.
    const renewal = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "session" WHERE id = ${session.id}::uuid FOR UPDATE`;
      await new Promise((resolve) => setTimeout(resolve, 200));
      await tx.$executeRaw`UPDATE "session" SET expires_at = now() + interval '1 hour' WHERE id = ${session.id}::uuid`;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const [, deleted] = await Promise.all([renewal, sweepSessions()]);

    expect(deleted).toBe(0);
    expect(await prisma.session.count()).toBe(1);
  });

  it('deletes an expired verification token and leaves a live one', async () => {
    await prisma.verification.createMany({
      data: [
        { identifier: 'a@example.com', value: 'old', expiresAt: ago(HOUR_MS) },
        { identifier: 'b@example.com', value: 'new', expiresAt: ahead(HOUR_MS) },
      ],
    });

    expect(await sweepVerifications()).toBe(1);
    expect(
      await prisma.verification.findMany({ select: { value: true } }),
    ).toEqual([{ value: 'new' }]);
  });

  it('deletes a finished idempotency record once its window has passed', async () => {
    await prisma.idempotencyRecord.createMany({
      data: [
        {
          scopeType: 'USER',
          scopeId: 'u1',
          route: 'POST:/api/v1/notes',
          idempotencyKey: 'old',
          requestHash: 'h',
          state: 'COMPLETED',
          leaseUntil: ago(48 * HOUR_MS),
          completedAt: ago(48 * HOUR_MS),
        },
        {
          scopeType: 'USER',
          scopeId: 'u1',
          route: 'POST:/api/v1/notes',
          idempotencyKey: 'recent',
          requestHash: 'h',
          state: 'COMPLETED',
          leaseUntil: ago(HOUR_MS),
          completedAt: ago(HOUR_MS),
        },
      ],
    });

    expect(await sweepIdempotency()).toBe(1);
    expect(
      await prisma.idempotencyRecord.findMany({
        select: { idempotencyKey: true },
      }),
    ).toEqual([{ idempotencyKey: 'recent' }]);
  });

  it('deletes a record whose process died before it could finish', async () => {
    // `complete()` and `fail()` both stamp completed_at; a process that died
    // mid-claim stamps neither, so this row's completed_at stays NULL for
    // ever. A sweep that looked only at completed_at would leak exactly the
    // rows nobody is coming back for.
    await prisma.idempotencyRecord.create({
      data: {
        scopeType: 'ORG',
        scopeId: 'o1',
        route: 'POST:/api/v1/notes',
        idempotencyKey: 'abandoned',
        requestHash: 'h',
        state: 'PROCESSING',
        leaseUntil: ago(48 * HOUR_MS),
      },
    });

    expect(await sweepIdempotency()).toBe(1);
    expect(await prisma.idempotencyRecord.count()).toBe(0);
  });

  it('leaves a claim that is still in its lease', async () => {
    await prisma.idempotencyRecord.create({
      data: {
        scopeType: 'ORG',
        scopeId: 'o1',
        route: 'POST:/api/v1/notes',
        idempotencyKey: 'working',
        requestHash: 'h',
        state: 'PROCESSING',
        leaseUntil: ahead(HOUR_MS),
      },
    });

    // Deleting this would reset the fence token, and the attempt still holding
    // it could then overwrite a response a later caller had already been given.
    expect(await sweepIdempotency()).toBe(0);
    expect(await prisma.idempotencyRecord.count()).toBe(1);
  });

  it('stops at the batch size rather than holding one long transaction', async () => {
    const user = await aUser('many@example.com');
    await prisma.session.createMany({
      data: Array.from({ length: 5 }, (_unused, index) => ({
        token: `stale-${index}`,
        userId: user.id,
        expiresAt: ago(HOUR_MS),
      })),
    });

    const first = await db.withSystemTransaction(() =>
      retention.sweepExpiredSessions(2),
    );

    expect(first).toBe(2);
    expect(await prisma.session.count()).toBe(3);
  });

  it('reads a batch of idempotency records, not every row that qualifies', async () => {
    // The bound on a batch bounds what is deleted and locked. It bounds what
    // is *read* only if the scan can stop, and adding an `ORDER BY` the index
    // cannot supply is what stops it from stopping: the sort has to see every
    // qualifying row before it yields the first.
    //
    // Seeded through SQL rather than the client, and at half a million rows,
    // because below roughly this size the table is a few hundred pages and a
    // sequential scan is the cheapest plan for everything — a measurement
    // there would be a measurement of the seed, not of the query.
    await prisma.$executeRawUnsafe(`
      INSERT INTO idempotency_records
        (scope_type, scope_id, route, idempotency_key, request_hash, state,
         lease_until, completed_at)
      SELECT 'USER', 'u' || g, 'POST:/api/v1/notes', 'plan-' || g, 'h',
             CASE WHEN g % 200 = 0 THEN 'COMPLETED' ELSE 'PROCESSING' END,
             CASE WHEN g % 200 = 1 THEN now() - interval '48 hours'
                  ELSE now() + interval '1 hour' END,
             CASE WHEN g % 200 = 0 THEN now() - interval '48 hours'
                  ELSE NULL END
      FROM generate_series(1, ${PLAN_ROWS}) g`);

    await prisma.$executeRawUnsafe('ANALYZE "idempotency_records"');

    // The same predicate the repository uses, with and without an ordering,
    // so the comparison is between the two shapes rather than between two
    // queries that happen to be nearby.
    const cutoff = ago(24 * HOUR_MS).toISOString();
    const predicate = `completed_at < '${cutoff}'
       OR (completed_at IS NULL AND lease_until < '${cutoff}')`;

    const asWritten = await plan(
      `SELECT id FROM "idempotency_records" WHERE ${predicate} LIMIT ${SWEEP_BATCH}`,
    );
    const ordered = await plan(
      `SELECT id FROM "idempotency_records" WHERE ${predicate}
        ORDER BY id LIMIT ${SWEEP_BATCH}`,
    );

    // Nothing sorts. Which scan the planner picks depends on the table and is
    // its business; that no node has to see every qualifying row before the
    // first one comes back is not — it is the difference between a batch that
    // bounds work and one that only bounds deletions.
    expect(asWritten).not.toContain('Sort');
    expect(returnedRows(asWritten)).toBe(SWEEP_BATCH);

    // And the ordering costs more, whichever way the planner satisfies it.
    expect(pagesRead(asWritten)).toBeLessThan(pagesRead(ordered));
  }, PLAN_TIMEOUT_MS);

  it('takes the rows another sweep has not locked, without waiting for it', async () => {
    const user = await aUser('concurrent@example.com');
    await prisma.session.createMany({
      data: Array.from({ length: 6 }, (_unused, index) => ({
        token: `stale-${index}`,
        userId: user.id,
        expiresAt: ago(HOUR_MS),
      })),
    });

    // Two replicas sweeping on the same schedule is the normal case, not the
    // exception. The other replica is played by a transaction that locks half
    // the rows and holds them, because two calls raced with Promise.all do not
    // reliably overlap — they are as likely to run one after the other, and
    // then the test passes whatever the statement does.
    let stillHolding = true;
    const other = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM "session" WHERE expires_at < now()
           ORDER BY expires_at LIMIT 3 FOR UPDATE`;
        await new Promise((resolve) => setTimeout(resolve, HELD_MS));
        stillHolding = false;
      },
      { timeout: HOLD_TIMEOUT_MS },
    );

    await new Promise((resolve) => setTimeout(resolve, 200));
    const deleted = await db.withSystemTransaction(() =>
      retention.sweepExpiredSessions(6),
    );

    // Without SKIP LOCKED this call blocks until the other transaction
    // commits, which is a sweep that looks healthy while doing none of the
    // work its schedule assumes it does.
    expect(stillHolding).toBe(true);
    expect(deleted).toBe(3);

    await other;
    expect(await prisma.session.count()).toBe(3);
  });
});
