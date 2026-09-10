import { Client } from 'pg';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  Database,
  DatabaseModule,
} from '@workspace/core-server-data-access-db';
import type { TenantScopedContext } from '@workspace/core-server-core';
import { startPostgres, type TestPostgres } from '@workspace/core-server-testing';

import { FeatureFlags } from './feature-flags.service.js';
import { DatabaseFlagProvider } from './flag.provider.js';
import { FlagsModule } from './flags.module.js';
import { GLOBAL_FLAG_TTL_MS, GlobalFlagCache } from './global-flags.cache.js';

const SUITE_TIMEOUT_MS = 300_000;

const ORG = '0199a1b2-0000-7000-8000-00000000000a';
const OTHER_ORG = '0199a1b2-0000-7000-8000-00000000000b';
const USER = '0199a1b2-0000-7000-8000-0000000000aa';

const CONTEXT: TenantScopedContext = { kind: 'org', orgId: ORG, userId: USER };
const OTHER_CONTEXT: TenantScopedContext = {
  kind: 'org',
  orgId: OTHER_ORG,
  userId: USER,
};

/**
 * Feature flags, against the real tables, the real grants and the real policy.
 *
 * The provider is exercised directly rather than through an OpenFeature
 * client, for the same reason the module never calls `setProvider`: that is
 * process-global state, and a suite that installed it would leak into every
 * other suite in the same process.
 */
