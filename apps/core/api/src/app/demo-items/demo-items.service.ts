import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  hashPaginationFilter,
  resolvePageLimit,
} from '@workspace/core-server-core';
import {
  DemoItemRepository,
  type DemoItem,
} from '@workspace/core-server-data-access-db';

import type { CreateDemoItemDto } from './demo-item.dto';

export type { DemoItem } from '@workspace/core-server-data-access-db';

export interface DemoItemPage {
  items: DemoItem[];
  nextCursor: string | null;
}

export interface ListDemoItemsInput {
  cursor?: string;
  limit?: number;
}

/**
 * The list has one sort order today, so its filter hash is a constant. It is
 * still computed rather than hard-coded: the day a status filter is added, the
 * hash must change with it, and a literal string would not.
 */
const LIST_FILTER = { sort: 'createdAt:desc,id:desc' } as const;

/**
 * Reference feature.
 *
 * It exists so the contract chain, the pagination helpers and the error shape
 * are exercised by something real before the first business feature arrives.
 * Persistence is the repository's job; this service owns the cursor.
 */
@Injectable()
export class DemoItemsService {
  private readonly items: DemoItemRepository;

  constructor(@Inject(DemoItemRepository) items: DemoItemRepository) {
    this.items = items;
  }

  create(input: CreateDemoItemDto): Promise<DemoItem> {
    return this.items.create({ title: input.title });
  }

  async list(input: ListDemoItemsInput = {}): Promise<DemoItemPage> {
    const limit = resolvePageLimit(input.limit);
    const filterHash = hashPaginationFilter(LIST_FILTER);
    const position = input.cursor
      ? decodeCursor(input.cursor, filterHash)
      : undefined;

    // One extra row is the cheapest way to know whether another page exists
    // without a second COUNT query.
    const rows = await this.items.list({
      take: limit + 1,
      after: position
        ? { createdAt: position.sortKey, id: position.id }
        : undefined,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return {
      items: page,
      nextCursor:
        hasMore && last
          ? encodeCursor({
              sortKey: last.createdAt,
              id: last.id,
              filterHash,
              direction: 'forward',
            })
          : null,
    };
  }
}
