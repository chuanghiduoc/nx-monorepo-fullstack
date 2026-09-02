import {
  POSTGRES_START_TIMEOUT_MS,
  startPostgres,
  type TestPostgres,
} from '@workspace/core-server-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from './prisma.service.js';
import { Database } from './transaction/database.js';

/**
 * Task 0 of the Phase 3 plan: two assumptions the whole phase rests on, each
 * answered by running something rather than by reading. Deleted once ADR-0003
 * records the answers.
 */
describe('Phase 3 spike', () => {
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

  it('records whether the harness can be bound by RLS at all', async () => {
    const [role] = await db.withSystemTransaction(
      () =>
        db.system().$queryRaw<{ user: string; super: boolean; bypass: boolean }[]>`
          SELECT current_user AS "user", rolsuper AS "super", rolbypassrls AS bypass
          FROM pg_roles WHERE rolname = current_user`,
    );

    console.log('[spike] connection role:', JSON.stringify(role));

    // FORCE ROW LEVEL SECURITY binds table owners, never superusers. If this
    // is a superuser, every isolation test in Phase 3 would pass without a
    // single policy in effect.
    expect(role).toBeDefined();
  });

  it('records whether a table owner is bound by FORCE ROW LEVEL SECURITY', async () => {
    await db.withSystemTransaction(async () => {
      const tx = db.system();
      await tx.$executeRawUnsafe('CREATE TABLE spike_rls (id int, org text)');
      await tx.$executeRawUnsafe("INSERT INTO spike_rls VALUES (1, 'a'), (2, 'b')");
      await tx.$executeRawUnsafe('ALTER TABLE spike_rls ENABLE ROW LEVEL SECURITY');
      await tx.$executeRawUnsafe('ALTER TABLE spike_rls FORCE ROW LEVEL SECURITY');
      await tx.$executeRawUnsafe(
        "CREATE POLICY only_a ON spike_rls USING (org = 'a')",
      );

      const rows = await tx.$queryRawUnsafe<{ id: number }[]>(
        'SELECT id FROM spike_rls ORDER BY id',
      );
      console.log('[spike] rows visible under a FORCE policy allowing only org a:', rows.length);

      await tx.$executeRawUnsafe('DROP TABLE spike_rls');
    });
  });
});
