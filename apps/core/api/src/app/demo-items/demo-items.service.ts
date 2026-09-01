import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@workspace/core-server-data-access-db';

import type { CreateDemoItemDto } from './demo-item.dto';

const DEFAULT_PAGE_SIZE = 20;

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

  async list(limit = DEFAULT_PAGE_SIZE): Promise<DemoItemPage> {
    // Keyset ordering matches the (createdAt DESC, id DESC) index; the opaque
    // cursor arrives in the next task, which is why nextCursor is still null.
    const rows = await this.prisma.demoItem.findMany({
      take: limit,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    return { items: rows.map((row) => this.toDto(row)), nextCursor: null };
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
