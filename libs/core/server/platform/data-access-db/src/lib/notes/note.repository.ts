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
   *
   * It returns what it deleted, or `null` when there was nothing. The caller
   * needs that to decide whether anything happened worth recording — after the
   * row is gone there is nowhere else to read its version or its size from,
   * and an audit trail that cannot describe what was deleted is not one.
   */
  remove(id: string): Promise<Note | null> {
    return this.db.withRequestTransaction(async () => {
      try {
        // One statement, not a read then a delete. Read-then-delete lets two
        // concurrent requests both see the row and both report a deletion —
        // measured on PostgreSQL 18 at READ COMMITTED, the second `DELETE`
        // affects nothing and the caller is told it removed a note anyway. Two
        // `note.deleted` events with different ids follow, and consumer
        // deduplication keys on the event id, so it cannot absorb them.
        //
        // It also fixes what the row *says*: a delete racing an update would
        // otherwise report the version it read rather than the version it
        // deleted, and a last-write-wins projection would then discard the
        // deletion as stale.
        return toDomain(await this.db.tenant().note.delete({ where: { id } }));
      } catch (failure) {
        if (isMissingRecord(failure)) {
          // Deleting something already gone is success, not failure: a client
          // that retries a delete it never saw the answer to must not be told
          // the resource vanished mysteriously.
          return null;
        }

        throw failure;
      }
    });
  }
}

/**
 * Prisma's "the record to delete does not exist" — code P2025.
 *
 * Matched on the code rather than the class so this file does not import the
 * generated error types into a signature; the code is documented and stable.
 */
function isMissingRecord(failure: unknown): boolean {
  return (
    typeof failure === 'object' &&
    failure !== null &&
    (failure as { code?: unknown }).code === 'P2025'
  );
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
