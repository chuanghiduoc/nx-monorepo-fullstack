import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  POSTGRES_START_TIMEOUT_MS,
  startPostgres,
  type TestPostgres,
} from '@workspace/core-server-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../prisma.service.js';
import { Database } from '../transaction/database.js';
import {
  readModelClasses,
  tenantScopedDelegates,
  TENANT_SCOPED_CLASSES,
} from '../../../tools/model-classes.js';
import { TENANT_SCOPED_DELEGATES } from './tenant-scoped-models.js';

const ORG = {
  kind: 'org',
  orgId: '0199a1b2-0000-7000-8000-00000000000a',
  userId: '0199a1b2-0000-7000-8000-0000000000aa',
} as const;

const NEWLINE = String.fromCharCode(10);

/**
 * The guard exists to turn a silent empty result into a stack trace.
 *
 * Under a policy, a tenant-scoped query with no tenant context returns
 * nothing and raises nothing — indistinguishable from an empty table. These
 * tests are about which of those two a developer gets.
 */
describe('the tenant guard', () => {
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

  it('refuses a tenant-scoped read with no tenant', async () => {
    const refused = db.withSystemTransaction(() => db.system().note.findMany());

    await expect(refused).rejects.toThrow(/belongs to a tenant/i);
  });

  it('names the model, so the fix is obvious', async () => {
    const refused = db.withSystemTransaction(() =>
      db.system().bookmark.create({
        data: { userId: ORG.userId, url: 'https://example.test', label: 'x' },
      }),
    );

    await expect(refused).rejects.toThrow(/bookmark belongs to a tenant/i);
  });

  it('allows the same read inside a tenant transaction', async () => {
    const rows = await db.withTenantTransaction(ORG, () =>
      db.tenant().note.findMany(),
    );

    expect(Array.isArray(rows)).toBe(true);
  });

  it('leaves global data alone', async () => {
    // A global table has no tenant to check, so a system transaction reads it
    // exactly as before.
    const count = await db.withSystemTransaction(() => db.system().demoItem.count());

    expect(typeof count).toBe('number');
  });

  it('leaves system tables alone', async () => {
    const count = await db.withSystemTransaction(() =>
      db.system().idempotencyRecord.count(),
    );

    expect(typeof count).toBe('number');
  });

  it('does not guard raw SQL, and says so', async () => {
    // Extensions see model operations, not raw SQL. The policy still applies,
    // so this returns nothing rather than everything — which is the reason the
    // guard exists for the model path, and the reason raw SQL is the author's
    // responsibility.
    const rows = await db.withSystemTransaction(() =>
      db.system().$queryRawUnsafe<{ id: string }[]>('SELECT id FROM notes'),
    );

    expect(rows).toEqual([]);
  });
});

describe('model classes', () => {
  it('reads a class for every model in the schema', () => {
    const classes = readModelClasses();

    expect(classes.size).toBeGreaterThan(0);
    expect(classes.get('DemoItem')).toBe('GLOBAL');
    expect(classes.get('IdempotencyRecord')).toBe('SYSTEM');
    expect(classes.get('Note')).toBe('TENANT_OWNED');
    expect(classes.get('Bookmark')).toBe('TENANT_OPTIONAL');
    expect(classes.get('User')).toBe('AUTH');
  });

  it('derives the scoped delegates from the classes, not from a list', () => {
    const scoped = tenantScopedDelegates();

    expect([...scoped].sort()).toEqual(['bookmark', 'note']);
    expect(TENANT_SCOPED_CLASSES).toEqual(['TENANT_OWNED', 'TENANT_OPTIONAL']);
  });

  it('keeps the generated list in step with the schema', () => {
    // The runtime list is generated and committed, because the schema is not
    // in the deployed bundle — reading it on module load made the API fail to
    // boot. This is what stops the generated copy falling behind: add a
    // tenant table, forget to regenerate, and this fails.
    expect([...TENANT_SCOPED_DELEGATES].sort()).toEqual(
      [...tenantScopedDelegates()].sort(),
    );
  });

  it('refuses a model that declares no class', () => {
    // Defaulting would default towards less protection: a new tenant table
    // whose author forgot the comment would be unguarded.
    const schema = writeSchema(
      [
        '/// class: GLOBAL — fine.',
        'model Declared { id String @id }',
        '',
        'model Forgotten { id String @id }',
      ].join(NEWLINE),
    );

    expect(() => readModelClasses(schema)).toThrow(/Forgotten/);
  });

  it('refuses a class nobody defined', () => {
    const schema = writeSchema(
      ['/// class: TENANT_SHARED — not a thing.', 'model Odd { id String @id }'].join(
        NEWLINE,
      ),
    );

    expect(() => readModelClasses(schema)).toThrow(/unknown class/i);
  });
});

function writeSchema(contents: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'schema-')), 'schema.prisma');
  writeFileSync(file, contents);
  return file;
}
