import {
  POSTGRES_START_TIMEOUT_MS,
  startPostgres,
  type TestPostgres,
} from '@workspace/core-server-testing';
import { classifyFailure } from '@workspace/core-server-queue';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../prisma.service.js';
import { Database } from './database.js';

const CONTEXT = {
  kind: 'org',
  orgId: '0199a1b2-0000-7000-8000-00000000000a',
  userId: '0199a1b2-0000-7000-8000-0000000000aa',
} as const;

/**
 * How a database failure reaches the queue.
 *
 * Against a real PostgreSQL and the real driver, because the whole finding is
 * about the *shape* of what Prisma produces — a hand-written object carrying
 * the properties this code hopes for would prove nothing. Measured before this
 * existed: a unique violation, a missing column, a permission denial and an
 * administrator shutdown all arrive as `PrismaClientKnownRequestError` with
 * `code: 'P2010'`, so `error.code` cannot tell them apart and every one of
 * them classified as "nobody knows" — five attempts and then a permanent dead
 * letter, for a database that was merely restarting.
 *
 * The value that discriminates is the SQLSTATE the driver kept underneath:
 * `meta.driverAdapterError.cause.originalCode`.
 */
describe('classifying what the database threw', () => {
  let postgres: TestPostgres;
  let prisma: PrismaService;
  let db: Database;

  /**
   * Runs a statement the way a repository does — through the transaction
   * client, not the root one, which the guard refuses while a transaction is
   * open — and hands back whatever it threw.
   */
  const failureFrom = async (sql: string): Promise<unknown> => {
    try {
      await db.withTenantTransaction(CONTEXT, () =>
        db.tenant().$executeRawUnsafe(sql),
      );
    } catch (failure) {
      return failure;
    }

    throw new Error(`Expected ${sql} to fail.`);
  };

  beforeAll(async () => {
    postgres = await startPostgres();
    prisma = new PrismaService('DATABASE_URL', 'DATABASE_POOL_MAX');
    await prisma.$connect();
    db = new Database(prisma);
  }, POSTGRES_START_TIMEOUT_MS);

  afterAll(async () => {
    await prisma?.$disconnect();
    await postgres?.stop();
  });

  it('gives up on a constraint the same statement will violate again', async () => {
    // 23505, through a table the application role may actually write.
    const id = '0199a1b2-0000-7000-8000-0000000000c1';
    await db.withTenantTransaction(CONTEXT, () =>
      db.tenant().$executeRawUnsafe(
        `INSERT INTO notes (id, org_id, title, body) VALUES ($1::uuid, $2::uuid, 'a', 'b')`,
        id,
        CONTEXT.orgId,
      ),
    );

    const failure = await failureFrom(
      `INSERT INTO notes (id, org_id, title, body) VALUES ('${id}'::uuid, '${CONTEXT.orgId}'::uuid, 'a', 'b')`,
    );

    // Retrying a duplicate key eight times changes nothing about the answer
    // and delays the dead letter a person has to read.
    expect(classifyFailure(failure)).toBe('fatal');
  });

  it('gives up on a statement this role is not allowed to run', async () => {
    // 42501. A permission denial is a deployment fact, not a transient one:
    // the grant does not appear because we asked again.
    const failure = await failureFrom('SELECT event_id FROM outbox_events');

    expect(classifyFailure(failure)).toBe('fatal');
  });

  it('gives up on a statement that names something that is not there', async () => {
    // 42703. A column that does not exist is a deploy that has not run or a
    // bug; neither is fixed by waiting.
    const failure = await failureFrom('SELECT no_such_column FROM notes');

    expect(classifyFailure(failure)).toBe('fatal');
  });

  it('waits for a database that is still starting up', async () => {
    // 57P03, raised rather than caused: taking the container down mid-suite
    // would tear down the pool and every other test with it, and what is
    // under test is the classification of a SQLSTATE, not PostgreSQL's
    // ability to emit it. A rolling restart is the case this exists for —
    // without it a thirty-second window dead-letters everything inside it,
    // permanently, for a database that came back.
    const failure = await failureFrom(
      `DO $$ BEGIN RAISE EXCEPTION 'the database system is starting up' USING ERRCODE = '57P03'; END $$`,
    );

    expect(classifyFailure(failure)).toBe('retryable');
  });

  it('waits out a serialisation failure rather than giving up on it', async () => {
    // 40001. The one every concurrent writer meets eventually, and the one
    // whose whole remedy is running the transaction again.
    const failure = await failureFrom(
      `DO $$ BEGIN RAISE EXCEPTION 'could not serialize access' USING ERRCODE = '40001'; END $$`,
    );

    expect(classifyFailure(failure)).toBe('retryable');
  });

  it('leaves an error it has never seen unclassified rather than guessing', () => {
    // The honest answer for anything the sets do not name: retried to a
    // ceiling and then given to a person, rather than spun on or discarded.
    expect(classifyFailure(new Error('something else entirely'))).toBe(
      'unknown',
    );
  });

  it('does not relabel an error the application raised', async () => {
    const failure = await db
      .withTenantTransaction(CONTEXT, async () => {
        throw Object.assign(new Error('not found'), { status: 404 });
      })
      .catch((error: unknown) => error);

    // Annotating everything would turn a 404 a repository raises into a
    // verdict about the transport. It passes through untouched, and the
    // existing status-based classification still applies.
    expect((failure as { retryable?: unknown }).retryable).toBeUndefined();
    expect(classifyFailure(failure)).toBe('fatal');
  });

  it('prefers fatal when an error somehow claims both', () => {
    // The branch order, pinned: `fatal` is a claim about the shape of the
    // message, and no amount of retrying changes a shape. The natural place to
    // add a new branch is the top of the function, which is why this is a test
    // and not a comment.
    expect(classifyFailure({ fatal: true, retryable: true })).toBe('fatal');
    expect(classifyFailure({ retryable: true })).toBe('retryable');
  });
});
