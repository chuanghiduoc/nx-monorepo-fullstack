import { Inject, Injectable } from '@nestjs/common';

import { Database } from '../transaction/database.js';

/** Domain shape. Prisma's row type stops at this file. */
export interface DemoItem {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateDemoItemInput {
  readonly title: string;
}

/** Keyset position: the last row of the previous page. */
export interface DemoItemPosition {
  readonly createdAt: string;
  readonly id: string;
}

export interface ListDemoItemsInput {
  readonly after?: DemoItemPosition;
  /** Rows to fetch; the caller adds one to learn whether a next page exists. */
  readonly take: number;
}

/**
 * Reference repository: the pattern every data-access class follows.
 *
 * Every method runs inside a transaction. When the use case has already
 * opened one, the call joins it; otherwise a short one is opened here — so a
 * caller never has to remember, and a query never runs on the root client.
 * Demo items are global data (no tenant column), hence system transactions;
 * a tenant-owned table would use `withTenantTransaction` with the request's
 * context instead.
 */
@Injectable()
export class DemoItemRepository {
  private readonly db: Database;

  constructor(@Inject(Database) db: Database) {
    this.db = db;
  }

  create(input: CreateDemoItemInput): Promise<DemoItem> {
    return this.db.withSystemTransaction(async () => {
      const row = await this.db
        .system()
        .demoItem.create({ data: { title: input.title } });
      return toDomain(row);
    });
  }

  list(input: ListDemoItemsInput): Promise<DemoItem[]> {
    return this.db.withSystemTransaction(async () => {
      // Keyset, not offset: OFFSET makes the database walk and discard every
      // skipped row, and a row inserted between pages shifts everything after
      // it. The compound comparison is what makes (createdAt, id) a total
      // order — timestamps collide, primary keys do not.
      const rows = await this.db.system().demoItem.findMany({
        take: input.take,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        where: input.after
          ? {
              OR: [
                { createdAt: { lt: new Date(input.after.createdAt) } },
                {
                  createdAt: new Date(input.after.createdAt),
                  id: { lt: input.after.id },
                },
              ],
            }
          : undefined,
      });

      return rows.map(toDomain);
    });
  }
}

function toDomain(row: {
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
