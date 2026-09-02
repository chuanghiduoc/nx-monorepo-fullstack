import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { Database } from '../transaction/database.js';

/** Domain shape. Prisma's row type stops at this file. */
export interface Note {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateNoteInput {
  readonly title: string;
  readonly body: string;
}

export interface UpdateNoteInput {
  readonly title?: string;
  readonly body?: string;
  /** The version the caller read. A mismatch is a 409, never a lost write. */
  readonly expectedVersion: number;
}

export interface NotePosition {
  readonly createdAt: string;
  readonly id: string;
}

export interface ListNotesInput {
  readonly after?: NotePosition;
  /** Rows to fetch; the caller adds one to learn whether a next page exists. */
  readonly take: number;
}

/**
 * Notes belong to the organization the request is acting in.
 *
 * No method takes an organization: every query runs inside the request's own
 * transaction, and the database supplies the tenant from the setting that
 * transaction made. A `where` clause naming the organization would be a second
 * place to get it right, and the one that gets forgotten.
 */
@Injectable()
export class NoteRepository {
  private readonly db: Database;

  constructor(@Inject(Database) db: Database) {
    this.db = db;
  }

  create(orgId: string, input: CreateNoteInput): Promise<Note> {
    return this.db.withRequestTransaction(async () => {
      const row = await this.db.tenant().note.create({
        data: { orgId, title: input.title, body: input.body },
      });
      return toDomain(row);
    });
  }

  list(input: ListNotesInput): Promise<Note[]> {
    return this.db.withRequestTransaction(async () => {
      // Keyset, not offset: OFFSET makes the database walk and discard every
      // skipped row, and a row inserted between pages shifts everything after
      // it. The index leads with org_id because the policy adds that predicate
      // to every plan.
      const rows = await this.db.tenant().note.findMany({
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

  find(id: string): Promise<Note | undefined> {
    return this.db.withRequestTransaction(async () => {
      const row = await this.db.tenant().note.findUnique({ where: { id } });
      return row ? toDomain(row) : undefined;
    });
  }

  update(id: string, input: UpdateNoteInput): Promise<Note> {
    return this.db.withRequestTransaction(async () => {
      const notes = this.db.tenant().note;

      // The version is part of the condition. Reading it and then updating by
      // id would let two edits that both read version 3 both succeed, and the
      // second would erase the first with nobody the wiser.
      const updated = await notes.updateMany({
        where: { id, version: input.expectedVersion },
        data: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
          version: { increment: 1 },
        },
      });

      if (updated.count === 0) {
        // Either it is gone, it belongs to another organization — which under
        // the policy is the same as gone — or someone else changed it first.
        const current = await notes.findUnique({ where: { id } });

        if (!current) {
          throw new NotFoundException('That note does not exist.');
        }

        throw new ConflictException(
          'That note changed while you were editing it. Read it again and reapply your change.',
        );
      }

      const row = await notes.findUniqueOrThrow({ where: { id } });
      return toDomain(row);
    });
  }

  /**
   * Deleting something already gone is success, not failure: a client that
   * retries a delete it never saw the answer to must not be told the resource
   * vanished mysteriously.
   */
  remove(id: string): Promise<void> {
    return this.db.withRequestTransaction(async () => {
      await this.db.tenant().note.deleteMany({ where: { id } });
    });
  }
}

function toDomain(row: {
  id: string;
  title: string;
  body: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}): Note {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
