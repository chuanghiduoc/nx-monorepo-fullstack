import { Client } from 'pg';
import {
  POSTGRES_START_TIMEOUT_MS,
  startPostgres,
  type TestPostgres,
} from '@workspace/core-server-testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { TenantScopedContext } from '@workspace/core-server-core';

import { PrismaService } from '../prisma.service.js';
import { Database } from '../transaction/database.js';
import { QuotaRepository } from './quota.repository.js';

const ORG = '0199a1b2-0000-7000-8000-00000000000a';
const OTHER_ORG = '0199a1b2-0000-7000-8000-00000000000b';
const USER = '0199a1b2-0000-7000-8000-0000000000aa';

const CONTEXT: TenantScopedContext = {
  kind: 'org',
  orgId: ORG,
  userId: USER,
};
const OTHER_CONTEXT: TenantScopedContext = {
  kind: 'org',
  orgId: OTHER_ORG,
  userId: USER,
};

const ENTITLEMENT = 'notes';
const LIMIT = 10;

/**
 * Quota, against a real PostgreSQL and under the real grants and policies.
 *
 * Two clients, because the two halves run as different roles and that is what
 * the whole isolation argument rests on: a request consumes as `app_user`,
 * bound by the tenant policy, and the sweep expires reservations as
 * `worker_user`, which has a policy of its own precisely so it can see across
 * tenants without holding BYPASSRLS.
 */
/** More than the limit, so the refusals are part of what is measured. */
const CONCURRENT_ATTEMPTS = 25;

