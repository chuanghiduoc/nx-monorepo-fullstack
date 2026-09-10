import {
  POSTGRES_START_TIMEOUT_MS,
  startPostgres,
  type TestPostgres,
} from '@workspace/core-server-testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../prisma.service.js';
import { Database } from './database.js';
import type { TenantContext } from '@workspace/core-server-core';

const org: TenantContext = {
  kind: 'org',
  orgId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  userId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c',
};
const otherOrg: TenantContext = {
  ...org,
  orgId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d',
};
const userOnly: TenantContext = { kind: 'user', userId: org.userId };

const CURRENT_GUCS = `
  SELECT NULLIF(current_setting('app.current_org_id', true), '') AS org,
         NULLIF(current_setting('app.current_user_id', true), '') AS "user"`;

describe('Database', () => {
  let postgres: TestPostgres;
  let prisma: PrismaService;
  let db: Database;

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

  beforeEach(async () => {
    await db.withSystemTransaction(() => db.system().demoItem.deleteMany());
  });

  const readGucs = () =>
    db
      .tenant()
      .$queryRawUnsafe<{ org: string | null; user: string | null }[]>(
        CURRENT_GUCS,
      );

  const allRows = () =>
    db.withSystemTransaction(() => db.system().demoItem.findMany());

  describe('withTenantTransaction', () => {
    it('runs the callback inside a transaction and commits', async () => {
      const created = await db.withTenantTransaction(org, () =>
        db.tenant().demoItem.create({ data: { title: 'committed' } }),
      );

      expect((await allRows()).map((row) => row.id)).toEqual([created.id]);
    });

    it('rolls back everything the callback wrote when it throws', async () => {
      await expect(
        db.withTenantTransaction(org, async () => {
          await db.tenant().demoItem.create({ data: { title: 'rolled back' } });
          throw new Error('business rule failed');
        }),
      ).rejects.toThrow('business rule failed');

      expect(await allRows()).toEqual([]);
    });

    it('sets both tenant GUCs, for the transaction only', async () => {
      const inside = await db.withTenantTransaction(org, readGucs);
      expect(inside).toEqual([{ org: org.orgId, user: org.userId }]);

      // Transaction-local: nothing leaks onto the connection afterwards, which
      // is what makes this safe behind a transaction-mode pooler.
      const after = await db.withSystemTransaction(() =>
        db.system().$queryRawUnsafe<{ org: string | null }[]>(CURRENT_GUCS),
      );
      expect(after).toEqual([{ org: null, user: null }]);
    });

    it('sets only the user GUC for a user-only context', async () => {
      const inside = await db.withTenantTransaction(userOnly, readGucs);

      expect(inside).toEqual([{ org: null, user: org.userId }]);
    });

    it('reuses the active transaction when nested with the same context', async () => {
      await expect(
        db.withTenantTransaction(org, async () => {
          const outer = db.tenant();
          await outer.demoItem.create({ data: { title: 'outer' } });

          await db.withTenantTransaction(org, async () => {
            expect(db.tenant()).toBe(outer);
            await db.tenant().demoItem.create({ data: { title: 'inner' } });
          });

          throw new Error('abort both');
        }),
      ).rejects.toThrow('abort both');

      // One transaction, one rollback: the inner write is gone too.
      expect(await allRows()).toEqual([]);
    });

    it('refuses to change tenant inside an active transaction', async () => {
      await expect(
        db.withTenantTransaction(org, () =>
          db.withTenantTransaction(otherOrg, async () => undefined),
        ),
      ).rejects.toThrow(/different tenant context/);
    });

    it('refuses a system transaction inside a tenant one, and vice versa', async () => {
      await expect(
        db.withTenantTransaction(org, () =>
          db.withSystemTransaction(async () => undefined),
        ),
      ).rejects.toThrow(/different tenant context/);

      await expect(
        db.withSystemTransaction(() =>
          db.withTenantTransaction(org, async () => undefined),
        ),
      ).rejects.toThrow(/different tenant context/);
    });
  });

  describe('tenant() / system()', () => {
    it('throw outside a transaction rather than falling back to the root client', () => {
      // With RLS FORCE a query outside a tenant transaction returns nothing,
      // silently. Throwing is the only honest behaviour.
      expect(() => db.tenant()).toThrow(/no tenant transaction/i);
      expect(() => db.system()).toThrow(/no system transaction/i);
    });

    it('do not hand out the wrong kind of client, and say which is active', async () => {
      // The message matters: "no tenant transaction" while a system one is
      // open sends a reader looking for a missing wrapper instead of the
      // wrong one.
      await db.withSystemTransaction(async () => {
        expect(() => db.tenant()).toThrow(/system transaction is active/i);
      });
      await db.withTenantTransaction(org, async () => {
        expect(() => db.system()).toThrow(/tenant transaction is active/i);
      });
    });
  });

  describe('the root client', () => {
    it('throws when touched while a transaction is active', async () => {
      // The invariant this library exists to hold, enforced at runtime rather
      // than by convention: a query that bypassed the transaction would run on
      // another connection, outside the settings, and the policy would return
      // nothing.
      await db.withTenantTransaction(org, async () => {
        expect(() => prisma.demoItem).toThrow(/root database client/i);
        expect(() => prisma.$queryRaw`SELECT 1`).toThrow(
          /root database client/i,
        );
      });
    });

    it('still works outside a transaction, which is how connections are managed', async () => {
      await expect(prisma.$queryRaw`SELECT 1 AS one`).resolves.toEqual([
        { one: 1 },
      ]);
    });
  });

  it('does not leak a transaction into concurrent, unrelated work', async () => {
    // Two callers in flight at once must each see their own context.
    const seen = await Promise.all([
      db.withTenantTransaction(org, async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return readGucs();
      }),
      db.withTenantTransaction(otherOrg, readGucs),
    ]);

    expect(seen.map(([row]) => row.org)).toEqual([org.orgId, otherOrg.orgId]);
  });
});
