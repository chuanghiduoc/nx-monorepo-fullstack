import { Test, type TestingModule } from '@nestjs/testing';
import {
  Database,
  DatabaseModule,
} from '@workspace/core-server-data-access-db';
import {
  POSTGRES_START_TIMEOUT_MS,
  demoItemFactory,
  startPostgres,
  type TestPostgres,
} from '@workspace/core-server-testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DemoItemsService } from './demo-items.service.js';

describe('DemoItemsService pagination', () => {
  let database: TestPostgres;
  let moduleRef: TestingModule;
  let db: Database;
  let service: DemoItemsService;

  beforeAll(async () => {
    database = await startPostgres();

    // Wired the way the application wires it: the root client stays inside
    // DatabaseModule, and this test never sees it.
    moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule],
      providers: [DemoItemsService],
    }).compile();
    await moduleRef.init();

    db = moduleRef.get(Database);
    service = moduleRef.get(DemoItemsService);
  }, POSTGRES_START_TIMEOUT_MS);

  afterAll(async () => {
    await moduleRef?.close();
    await database?.stop();
  });

  beforeEach(async () => {
    await db.withSystemTransaction(() => db.system().demoItem.deleteMany());
  });

  async function seed(count: number): Promise<void> {
    // Written in one statement so several rows land in the same millisecond —
    // which is exactly the case a naive keyset query gets wrong.
    await db.withSystemTransaction(() =>
      db
        .system()
        .demoItem.createMany({ data: demoItemFactory.buildList(count) }),
    );
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
