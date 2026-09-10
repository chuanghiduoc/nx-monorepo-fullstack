import {
  PGBOUNCER_DATABASE_ALIAS,
  PGBOUNCER_START_TIMEOUT_MS,
  createNetwork,
  startPgBouncer,
  startPostgres,
  type StartedNetwork,
  type TestPgBouncer,
  type TestPostgres,
} from '@workspace/core-server-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../prisma.service.js';
import { Database } from '../transaction/database.js';

const ORG_A = '0199a1b2-0000-7000-8000-0000000000e1';
const ORG_B = '0199a1b2-0000-7000-8000-0000000000e2';
const USER_A = '0199a1b2-0000-7000-8000-0000000000f1';
const USER_B = '0199a1b2-0000-7000-8000-0000000000f2';

const asOrgA = { kind: 'org', orgId: ORG_A, userId: USER_A } as const;
const asOrgB = { kind: 'org', orgId: ORG_B, userId: USER_B } as const;

/**
 * The tenant setting, through a connection pooler in transaction mode.
 *
 * This is the deployment shape the transaction contract assumes, and the one
 * where the assumption could be wrong. In transaction mode a server connection
 * goes back to the pool at every `COMMIT`, so two organizations are routinely
 * served by the same connection one after another. A session-level `SET` would
 * survive that hand-off and the second organization would inherit the first's
 * tenant — reading rows it must never see, with every policy still in place
 * and doing exactly what it was told.
 *
 * The pooler is given a single server connection on purpose. Sharing one is
 * what makes a leak observable; a pool large enough to give each client its
 * own would hide the very thing under test.
 */
describe('the tenant setting behind a transaction-mode pooler', () => {
  let network: StartedNetwork;
  let postgres: TestPostgres;
  let pooler: TestPgBouncer;
  let prisma: PrismaService;
  let db: Database;

  beforeAll(async () => {
    network = await createNetwork();
    postgres = await startPostgres({
      network,
      networkAlias: PGBOUNCER_DATABASE_ALIAS,
    });

    pooler = await startPgBouncer(network, {
      database: postgres.database,
      user: postgres.appUser,
      password: postgres.appPassword,
    });

    await seedAsOwner(postgres.migrationUri);

    // Everything below talks to the pooler, never to the database directly.
    process.env['DATABASE_URL'] = pooler.connectionUri;
    prisma = new PrismaService('DATABASE_URL', 'DATABASE_POOL_MAX');
    await prisma.$connect();
    db = new Database(prisma);
  }, PGBOUNCER_START_TIMEOUT_MS);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pooler?.stop();
    await postgres?.stop();
    await network?.stop();
  });

  it('serves each organization only its own rows', async () => {
    const seenByA = await db.withTenantTransaction(asOrgA, () =>
      db.tenant().note.findMany({ orderBy: { title: 'asc' } }),
    );

    expect(seenByA.map((note) => note.title)).toEqual(["A's note"]);
  });

  it('does not carry one organization into the next transaction', async () => {
    // Back to back on purpose. With a single server connection these two run
    // on the same one, which is exactly the hand-off that would leak.
    await db.withTenantTransaction(asOrgA, () =>
      db.tenant().note.findMany(),
    );

    const seenByB = await db.withTenantTransaction(asOrgB, () =>
      db.tenant().note.findMany({ orderBy: { title: 'asc' } }),
    );

    expect(seenByB.map((note) => note.title)).toEqual(["B's note"]);
  });

  it('leaves no tenant behind once a transaction ends', async () => {
    await db.withTenantTransaction(asOrgA, () => db.tenant().note.findMany());

    // Read on a fresh transaction with no tenant set. `set_config(..., true)`
    // is discarded at commit, so this is empty — a session-level `SET` would
    // return organization A's value here.
    const [{ leaked }] = await db.withSystemTransaction(() =>
      db
        .system()
        .$queryRaw<{ leaked: string | null }[]>`
          SELECT NULLIF(current_setting('app.current_org_id', true), '') AS leaked
        `,
    );

    expect(leaked).toBeNull();
  });

  it('keeps two interleaved organizations apart', async () => {
    // Started together rather than in sequence: whichever order the pooler
    // hands out its one connection, neither may see the other's rows.
    const [fromA, fromB] = await Promise.all([
      db.withTenantTransaction(asOrgA, () =>
        db.tenant().note.findMany({ orderBy: { title: 'asc' } }),
      ),
      db.withTenantTransaction(asOrgB, () =>
        db.tenant().note.findMany({ orderBy: { title: 'asc' } }),
      ),
    ]);

    expect(fromA.map((note) => note.title)).toEqual(["A's note"]);
    expect(fromB.map((note) => note.title)).toEqual(["B's note"]);
  });
});

/**
 * Seeded through the owner connection, straight to the database: the
 * application role cannot write another organization's rows, which is the
 * property being tested.
 */
async function seedAsOwner(ownerUri: string): Promise<void> {
  const { Client } = await import('pg');
  const owner = new Client({ connectionString: ownerUri });
  await owner.connect();

  try {
    await owner.query('DELETE FROM notes');
    await owner.query(
      `INSERT INTO notes (id, org_id, title, body, version)
       VALUES (uuidv7(), $1::uuid, $2, '', 1),
              (uuidv7(), $3::uuid, $4, '', 1)`,
      [ORG_A, "A's note", ORG_B, "B's note"],
    );
  } finally {
    await owner.end();
  }
}
