import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  encodeCursor,
  hashPaginationFilter,
  resolvePageLimit,
} from '@workspace/core-server-core';
import { PrismaService } from '@workspace/core-server-data-access-db';

import type { CreateDemoItemDto } from './demo-item.dto';

export interface DemoItem {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

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
 */
@Injectable()
export class DemoItemsService {
  private readonly prisma: PrismaService;

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
  }

  async create(input: CreateDemoItemDto): Promise<DemoItem> {
    const created = await this.prisma.demoItem.create({
      data: { title: input.title },
    });

    return this.toDto(created);
  }

  async list(input: ListDemoItemsInput = {}): Promise<DemoItemPage> {
    const limit = resolvePageLimit(input.limit);
    const filterHash = hashPaginationFilter(LIST_FILTER);
    const position = input.cursor ? decodeCursor(input.cursor, filterHash) : undefined;

    // Keyset, not offset: OFFSET makes the database walk and discard every
    // skipped row, and a row inserted between pages shifts everything after it.
    // The compound comparison is what makes (createdAt, id) a total order —
    // timestamps collide, primary keys do not.
    const rows = await this.prisma.demoItem.findMany({
      // One extra row is the cheapest way to know whether another page exists
      // without a second COUNT query.
      take: limit + 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      where: position
        ? {
            OR: [
              { createdAt: { lt: new Date(position.sortKey) } },
              { createdAt: new Date(position.sortKey), id: { lt: position.id } },
            ],
          }
        : undefined,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return {
      items: page.map((row) => this.toDto(row)),
      nextCursor:
        hasMore && last
          ? encodeCursor({
              sortKey: last.createdAt.toISOString(),
              id: last.id,
              filterHash,
              direction: 'forward',
            })
          : null,
    };
  }

  /**
   * Prisma types stop at this boundary (spec rule 5b): callers see the domain
   * shape, so replacing the ORM does not ripple outwards.
   */
  private toDto(row: {
    id: string;
    title: string;
    createdAt: Date;
    updatedAt: Date;
  }): DemoItem {
    return {
      id: row.id,
      title: row.title,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
