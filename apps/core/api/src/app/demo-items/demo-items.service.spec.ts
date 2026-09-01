import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PrismaService } from '@workspace/core-server-data-access-db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DemoItemsService } from './demo-items.service.js';

const CONTAINER_START_TIMEOUT_MS = 180_000;

// Six levels up from src/app/demo-items is the workspace root. `__dirname`
// rather than `import.meta`: this app compiles to CommonJS, and Vitest
// provides both.
const workspaceRoot = join(__dirname, '../../../../../..');

describe('DemoItemsService pagination', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaService;
  let service: DemoItemsService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine').start();
    process.env['DATABASE_URL'] = container.getConnectionUri();

    // Through the Nx target rather than the prisma binary: migrations belong to
    // the data-access library, and this app does not depend on prisma itself.
    execFileSync(
      'pnpm',
      ['nx', 'run', 'core-server-data-access-db:prisma-migrate-deploy'],
      {
        cwd: workspaceRoot,
        env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
        stdio: 'pipe',
        shell: process.platform === 'win32',
      },
    );

    prisma = new PrismaService();
    await prisma.$connect();
    service = new DemoItemsService(prisma);
  }, CONTAINER_START_TIMEOUT_MS);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  beforeEach(async () => {
    await prisma.demoItem.deleteMany();
  });

  async function seed(count: number): Promise<void> {
    // Written in one statement so several rows land in the same millisecond —
    // which is exactly the case a naive keyset query gets wrong.
    await prisma.demoItem.createMany({
      data: Array.from({ length: count }, (_, index) => ({
        title: `item-${String(index).padStart(3, '0')}`,
      })),
    });
  }

  async function readAllPages(limit: number): Promise<string[]> {
    const titles: string[] = [];
    let cursor: string | undefined;

    // A bounded loop: an off-by-one in the cursor logic must fail the test, not
    // hang the suite.
    for (let page = 0; page < 50; page += 1) {
      const result = await service.list({ cursor, limit });
      titles.push(...result.items.map((item) => item.title));

      if (result.nextCursor === null) {
        return titles;
      }

      cursor = result.nextCursor;
    }

    throw new Error('The list never reported a last page');
  }

  it('pages through more rows than one page holds, without repeating or skipping', async () => {
    await seed(25);

    const titles = await readAllPages(10);

    expect(titles).toHaveLength(25);
    expect(new Set(titles).size).toBe(25);
  });

  it('orders rows the same way across page boundaries', async () => {
    await seed(25);

    const paged = await readAllPages(7);
    const inOneGo = await service.list({ limit: 100 });

    expect(paged).toEqual(inOneGo.items.map((item) => item.title));
  });

  it('returns no cursor when the last page is exactly full', async () => {
    await seed(10);

    const page = await service.list({ limit: 10 });

    // The extra-row probe is what makes this correct: a `hasMore` derived from
    // `items.length === limit` would hand out a cursor to an empty page.
    expect(page.items).toHaveLength(10);
    expect(page.nextCursor).toBeNull();
  });

  it('returns an empty page and no cursor when there is nothing', async () => {
    const page = await service.list();

    expect(page).toEqual({ items: [], nextCursor: null });
  });

  it('does not repeat or lose a row when one is inserted between pages', async () => {
    await seed(20);

    const first = await service.list({ limit: 10 });
    expect(first.nextCursor).not.toBeNull();

    // A newer row sorts before the whole first page (createdAt DESC), so keyset
    // pagination must simply not see it. Offset pagination would shift every
    // subsequent page by one and repeat a row.
    await service.create({ title: 'inserted-between-pages' });

    const second = await service.list({
      cursor: first.nextCursor ?? undefined,
      limit: 10,
    });

    const seen = [...first.items, ...second.items].map((item) => item.title);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain('inserted-between-pages');
    expect(seen).toHaveLength(20);
  });

  it('rejects a tampered cursor', async () => {
    await seed(5);
    const page = await service.list({ limit: 2 });

    const forged = `${page.nextCursor?.slice(0, -2) ?? ''}xx`;

    await expect(service.list({ cursor: forged })).rejects.toThrow();
  });
});
