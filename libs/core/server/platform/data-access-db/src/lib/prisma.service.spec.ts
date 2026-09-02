import {
  POSTGRES_START_TIMEOUT_MS,
  startPostgres,
  type TestPostgres,
} from '@workspace/core-server-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from './prisma.service.js';

const UUID_VERSION_POSITION = 14;

describe('PrismaService against a real PostgreSQL 18', () => {
  let database: TestPostgres;
  let prisma: PrismaService;

  beforeAll(async () => {
    // The whole point of these conventions is what the database does, so the
    // test uses a database rather than a mock.
    database = await startPostgres();
    prisma = new PrismaService();
    await prisma.$connect();
  }, POSTGRES_START_TIMEOUT_MS);

  afterAll(async () => {
    await prisma?.$disconnect();
    await database?.stop();
  });

  it('lets the database generate the primary key', async () => {
    const item = await prisma.demoItem.create({ data: { title: 'first' } });

    expect(item.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('generates version 7 UUIDs, not version 4', async () => {
    const item = await prisma.demoItem.create({ data: { title: 'versioned' } });

    // The version nibble is the 13th hex digit; v7 is what keeps inserts
    // sequential in the B-tree (see the ID standard in the design spec).
    expect(item.id[UUID_VERSION_POSITION]).toBe('7');
  });

  it('orders ids by creation time, which is why v7 was chosen', async () => {
    const first = await prisma.demoItem.create({ data: { title: 'earlier' } });
    const second = await prisma.demoItem.create({ data: { title: 'later' } });

    expect(second.id > first.id).toBe(true);
  });

  it('stores timestamps with a time zone at millisecond precision', async () => {
    const [column] = await prisma.$queryRaw<
      { data_type: string; datetime_precision: number }[]
    >`
      SELECT data_type, datetime_precision FROM information_schema.columns
      WHERE table_name = 'demo_items' AND column_name = 'created_at'
    `;

    expect(column.data_type).toBe('timestamp with time zone');
    // Millisecond precision, matching JavaScript Date: a column holding
    // microseconds stores values the application can never read back exactly,
    // which breaks keyset pagination on that column.
    expect(column.datetime_precision).toBe(3);
  });

  it('refuses to construct without a database url', () => {
    const original = process.env['DATABASE_URL'];
    delete process.env['DATABASE_URL'];

    expect(() => new PrismaService()).toThrow(/DATABASE_URL/);

    process.env['DATABASE_URL'] = original;
  });
});
