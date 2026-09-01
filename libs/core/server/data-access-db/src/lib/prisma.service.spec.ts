import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from './prisma.service.js';

const CONTAINER_START_TIMEOUT_MS = 180_000;
const UUID_VERSION_POSITION = 14;
const libraryRoot = join(import.meta.dirname, '..', '..');

describe('PrismaService against a real PostgreSQL 18', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaService;

  beforeAll(async () => {
    // The whole point of these conventions is what the database does, so the
    // test uses a database rather than a mock.
    container = await new PostgreSqlContainer('postgres:18-alpine').start();
    process.env['DATABASE_URL'] = container.getConnectionUri();

    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: libraryRoot,
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });

    prisma = new PrismaService();
    await prisma.$connect();
  }, CONTAINER_START_TIMEOUT_MS);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
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

  it('stores timestamps with a time zone', async () => {
    const [column] = await prisma.$queryRaw<{ data_type: string }[]>`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'demo_items' AND column_name = 'createdAt'
    `;

    expect(column.data_type).toBe('timestamp with time zone');
  });

  it('refuses to construct without a database url', () => {
    const original = process.env['DATABASE_URL'];
    delete process.env['DATABASE_URL'];

    expect(() => new PrismaService()).toThrow(/DATABASE_URL/);

    process.env['DATABASE_URL'] = original;
  });
});
