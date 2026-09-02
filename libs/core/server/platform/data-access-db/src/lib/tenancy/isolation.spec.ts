import {
  POSTGRES_START_TIMEOUT_MS,
  startPostgres,
  type TestPostgres,
} from '@workspace/core-server-testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../prisma.service.js';
import { Database } from '../transaction/database.js';

const ORG_A = '0199a1b2-0000-7000-8000-00000000000a';
const ORG_B = '0199a1b2-0000-7000-8000-00000000000b';
const USER_A = '0199a1b2-0000-7000-8000-0000000000aa';
const USER_B = '0199a1b2-0000-7000-8000-0000000000bb';

const asOrgA = { kind: 'org', orgId: ORG_A, userId: USER_A } as const;
const asOrgB = { kind: 'org', orgId: ORG_B, userId: USER_B } as const;
const asUserA = { kind: 'user', userId: USER_A } as const;

/**
 * What the database does when the application is wrong.
 *
 * Every assertion here runs on the `app_user` connection, which row-level
 * security can bind — as a superuser they would all pass with no policy in
 * place at all. `rls-harness.spec.ts` proves that property separately and
 * first.
 *
 * Nothing in these tests goes through the guard extension or any application
 * check: they seed rows as the owner and read them as the application, so a
 * pass means the policy did the work.
 */
describe('tenant isolation', () => {
  let postgres: TestPostgres;
  let prisma: PrismaService;
  let db: Database;

  beforeAll(async () => {
    postgres = await startPostgres();
    prisma = new PrismaService();
    await prisma.$connect();
    db = new Database(prisma);
  }, POSTGRES_START_TIMEOUT_MS);

  afterAll(async () => {
    await prisma?.$disconnect();
    await postgres?.stop();
  });

  beforeEach(async () => {
    // Seeded through the owner connection: the application role cannot write
    // another organization's rows, which is the very thing being tested.
    await seedAsOwner(postgres.migrationUri);
  });

  describe('a tenant-owned table', () => {
    it('shows an organization only its own rows', async () => {
      const seen = await db.withTenantTransaction(asOrgA, () =>
        db.tenant().note.findMany({ orderBy: { title: 'asc' } }),
      );

      expect(seen.map((note) => note.title)).toEqual(["A's note"]);
    });

    it('shows the other organization only its own', async () => {
      const seen = await db.withTenantTransaction(asOrgB, () =>
        db.tenant().note.findMany(),
      );

      expect(seen.map((note) => note.title)).toEqual(["B's note"]);
    });

    it('hides everything from a user acting outside any organization', async () => {
      const seen = await db.withTenantTransaction(asUserA, () =>
        db.tenant().note.findMany(),
      );

      expect(seen).toEqual([]);
    });

    it('refuses to write a row into another organization', async () => {
      // The policy applies to what is written, not only to what is read: a
      // check constraint on the way in is what stops a compromised or buggy
      // service from planting rows in someone else's tenant.
      const forged = db.withTenantTransaction(asOrgA, () =>
        db.tenant().note.create({
          data: { orgId: ORG_B, title: 'planted', body: 'x' },
        }),
      );

      await expect(forged).rejects.toThrow();
    });

    it('cannot reach another organization by asking for it explicitly', async () => {
      const seen = await db.withTenantTransaction(asOrgA, () =>
        db.tenant().note.findMany({ where: { orgId: ORG_B } }),
      );

      // Not an error — simply nothing. The row is invisible, so a `where` on
      // it matches nothing.
      expect(seen).toEqual([]);
    });

    it('returns nothing at all when no tenant context is set', async () => {
      // Through raw SQL, which the guard does not cover, because the point is
      // what the *database* does: with no tenant GUC the policy matches no
      // row and the query succeeds with an empty result.
      const seen = await db.withSystemTransaction(() =>
        db.system().$queryRawUnsafe<{ id: string }[]>('SELECT id FROM notes'),
      );

      expect(seen).toEqual([]);
    });

    it('is refused before it can be silent, when reached through a model', async () => {
      // The same mistake through the model path. Silence reads exactly like an
      // empty table, so the accessor refuses instead.
      const refused = db.withSystemTransaction(() => db.system().note.findMany());

      await expect(refused).rejects.toThrow(/belongs to a tenant/i);
    });
  });

  describe('a tenant-optional table', () => {
    it('shows an organization its rows, and not a personal one', async () => {
      const seen = await db.withTenantTransaction(asOrgA, () =>
        db.tenant().bookmark.findMany({ orderBy: { label: 'asc' } }),
      );

      expect(seen.map((b) => b.label)).toEqual(["A's org bookmark"]);
    });

    it('shows a user their own rows when no organization is active', async () => {
      const seen = await db.withTenantTransaction(asUserA, () =>
        db.tenant().bookmark.findMany(),
      );

      expect(seen.map((b) => b.label)).toEqual(["A's personal bookmark"]);
    });

    it('does not show one person’s rows to another', async () => {
      // The trap the second policy branch exists for: `org_id IS NULL OR
      // org_id = current` would hand every personal row to everyone.
      const seen = await db.withTenantTransaction(
        { kind: 'user', userId: USER_B },
        () => db.tenant().bookmark.findMany(),
      );

      expect(seen.map((b) => b.label)).toEqual(["B's personal bookmark"]);
    });
  });

  describe('global data', () => {
    it('is visible whatever the tenant', async () => {
      const fromA = await db.withTenantTransaction(asOrgA, () =>
        db.tenant().demoItem.count(),
      );
      const fromSystem = await db.withSystemTransaction(() =>
        db.system().demoItem.count(),
      );

      expect(fromA).toBe(fromSystem);
      expect(fromA).toBeGreaterThan(0);
    });
  });
});

/**
 * Seeds both tenants through the owner connection.
 *
 * The application role deliberately cannot do this — it may only write rows
 * its own policy admits — so the fixture uses the connection migrations run
 * on.
 */
async function seedAsOwner(migrationUri: string): Promise<void> {
  const { Client } = await import('pg');
  const owner = new Client({ connectionString: migrationUri });
  await owner.connect();

  try {
    await owner.query('DELETE FROM notes');
    await owner.query('DELETE FROM bookmarks');
    await owner.query('DELETE FROM demo_items');

    await owner.query(
      `INSERT INTO notes (org_id, title, body) VALUES ($1, $2, 'x'), ($3, $4, 'x')`,
      [ORG_A, "A's note", ORG_B, "B's note"],
    );
    await owner.query(
      `INSERT INTO bookmarks (org_id, user_id, url, label)
       VALUES ($1, $2, 'https://example.test', $3),
              (NULL, $2, 'https://example.test', $4),
              (NULL, $5, 'https://example.test', $6)`,
      [
        ORG_A,
        USER_A,
        "A's org bookmark",
        "A's personal bookmark",
        USER_B,
        "B's personal bookmark",
      ],
    );
    await owner.query(`INSERT INTO demo_items (title) VALUES ('everyone sees this')`);
  } finally {
    await owner.end();
  }
}
