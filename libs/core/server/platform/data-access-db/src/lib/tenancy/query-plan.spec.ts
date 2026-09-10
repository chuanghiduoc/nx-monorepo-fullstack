import {
  POSTGRES_START_TIMEOUT_MS,
  startPostgres,
  type TestPostgres,
} from '@workspace/core-server-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../prisma.service.js';
import { Database } from '../transaction/database.js';

const ORG_A = '0199a1b2-0000-7000-8000-0000000000c1';
const ORG_B = '0199a1b2-0000-7000-8000-0000000000c2';
const USER_A = '0199a1b2-0000-7000-8000-0000000000d1';

const asOrgA = { kind: 'org', orgId: ORG_A, userId: USER_A } as const;

/** Enough rows that the planner has a reason to prefer an index. */
const ROWS_PER_ORG = 60_000;
const PAGE_SIZE = 20;

/** Seeding and planning over 120k rows is slower than a unit test. */
const SEED_TIMEOUT_MS = 240_000;

/**
 * How the database answers the listing query at a realistic size.
 *
 * On a ten-row table the planner picks a sequential scan whatever the index
 * says, so a plan recorded there is evidence of nothing. This seeds two
 * organizations with sixty thousand rows each, runs `ANALYZE`, and asserts
 * against the plan the policy and the index actually produce.
 *
 * The point is not the timing. It is that the row-level policy adds an
 * `org_id` predicate to every plan, so an index that does not lead with
 * `org_id` cannot serve it — and that the page is read from the index rather
 * than found by filtering the other organization's rows away.
 */
describe('the plan for a tenant-scoped listing', () => {
  let postgres: TestPostgres;
  let prisma: PrismaService;
  let db: Database;
  let plan: string;

  beforeAll(async () => {
    postgres = await startPostgres();
    prisma = new PrismaService('DATABASE_URL', 'DATABASE_POOL_MAX');
    await prisma.$connect();
    db = new Database(prisma);

    await seed(postgres.migrationUri);
    plan = await explainListing(db);
  }, SEED_TIMEOUT_MS + POSTGRES_START_TIMEOUT_MS);

  afterAll(async () => {
    await prisma?.$disconnect();
    await postgres?.stop();
  });

  it('reads the page from an index rather than scanning the table', () => {
    expect(plan).toMatch(/Index Scan|Index Only Scan/);
    expect(plan).not.toMatch(/Seq Scan on notes/);
  });

  it('uses the index that leads with the organization', () => {
    // The policy puts `org_id` in front of every query whether the caller
    // wrote it or not, so an index ordered any other way is unusable here.
    expect(plan).toMatch(/notes_org_id_created_at_id_idx/);
  });

  it('discards nothing: the index answers the question, the filter does not', () => {
    // A non-zero count would mean the database read another organization's
    // rows and then threw them away — correct, but paying for every row in
    // the table on every page.
    const removed = [...plan.matchAll(/Rows Removed by Filter: (\d+)/g)].map(
      (match) => Number(match[1]),
    );

    expect(removed.every((count) => count === 0)).toBe(true);
  });

  it('reads a page worth of rows, not a table worth', () => {
    const scanned = /actual time=[\d.]+\.\.[\d.]+ rows=([\d.]+)/.exec(plan)?.[1];

    expect(Number(scanned)).toBeLessThanOrEqual(PAGE_SIZE);
  });
});

/**
 * Written as one statement per organization through the owner connection: the
 * application role cannot write another organization's rows, which is the
 * property the rest of this suite exists to prove.
 */
async function seed(ownerUri: string): Promise<void> {
  const { Client } = await import('pg');
  const owner = new Client({ connectionString: ownerUri });
  await owner.connect();

  try {
    await owner.query('DELETE FROM notes');

    for (const org of [ORG_A, ORG_B]) {
      await owner.query(
        `INSERT INTO notes (id, org_id, title, body, version, created_at, updated_at)
         SELECT uuidv7(),
                $1::uuid,
                'note ' || generated,
                '',
                1,
                now() - (generated || ' seconds')::interval,
                now()
         FROM generate_series(1, $2::int) AS generated`,
        [org, ROWS_PER_ORG],
      );
    }

    // Without this the planner is working from the statistics of an empty
    // table, and every plan it produces is a guess.
    await owner.query('ANALYZE notes');
  } finally {
    await owner.end();
  }
}

/** The first page of the listing, exactly as the repository asks for it. */
function explainListing(db: Database): Promise<string> {
  return db.withTenantTransaction(asOrgA, async () => {
    const rows = await db.tenant().$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
      `EXPLAIN (ANALYZE, BUFFERS)
       SELECT id, title, body, version, created_at, updated_at
       FROM notes
       ORDER BY created_at DESC, id DESC
       LIMIT ${PAGE_SIZE}`,
    );

    return rows.map((row) => row['QUERY PLAN']).join('\n');
  });
}
