import { Client as PgClient } from 'pg';

import {
  POSTGRES_START_TIMEOUT_MS,
  startPostgres,
  type TestPostgres,
} from '@workspace/core-server-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../prisma.service.js';
import { Database } from '../transaction/database.js';

/**
 * The first test of every suite that claims to prove tenant isolation.
 *
 * `FORCE ROW LEVEL SECURITY` binds table owners; it has never bound superusers
 * or roles with `BYPASSRLS`. Against such a connection every isolation test
 * passes with no policy in effect at all — which is exactly what this harness
 * did before Phase 3 (ADR-0003).
 */
describe('the test connection can be bound by row-level security', () => {
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

  it('is neither a superuser nor a BYPASSRLS role', async () => {
    const [role] = await db.withSystemTransaction(
      () =>
        db.system().$queryRaw<
          { name: string; isSuper: boolean; bypasses: boolean }[]
        >`
          SELECT current_user AS name,
                 rolsuper AS "isSuper",
                 rolbypassrls AS bypasses
          FROM pg_roles WHERE rolname = current_user`,
    );

    expect(role.isSuper, `${role.name} is a superuser`).toBe(false);
    expect(role.bypasses, `${role.name} has BYPASSRLS`).toBe(false);
  });

  it('cannot escalate by switching role', async () => {
    const escalated = db.withSystemTransaction(() =>
      db.system().$executeRawUnsafe('SET ROLE postgres'),
    );

    await expect(escalated).rejects.toThrow();
  });

  it('can read a table created by a later migration without an explicit grant', async () => {
    // Default privileges apply only to objects created *by* the role they name.
    // Migrations run as the owner, so `ALTER DEFAULT PRIVILEGES FOR ROLE
    // migration_role` would never fire and every table added after this point
    // would be invisible to app_user — which reads exactly like RLS working.
    const owner = new PgClient({ connectionString: postgres.migrationUri });
    await owner.connect();
    try {
      await owner.query('CREATE TABLE grant_probe (id int)');
      await owner.query('INSERT INTO grant_probe VALUES (1)');
    } finally {
      await owner.end();
    }

    const rows = await db.withSystemTransaction(() =>
      db
        .system()
        .$queryRawUnsafe<{ id: number }[]>('SELECT id FROM grant_probe'),
    );

    expect(rows).toEqual([{ id: 1 }]);
  });

  it('is actually held by a FORCE policy', async () => {
    // The property the whole tenancy gate depends on, checked directly rather
    // than inferred from the two role flags above.
    const visible = await db.withSystemTransaction(async () => {
      const tx = db.system();
      await tx.$executeRawUnsafe('CREATE TEMP TABLE rls_probe (tenant text)');
      await tx.$executeRawUnsafe("INSERT INTO rls_probe VALUES ('a'), ('b')");
      await tx.$executeRawUnsafe(
        'ALTER TABLE rls_probe ENABLE ROW LEVEL SECURITY',
      );
      await tx.$executeRawUnsafe(
        'ALTER TABLE rls_probe FORCE ROW LEVEL SECURITY',
      );
      await tx.$executeRawUnsafe(
        "CREATE POLICY only_a ON rls_probe USING (tenant = 'a')",
      );

      return tx.$queryRawUnsafe<{ tenant: string }[]>(
        'SELECT tenant FROM rls_probe',
      );
    });

    expect(visible.map((row) => row.tenant)).toEqual(['a']);
  });
});