describe('feature flags', () => {
  let postgres: TestPostgres;
  let owner: Client;
  let moduleRef: TestingModule;
  let flags: FeatureFlags;
  let provider: DatabaseFlagProvider;
  let cache: GlobalFlagCache;
  let db: Database;

  /**
   * A flag read the way a request makes it: inside that tenant's transaction.
   *
   * Which transaction is open is not an implementation detail here — the
   * override table is behind row-level security, so it is the answer. An API
   * process that asked outside a request would see the global default and
   * nothing else, which is the policy working rather than a bug.
   */
  const asTenant = <T>(
    context: TenantScopedContext,
    read: () => Promise<T>,
  ): Promise<T> => db.withTenantTransaction(context, read);

  const defineGlobal = async (key: string, value: unknown): Promise<void> => {
    await owner.query(
      `INSERT INTO feature_flags (key, value, description)
       VALUES ($1, $2::jsonb, 'set by a test')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    );
    cache.invalidate();
  };

  const override = async (
    orgId: string,
    key: string,
    value: unknown,
  ): Promise<void> => {
    await owner.query(
      `INSERT INTO flag_overrides (org_id, key, value, reason)
       VALUES ($1::uuid, $2, $3::jsonb, 'set by a test')
       ON CONFLICT (org_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [orgId, key, JSON.stringify(value)],
    );
  };

  beforeAll(async () => {
    postgres = await startPostgres();

    owner = new Client({ connectionString: postgres.migrationUri });
    await owner.connect();

    moduleRef = await Test.createTestingModule({
      imports: [
        DatabaseModule.forRoot('DATABASE_URL', 'DATABASE_POOL_MAX'),
        FlagsModule,
      ],
    }).compile();
    await moduleRef.init();

    flags = moduleRef.get(FeatureFlags);
    provider = moduleRef.get(DatabaseFlagProvider);
    cache = moduleRef.get(GlobalFlagCache);
    db = moduleRef.get(Database);
  }, SUITE_TIMEOUT_MS);

  afterAll(async () => {
    await moduleRef?.close();
    await owner?.end();
    await postgres?.stop();
  });

  beforeEach(async () => {
    await owner.query('DELETE FROM flag_overrides');
    await owner.query('DELETE FROM feature_flags');
    cache.invalidate();
  });

  describe('resolving a value', () => {
    it('returns the caller’s default for a flag nobody has configured', async () => {
      // Not an error, and this is the property that makes retiring a flag
      // safe: deleting the row leaves every caller that still names it working
      // on its own default, rather than failing.
      expect(await flags.boolean('nobody.defined.this', true)).toBe(true);
      expect(await flags.boolean('nobody.defined.this', false)).toBe(false);
    });

    it('says the flag was not found, rather than only what it returned', async () => {
      const details = await flags.booleanDetails('nobody.defined.this', false);

      // The difference between "the flag is off" and "there is no such flag"
      // is the whole of an incident investigation.
      expect(details.value).toBe(false);
      expect(details.errorCode).toBe('FLAG_NOT_FOUND');
    });

    it('returns the global value once one exists', async () => {
      await defineGlobal('new.checkout', true);

      expect(await flags.boolean('new.checkout', false)).toBe(true);
    });

    it('lets an organization’s override win', async () => {
      await defineGlobal('new.checkout', false);
      await override(ORG, 'new.checkout', true);

      expect(
        await asTenant(CONTEXT, () => flags.boolean('new.checkout', false)),
      ).toBe(true);
      expect(
        await asTenant(OTHER_CONTEXT, () =>
          flags.boolean('new.checkout', false),
        ),
      ).toBe(false);
    });

    it('shows one tenant’s override to nobody else, even when asked for', async () => {
      await defineGlobal('new.checkout', false);
      await override(ORG, 'new.checkout', true);

      // Naming another organization's id does not reach its rows: the
      // predicate and the policy have to agree, and inside this transaction
      // the policy sees only OTHER_ORG.
      expect(
        await asTenant(OTHER_CONTEXT, () =>
          flags.boolean('new.checkout', false, ORG),
        ),
      ).toBe(false);
    });

    it('applies an override for a flag with no global row at all', async () => {
      await override(ORG, 'incident.switch', true);

      // The override is looked up first and short-circuits. Requiring a global
      // row would mean two writes to turn something on for one customer, at
      // the moment somebody is least able to afford the second.
      expect(
        await asTenant(CONTEXT, () => flags.boolean('incident.switch', false)),
      ).toBe(true);
    });

    it('reports that an override matched, not that a default was used', async () => {
      await defineGlobal('new.checkout', false);
      await override(ORG, 'new.checkout', true);

      const details = await asTenant(CONTEXT, () =>
        flags.booleanDetails('new.checkout', false),
      );

      expect(details.reason).toBe('TARGETING_MATCH');
    });

    it('sees only the global value when there is no tenant at all', async () => {
      await defineGlobal('new.checkout', false);
      await override(ORG, 'new.checkout', true);

      // An API process outside a request has no tenant, so the policy shows it
      // no overrides — and it must not be handed one organization's answer by
      // accident. `app_user` deliberately has no cross-tenant read policy;
      // only the worker's role does.
      expect(await flags.boolean('new.checkout', true)).toBe(false);
    });

    it('carries strings, numbers and objects, not only booleans', async () => {
      await defineGlobal('rollout.cohort', 'beta');
      await defineGlobal('rollout.percent', 25);
      await defineGlobal('rollout.rules', { region: 'eu' });

      expect(await flags.string('rollout.cohort', 'stable')).toBe('beta');
      expect(await flags.number('rollout.percent', 0)).toBe(25);
      expect(await flags.object('rollout.rules', {})).toEqual({ region: 'eu' });
    });
  });

  describe('a value that is not what the caller asked for', () => {
    it('falls back rather than coercing', async () => {
      await defineGlobal('new.checkout', 'false');

      // `Boolean('false')` is `true`. A kill switch that inverts itself on a
      // typo is worse than one that does nothing, so a type mismatch resolves
      // to the caller's default and says so.
      const details = await flags.booleanDetails('new.checkout', false);

      expect(details.value).toBe(false);
      expect(details.errorCode).toBe('TYPE_MISMATCH');
    });

    it('does not accept null as an object', async () => {
      await defineGlobal('rollout.rules', null);

      // `typeof null === 'object'`, which is the oldest trap in the language
      // and would hand a caller a null where it expected a shape.
      expect(await flags.object('rollout.rules', { region: 'eu' })).toEqual({
        region: 'eu',
      });
    });

    it('does not accept a number that is not finite', async () => {
      // jsonb cannot hold NaN, so this arrives as a string — the shape a
      // caller most plausibly writes by accident.
      await defineGlobal('rollout.percent', 'NaN');

      expect(await flags.number('rollout.percent', 10)).toBe(10);
    });
  });

  describe('the cache', () => {
    it('serves a change to a second reader within the time-to-live', async () => {
      await defineGlobal('new.checkout', false);
      expect(await flags.boolean('new.checkout', true)).toBe(false);

      // Written straight to the table, with no invalidation: this is what a
      // second process sees. There is no pub/sub, so the time-to-live *is* the
      // propagation delay, and the contract says so.
      await owner.query(
        `UPDATE feature_flags SET value = 'true'::jsonb WHERE key = 'new.checkout'`,
      );

      expect(await flags.boolean('new.checkout', true)).toBe(false);
      expect(GLOBAL_FLAG_TTL_MS).toBeLessThanOrEqual(60_000);

      cache.invalidate();
      expect(await flags.boolean('new.checkout', false)).toBe(true);
    });

    it('reads an override without waiting for any window', async () => {
      await defineGlobal('new.checkout', false);
      await asTenant(CONTEXT, () => flags.boolean('new.checkout', false));

      await override(ORG, 'new.checkout', true);

      // Overrides are deliberately not cached: turning a flag on for one
      // customer is what happens during an incident, and it takes effect on
      // the next request rather than at the end of a window.
      expect(
        await asTenant(CONTEXT, () => flags.boolean('new.checkout', false)),
      ).toBe(true);
    });

    it('reloads while a tenant transaction is open', async () => {
      const key = 'reload.inside.a.transaction';

      // Loaded once from outside, so the cache holds a value: what is under
      // test is the *second* load, the one that happens with a tenant
      // transaction already open.
      await defineGlobal(key, false);
      expect(await flags.boolean(key, true)).toBe(false);

      await defineGlobal(key, true);

      // The cache used to open a system transaction unconditionally, which
      // `run` refuses to join from inside a tenant one. The failure was caught
      // and logged, and the cache then served its last successful load
      // forever: a flag written to the table was never picked up again, in the
      // only place a handler actually reads flags from.
      expect(await asTenant(CONTEXT, () => flags.boolean(key, false))).toBe(
        true,
      );
    });

    it('loads the table once when many readers arrive at once', async () => {
      await defineGlobal('new.checkout', true);
      cache.invalidate();

      const answers = await Promise.all(
        Array.from({ length: 20 }, () => flags.boolean('new.checkout', false)),
      );

      // A cold cache under load would otherwise issue one query per concurrent
      // request — the stampede a cache exists to prevent, at exactly the
      // moment it matters.
      expect(answers.every(Boolean)).toBe(true);
    });
  });

  describe('when the database is not answering', () => {
    it('keeps serving the values it already had', async () => {
      await defineGlobal('new.checkout', true);
      expect(await flags.boolean('new.checkout', false)).toBe(true);

      await owner.query('ALTER TABLE feature_flags RENAME TO feature_flags_hidden');
      cache.invalidate();

      try {
        // A flag store that throws turns one outage into every request
        // failing, which is the opposite of what a kill switch is for.
        expect(await flags.boolean('new.checkout', false)).toBe(true);
      } finally {
        await owner.query(
          'ALTER TABLE feature_flags_hidden RENAME TO feature_flags',
        );
      }
    });

    it('resolves to the default rather than throwing when an override read fails', async () => {
      await owner.query('ALTER TABLE flag_overrides RENAME TO flag_overrides_hidden');

      try {
        const details = await asTenant(CONTEXT, () =>
          flags.booleanDetails('new.checkout', true),
        ).catch(() => flags.booleanDetails('new.checkout', true, ORG));

        expect(details.value).toBe(true);
        expect(details.errorCode).toBe('GENERAL');
      } finally {
        await owner.query(
          'ALTER TABLE flag_overrides_hidden RENAME TO flag_overrides',
        );
      }
    });
  });

  describe('what it is, to OpenFeature', () => {
    it('is a server provider with a name', () => {
      // The whole reason for the interface: every hosted vendor publishes an
      // OpenFeature provider, so replacing this one is a line in a module
      // rather than an edit at every call site.
      expect(provider.runsOn).toBe('server');
      expect(provider.metadata.name).toBe('database');
    });
  });
});
