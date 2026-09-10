import { Client } from 'pg';
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

const SUITE_TIMEOUT_MS = 300_000;

/**
 * A connection that dies, in the two places it actually dies.
 *
 * `failure.spec.ts` forces its SQLSTATEs with `RAISE EXCEPTION ... USING
 * ERRCODE`, which is always a statement-level error and always arrives as
 * `P2010` with `meta`. It therefore never produced the two shapes below, and
 * both classified as "nobody knows" — five attempts over about fifteen seconds
 * and then a permanent dead letter.
 *
 * That is not a slow retry. By the time the audit consumer runs, its outbox
 * row is already `ENQUEUED`: `claimPending` looks only at `PENDING` and
 * `reclaimStale` only at `PROCESSING`, so nothing ever looks at it again and
 * the sweep removes it at the end of the retention window. A rolling database
 * restart — the exact thing this classification exists for — silently emptied
 * the audit trail of everything in flight.
 *
 * These kill a real backend rather than describing one.
 */
describe('a connection that goes away', () => {
  let postgres: TestPostgres;
  let prisma: PrismaService;
  let db: Database;
  let owner: Client;

  /** Ends this client's backend from another connection, the way a restart does. */
  const killOurBackend = async (): Promise<void> => {
    // `pg_stat_activity` gives every backend on the database; the suite's own
    // connection is the one running as `app_user`.
    await owner.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = current_database()
          AND usename = 'app_user'
          AND pid <> pg_backend_pid()`,
    );
  };

  beforeAll(async () => {
    postgres = await startPostgres();
    prisma = new PrismaService('DATABASE_URL', 'DATABASE_POOL_MAX');
    await prisma.$connect();
    db = new Database(prisma);

    owner = new Client({ connectionString: postgres.migrationUri });
    await owner.connect();
  }, POSTGRES_START_TIMEOUT_MS);

  afterAll(async () => {
    await owner?.end();
    await prisma?.$disconnect();
    await postgres?.stop();
  });

  it(
    'asks again when the backend dies between two statements',
    async () => {
      const failure = await db
        .withTenantTransaction(CONTEXT, async () => {
          await db.tenant().$executeRawUnsafe('SELECT 1');
          await killOurBackend();
          // Idle when it died, so there is no `ErrorResponse` to carry a
          // SQLSTATE: the driver throws a bare `Error` with no `code` and no
          // `meta`, and only its message says what happened.
          await db.tenant().$executeRawUnsafe('SELECT 2');
        })
        .catch((error: unknown) => error);

      expect(classifyFailure(failure)).toBe('retryable');
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'asks again when the backend dies with the transaction open',
    async () => {
      const failure = await db
        .withTenantTransaction(CONTEXT, async () => {
          await db.tenant().$executeRawUnsafe(
            `INSERT INTO notes (id, org_id, title, body)
             VALUES (gen_random_uuid(), '${CONTEXT.orgId}'::uuid, 'a', 'b')`,
          );
          await killOurBackend();
        })
        .catch((error: unknown) => error);

      // The commit is what fails here rather than a statement, which is the
      // shape with no `code` and no `meta` at all.
      expect(classifyFailure(failure)).toBe('retryable');
    },
    SUITE_TIMEOUT_MS,
  );

  it('still leaves an application error alone', async () => {
    // Its own client, because the tests above deliberately killed this
    // database's backends and the pool above is still recovering from that.
    // Sharing one would test the recovery rather than the classification, and
    // it would pass or fail depending on the order the file happens to run in.
    const healthy = new PrismaService('DATABASE_URL', 'DATABASE_POOL_MAX');
    await healthy.$connect();
    const healthyDb = new Database(healthy);

    try {
      const failure = await healthyDb
        .withTenantTransaction(CONTEXT, async () => {
          throw Object.assign(new Error('not found'), { status: 404 });
        })
        .catch((error: unknown) => error);

      // Reading a message to recognise a dead connection is a last resort, and
      // the risk it carries is relabelling something it should not. A 404 is
      // still fatal.
      expect((failure as { retryable?: unknown }).retryable).toBeUndefined();
      expect(classifyFailure(failure)).toBe('fatal');
    } finally {
      await healthy.$disconnect();
    }
  });
});
