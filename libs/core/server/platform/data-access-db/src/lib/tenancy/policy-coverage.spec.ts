import { Client } from 'pg';
import {
  POSTGRES_START_TIMEOUT_MS,
  startPostgres,
  type TestPostgres,
} from '@workspace/core-server-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  readModelClasses,
  readTableNames,
  TENANT_SCOPED_CLASSES,
} from '../../../tools/model-classes.js';

interface SecurityRow {
  table: string;
  enabled: boolean;
  forced: boolean;
  policies: number;
}

/**
 * Whether every table the schema calls tenant-scoped is actually protected.
 *
 * The existing isolation suite proves that `notes` and `bookmarks` are, which
 * is a statement about two tables. This is the statement about *all* of them,
 * and it is the one that survives somebody adding a third: a `/// class:
 * TENANT_OWNED` comment with no policy in the migration is invisible
 * everywhere else, and the failure it produces is a tenant reading another
 * tenant's rows.
 *
 * The other direction matters too. A table declared SYSTEM, GLOBAL or AUTH
 * must *not* carry a tenant policy: the worker reads those with no tenant set,
 * so a policy comparing `org_id` to an unset GUC would make every one of them
 * return nothing — silently, and identically to an empty table.
 */
describe('every table is protected the way its class says', () => {
  let postgres: TestPostgres;
  let owner: Client;
  let security: Map<string, SecurityRow>;

  beforeAll(async () => {
    postgres = await startPostgres();
    owner = new Client({ connectionString: postgres.migrationUri });
    await owner.connect();

    const { rows } = await owner.query<SecurityRow>(`
      SELECT c.relname AS table,
             c.relrowsecurity AS enabled,
             c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policies p
               WHERE p.schemaname = 'public'
                 AND p.tablename = c.relname
                 AND p.policyname = 'tenant_isolation') AS policies
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'`);

    security = new Map(rows.map((row) => [row.table, row]));
  }, POSTGRES_START_TIMEOUT_MS);

  afterAll(async () => {
    await owner?.end();
    await postgres?.stop();
  });

  const tablesOfClass = (wanted: readonly string[]): string[] => {
    const names = readTableNames();

    return [...readModelClasses()]
      .filter(([, modelClass]) => wanted.includes(modelClass))
      .map(([model]) => names.get(model) ?? model)
      .sort();
  };

  it('gives every tenant-scoped table an enforced tenant policy', () => {
    const missing = tablesOfClass(TENANT_SCOPED_CLASSES).filter((table) => {
      const row = security.get(table);
      return !row || !row.enabled || !row.forced || row.policies === 0;
    });

    // `FORCE` as well as `ENABLE`: without it the table owner is exempt, and
    // the owner is who migrations and any future maintenance script connect
    // as. Without a `tenant_isolation` policy, `ENABLE` alone denies
    // everything to everyone, which fails loudly — but the combination this
    // asserts is the one that actually isolates.
    expect(missing).toEqual([]);
  });

  it('gives no other table one', () => {
    const wrong = tablesOfClass(['GLOBAL', 'SYSTEM', 'AUTH']).filter(
      (table) => (security.get(table)?.policies ?? 0) > 0,
    );

    // A tenant policy on a SYSTEM table would make the worker — which sets no
    // tenant GUC — read nothing at all, and reading nothing is
    // indistinguishable from an empty table. The outbox relay would find no
    // events and report success forever.
    expect(wrong).toEqual([]);
  });

  it('names a table for every model in the schema', () => {
    const names = readTableNames();
    const models = [...readModelClasses().keys()];

    // The map above is what makes both assertions meaningful; a model missing
    // from it would silently be checked under its Prisma name and find no row
    // in `pg_class`, which reads exactly like "protected".
    expect(models.filter((model) => !names.has(model))).toEqual([]);
    expect(models.length).toBeGreaterThan(0);
  });
});