describe('quota', () => {
  let postgres: TestPostgres;
  let owner: Client;
  let asApp: PrismaService;
  let asWorker: PrismaService;
  let appDb: Database;
  let workerDb: Database;
  let quota: QuotaRepository;

  const consume = (amount: number, limit = LIMIT, context = CONTEXT) =>
    appDb.withTenantTransaction(context, () =>
      quota.consume({
        entitlement: ENTITLEMENT,
        window: 'monthly',
        limit,
        amount,
      }),
    );

  const record = (amount: number, context = CONTEXT) =>
    appDb.withTenantTransaction(context, () =>
      quota.record({ entitlement: ENTITLEMENT, window: 'monthly', amount }),
    );

  const usage = (context = CONTEXT) =>
    appDb.withTenantTransaction(context, () =>
      quota.usage(ENTITLEMENT, 'monthly'),
    );

  beforeAll(async () => {
    postgres = await startPostgres();
    process.env['WORKER_DATABASE_URL'] = postgres.workerUri;

    // Wider than the shipped default, and it is the concurrency test that
    // needs it: twenty-five transactions against a pool of ten are ten running
    // and fifteen queued, which measures the pool rather than the statement.
    //
    // Measured as a flake first — `Unable to start a transaction in the given
    // time`, once, inside a full `pnpm verify` where every other suite was
    // competing for the machine, and never when this suite ran alone. Raising
    // the pool makes the twenty-five genuinely concurrent, which is both the
    // fix and a stronger version of the property being tested.
    process.env['DATABASE_POOL_MAX'] = '30';

    // Neither role holds DELETE on these tables — that is the point of the
    // grants — so the cleanup between tests goes through the owner.
    owner = new Client({ connectionString: postgres.migrationUri });
    await owner.connect();

    asApp = new PrismaService('DATABASE_URL', 'DATABASE_POOL_MAX');
    asWorker = new PrismaService(
      'WORKER_DATABASE_URL',
      'WORKER_DATABASE_POOL_MAX',
    );
    await Promise.all([asApp.$connect(), asWorker.$connect()]);

    appDb = new Database(asApp);
    workerDb = new Database(asWorker);
    quota = new QuotaRepository();
  }, POSTGRES_START_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.all([asApp?.$disconnect(), asWorker?.$disconnect()]);
    await owner?.end();
    await postgres?.stop();
  });

  beforeEach(async () => {
    await owner.query('DELETE FROM quota_reservations');
    await owner.query('DELETE FROM org_quota_counters');
  });

  describe('consuming', () => {
    it('takes the first unit of a window nobody has used yet', async () => {
      // The defect the design started with: a plain conditional UPDATE creates
      // no row, so the first consume of every entitlement, for every
      // organization, in every window, would look like "over quota" — a new
      // tenant refused its first note, and every tenant refused on the first
      // of the month.
      expect(await consume(1)).toBe(true);
      expect(await usage()).toBe(1);
    });

    it('allows the unit that reaches the limit exactly', async () => {
      await consume(9);

      // `used + n <= limit`, pinned. A limit of ten permits the tenth unit,
      // and this is the kind of boundary a refactor flips without noticing.
      expect(await consume(1)).toBe(true);
      expect(await usage()).toBe(10);
    });

    it('refuses the unit after that, and changes nothing', async () => {
      await consume(10);

      expect(await consume(1)).toBe(false);
      expect(await usage()).toBe(10);
    });

    it('refuses an amount larger than the whole limit without raising', async () => {
      // The second defect: an upsert whose `WHERE` only guards the update path
      // inserts this row unconditionally, and the CHECK then raises 23514
      // inside the caller's transaction — rolling back the business write. The
      // same business situation must not be a refusal on one path and a 500 on
      // the other.
      expect(await consume(99)).toBe(false);
      expect(await usage()).toBe(0);
    });

    it('keeps refusing after the limit is lowered below what was used', async () => {
      await consume(8);

      // The third defect: a CHECK of `used <= limit` made this fail with a
      // constraint violation, which is to say it made downgrading a plan
      // impossible for exactly the tenants who do it. Refusing is right;
      // raising is not.
      expect(await consume(1, 5)).toBe(false);
      expect(await usage()).toBe(8);
    });

    it('never oversells under concurrency', async () => {
      // More attempts than the limit, and all of them at once. The pool is
      // sized above this in `beforeAll` so that they really are concurrent:
      // transactions waiting for a connection prove nothing about a race.
      const attempts = await Promise.all(
        Array.from({ length: CONCURRENT_ATTEMPTS }, () => consume(1)),
      );

      // Check-then-insert would let two transactions both read `used = 9` and
      // both commit. The conditional upsert takes the row lock itself, so
      // READ COMMITTED is enough.
      expect(attempts.filter(Boolean)).toHaveLength(LIMIT);
      expect(await usage()).toBe(LIMIT);
    });

    it('counts each organization separately', async () => {
      await consume(10);

      expect(await consume(1, LIMIT, OTHER_CONTEXT)).toBe(true);
      expect(await usage(OTHER_CONTEXT)).toBe(1);
      expect(await usage()).toBe(10);
    });

    it('rolls back with the transaction that consumed', async () => {
      await appDb
        .withTenantTransaction(CONTEXT, async () => {
          await quota.consume({
            entitlement: ENTITLEMENT,
            window: 'monthly',
            limit: LIMIT,
            amount: 4,
          });
          throw new Error('the business write failed');
        })
        .catch(() => undefined);

      // The whole reason the counter is a table and not a Redis key: the units
      // and the thing they paid for commit or roll back together.
      expect(await usage()).toBe(0);
    });

    it('refuses to run outside a transaction, and says what to do', async () => {
      await expect(
        quota.consume({
          entitlement: ENTITLEMENT,
          window: 'monthly',
          limit: LIMIT,
          amount: 1,
        }),
      ).rejects.toThrow(/withTenantTransaction/);
    });
  });

  describe('recording what was already spent', () => {
    it('creates the counter on the first record of a window', async () => {
      await record(1_340);

      expect(await usage()).toBe(1_340);
    });

    it('adds to a counter another path created', async () => {
      await consume(3);
      await record(7);

      // One counter, whichever way the units arrived. Two would mean a ceiling
      // that sees half the usage.
      expect(await usage()).toBe(10);
    });

    it('records units that take the counter past any ceiling', async () => {
      await consume(10);

      // The whole difference from `consume`. The tokens a completion turned
      // out to use were spent before anyone could refuse them, and dropping
      // the count because it went over loses it in exactly the case where it
      // matters most.
      await record(5_000);

      expect(await usage()).toBe(5_010);
    });

    it('loses neither of two increments under concurrency', async () => {
      await Promise.all(
        Array.from({ length: CONCURRENT_ATTEMPTS }, () => record(4)),
      );

      // A read followed by a write would lose some of these; one statement
      // takes the row lock itself.
      expect(await usage()).toBe(CONCURRENT_ATTEMPTS * 4);
    });

    it('counts each organization separately', async () => {
      await record(50);
      await record(7, OTHER_CONTEXT);

      expect(await usage()).toBe(50);
      expect(await usage(OTHER_CONTEXT)).toBe(7);
    });
  });

  describe('reserving', () => {
    const reserve = (amount: number, expiresInMs = 60_000) =>
      appDb.withTenantTransaction(CONTEXT, () =>
        quota.reserve({
          entitlement: ENTITLEMENT,
          window: 'monthly',
          limit: LIMIT,
          amount,
          expiresAt: new Date(Date.now() + expiresInMs),
        }),
      );

    it('takes the units the moment the reservation exists', async () => {
      const id = await reserve(4);

      // Not "when it commits": a reservation that did not charge is a promise
      // the counter cannot keep, and two concurrent reservations for six units
      // each against a limit of ten would both succeed.
      expect(id).not.toBeNull();
      expect(await usage()).toBe(4);
    });

    it('refuses a reservation that does not fit, and creates nothing', async () => {
      await consume(8);

      expect(await reserve(4)).toBeNull();
      expect(await usage()).toBe(8);
      expect(await reservationCount()).toBe(0);
    });

    it('leaves the units taken when the reservation is committed', async () => {
      const id = await reserve(4);

      expect(
        await appDb.withTenantTransaction(CONTEXT, () =>
          quota.commit(id as string),
        ),
      ).toBe(true);
      expect(await usage()).toBe(4);
    });

    it('gives the units back when it is released', async () => {
      const id = await reserve(4);

      expect(
        await appDb.withTenantTransaction(CONTEXT, () =>
          quota.release(id as string),
        ),
      ).toBe(true);
      expect(await usage()).toBe(0);
    });

    it('gives them back once, however many times release is called', async () => {
      const id = await reserve(4);

      const first = await appDb.withTenantTransaction(CONTEXT, () =>
        quota.release(id as string),
      );
      const second = await appDb.withTenantTransaction(CONTEXT, () =>
        quota.release(id as string),
      );

      // Idempotent through the state machine rather than a flag: the update
      // moves a row only from RESERVED, so a retried release refunds once and
      // reports honestly that the second call changed nothing.
      expect([first, second]).toEqual([true, false]);
      expect(await usage()).toBe(0);
    });

    it('will not release something already committed', async () => {
      const id = await reserve(4);
      await appDb.withTenantTransaction(CONTEXT, () =>
        quota.commit(id as string),
      );

      expect(
        await appDb.withTenantTransaction(CONTEXT, () =>
          quota.release(id as string),
        ),
      ).toBe(false);
      expect(await usage()).toBe(4);
    });

    it('refunds the window it charged, not the window it ended in', async () => {
      const id = await reserve(4);

      // A job that started on the 31st and failed on the 1st. The reservation
      // carries its own `window_start` for exactly this: refunding "the
      // current window" would credit a month that was never charged, and leave
      // the charged one permanently short.
      await asWorker.$executeRawUnsafe(
        `UPDATE quota_reservations SET window_start = window_start - interval '1 month' WHERE id = $1::uuid`,
        id,
      );
      await asWorker.$executeRawUnsafe(
        `UPDATE org_quota_counters SET window_start = window_start - interval '1 month' WHERE org_id = $1::uuid`,
        ORG,
      );

      await appDb.withTenantTransaction(CONTEXT, () =>
        quota.release(id as string),
      );

      const [row] = await asWorker.$queryRawUnsafe<{ used: bigint }[]>(
        'SELECT used FROM org_quota_counters WHERE org_id = $1::uuid',
        ORG,
      );
      expect(Number(row?.used ?? -1)).toBe(0);
    });
  });

  describe('expiring what was never settled', () => {
    it('returns the units of an overdue reservation', async () => {
      const id = await appDb.withTenantTransaction(CONTEXT, () =>
        quota.reserve({
          entitlement: ENTITLEMENT,
          window: 'monthly',
          limit: LIMIT,
          amount: 6,
          expiresAt: new Date(Date.now() - 1_000),
        }),
      );

      const swept = await workerDb.withSystemTransaction(() =>
        quota.sweepExpired(100),
      );

      expect(swept).toBe(1);
      expect(await usage()).toBe(0);
      expect(await stateOf(id as string)).toBe('EXPIRED');
    });

    it('leaves a reservation that has not expired alone', async () => {
      await appDb.withTenantTransaction(CONTEXT, () =>
        quota.reserve({
          entitlement: ENTITLEMENT,
          window: 'monthly',
          limit: LIMIT,
          amount: 6,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      );

      expect(
        await workerDb.withSystemTransaction(() => quota.sweepExpired(100)),
      ).toBe(0);
      expect(await usage()).toBe(6);
    });

    it('does not expire one that was already settled', async () => {
      const id = await appDb.withTenantTransaction(CONTEXT, () =>
        quota.reserve({
          entitlement: ENTITLEMENT,
          window: 'monthly',
          limit: LIMIT,
          amount: 6,
          expiresAt: new Date(Date.now() - 1_000),
        }),
      );
      await appDb.withTenantTransaction(CONTEXT, () =>
        quota.release(id as string),
      );

      // Expiring a released reservation would refund it a second time, and the
      // counter would drift below what was actually consumed — which the
      // non-negative CHECK would eventually turn into a failed request for
      // somebody else entirely.
      expect(
        await workerDb.withSystemTransaction(() => quota.sweepExpired(100)),
      ).toBe(0);
      expect(await usage()).toBe(0);
    });

    it('sweeps across tenants without a tenant context', async () => {
      await appDb.withTenantTransaction(CONTEXT, () =>
        quota.reserve({
          entitlement: ENTITLEMENT,
          window: 'monthly',
          limit: LIMIT,
          amount: 6,
          expiresAt: new Date(Date.now() - 1_000),
        }),
      );
      await appDb.withTenantTransaction(OTHER_CONTEXT, () =>
        quota.reserve({
          entitlement: ENTITLEMENT,
          window: 'monthly',
          limit: LIMIT,
          amount: 6,
          expiresAt: new Date(Date.now() - 1_000),
        }),
      );

      // The reason these tables are TENANT_OWNED with a second policy rather
      // than SYSTEM: the sweeper sees every tenant because a policy names its
      // role, not because the table gave up on policies altogether.
      expect(
        await workerDb.withSystemTransaction(() => quota.sweepExpired(100)),
      ).toBe(2);
      expect(await usage()).toBe(0);
      expect(await usage(OTHER_CONTEXT)).toBe(0);
    });

    it('returns every unit when several expire against one counter', async () => {
      for (let i = 0; i < 3; i += 1) {
        await appDb.withTenantTransaction(CONTEXT, () =>
          quota.reserve({
            entitlement: ENTITLEMENT,
            window: 'monthly',
            limit: LIMIT,
            amount: 2,
            expiresAt: new Date(Date.now() - 1_000),
          }),
        );
      }
      expect(await usage()).toBe(6);

      // PostgreSQL updates a target row at most once per statement. Written as
      // a plain join, this refunded two units instead of six and marked all
      // three reservations EXPIRED — four units gone, with nothing anywhere
      // reporting it, until the tenant hit a limit it was nowhere near.
      expect(
        await workerDb.withSystemTransaction(() => quota.sweepExpired(100)),
      ).toBe(3);
      expect(await usage()).toBe(0);
    });

    it('takes no more than the batch it was asked for', async () => {
      for (let i = 0; i < 3; i += 1) {
        await appDb.withTenantTransaction(CONTEXT, () =>
          quota.reserve({
            entitlement: ENTITLEMENT,
            window: 'monthly',
            limit: 100,
            amount: 1,
            expiresAt: new Date(Date.now() - 1_000),
          }),
        );
      }

      expect(
        await workerDb.withSystemTransaction(() => quota.sweepExpired(2)),
      ).toBe(2);
    });
  });

  describe('what a tenant may reach', () => {
    it('cannot see another organization’s counter', async () => {
      await consume(3, LIMIT, OTHER_CONTEXT);

      // Row-level security, not a WHERE clause the repository remembered to
      // write. These tables are TENANT_OWNED for this reason: as SYSTEM they
      // would carry no policy at all, and `app_user` needs INSERT, SELECT and
      // UPDATE here to consume.
      expect(await usage()).toBe(0);
    });

    it('cannot write into another organization’s counter', async () => {
      await consume(3, LIMIT, OTHER_CONTEXT);

      const touched = await appDb.withTenantTransaction(CONTEXT, () =>
        appDb
          .tenant()
          .$executeRawUnsafe(
            'UPDATE org_quota_counters SET used = 0 WHERE org_id = $1::uuid',
            OTHER_ORG,
          ),
      );

      expect(touched).toBe(0);
      expect(await usage(OTHER_CONTEXT)).toBe(3);
    });

    it('gives each role exactly the rights it needs and no others', async () => {
      const rows = await asWorker.$queryRawUnsafe<
        { role: string; tbl: string; privs: string | null }[]
      >(`
        WITH r(role) AS (VALUES ('app_user'),('worker_user'),('cross_tenant_admin_role')),
             t(tbl)  AS (VALUES ('org_quota_counters'),('quota_reservations')),
             p(priv) AS (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'))
        SELECT role, tbl,
               string_agg(priv, ',' ORDER BY priv)
                 FILTER (WHERE has_table_privilege(role, tbl, priv)) AS privs
          FROM r, t, p GROUP BY role, tbl ORDER BY role, tbl`);

      // No DELETE anywhere: the right to delete a counter is the right to
      // reset a quota to zero, and a settled reservation is the record that
      // its units came back. The worker never creates either.
      expect(
        Object.fromEntries(
          rows.map((row) => [`${row.role}:${row.tbl}`, row.privs]),
        ),
      ).toEqual({
        'app_user:org_quota_counters': 'INSERT,SELECT,UPDATE',
        'app_user:quota_reservations': 'INSERT,SELECT,UPDATE',
        'cross_tenant_admin_role:org_quota_counters': null,
        'cross_tenant_admin_role:quota_reservations': null,
        'worker_user:org_quota_counters': 'SELECT,UPDATE',
        'worker_user:quota_reservations': 'SELECT,UPDATE',
      });
    });
  });

  /** Counts every reservation, as the role a policy lets across tenants. */
  const reservationCount = async (): Promise<number> => {
    const [row] = await asWorker.$queryRawUnsafe<{ n: bigint }[]>(
      'SELECT count(*) AS n FROM quota_reservations',
    );
    return Number(row?.n ?? 0);
  };

  const stateOf = async (id: string): Promise<string | undefined> => {
    const [row] = await asWorker.$queryRawUnsafe<{ state: string }[]>(
      'SELECT state FROM quota_reservations WHERE id = $1::uuid',
      id,
    );
    return row?.state;
  };
});
