import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { RealtimeBus } from '@workspace/core-server-realtime';
import { AuthzService, type Principal } from '@workspace/core-server-authz';
import {
  decodeCursor,
  encodeCursor,
  hashPaginationFilter,
  resolvePageLimit,
} from '@workspace/core-server-core';
import {
  Database,
  NoteRepository,
  OutboxRepository,
  type Note,
} from '@workspace/core-server-data-access-db';
import {
  noteCreated,
  noteDeleted,
  noteUpdated,
  type EventDefinition,
} from '@workspace/core-server-events';

import type { CreateNoteDto, UpdateNoteDto } from './note.dto.js';

export interface NotePage {
  items: Note[];
  nextCursor: string | null;
}

export interface ListNotesInput {
  cursor?: string;
  limit?: number;
}

/**
 * The list has one sort order, so its filter hash is constant. It is computed
 * rather than written out: the day a filter is added, the hash must change
 * with it, and a literal string would not.
 */
const LIST_FILTER = { sort: 'createdAt:desc,id:desc' } as const;

/**
 * Notes, as a feature sees them.
 *
 * Permission first, then work. The check is a pure function of the principal
 * the request resolved, so it costs nothing and is safe to make inside the
 * transaction the repository opens.
 */
@Injectable()
export class NotesService {
  private readonly notes: NoteRepository;
  private readonly authz: AuthzService;
  private readonly db: Database;
  private readonly outbox: OutboxRepository;
  private readonly realtime: RealtimeBus;
  private readonly logger = new Logger(NotesService.name);

  constructor(
    @Inject(NoteRepository) notes: NoteRepository,
    @Inject(AuthzService) authz: AuthzService,
    @Inject(Database) db: Database,
    @Inject(OutboxRepository) outbox: OutboxRepository,
    @Inject(RealtimeBus) realtime: RealtimeBus,
  ) {
    this.notes = notes;
    this.authz = authz;
    this.db = db;
    this.outbox = outbox;
    this.realtime = realtime;
  }

  // Every method is `async`, including the ones whose body is a single call:
  // a permission refusal thrown synchronously would escape the promise chain,
  // and a caller's `.catch()` would never see it.
  async create(principal: Principal, input: CreateNoteDto): Promise<Note> {
    const orgId = this.organisationOf(principal);
    this.authz.require(principal, 'note.create', { orgId });

    // One transaction around both. The repository opens its own when none is
    // active and joins this one when there is, so without the wrapper the note
    // and the event would commit separately — which is the single failure the
    // outbox exists to remove.
    //
    // The permission check stays outside it: every refusal would otherwise
    // open a transaction and roll it back, spending a pool connection to say
    // no.
    const note = await this.db.withRequestTransaction(async () => {
      const created = await this.notes.create(orgId, {
        title: input.title,
        body: input.body,
      });

      await this.publish(noteCreated, orgId, created);
      return created;
    });

    // **After the commit, never inside it.** A realtime message announcing a
    // note that then rolled back is a lie the browser cannot detect, and there
    // is no second message that takes it back. The opposite failure — a
    // committed note nobody was told about — the client recovers from by
    // re-reading, which is all realtime ever promises.
    //
    // Separate from the outbox event above, and deliberately so: that one is
    // durable and this one is not. Redis Pub/Sub stores nothing, so a browser
    // between reconnects misses it either way, and giving this a delivery
    // guarantee would be a guarantee the client cannot honour.
    await this.announce(orgId, note);

    return note;
  }

  /** Tells whoever is watching the organization's stream. */
  private async announce(orgId: string, note: Note): Promise<void> {
    try {
      await this.realtime.publish({ kind: 'org', orgId }, 'note.created', {
        id: note.id,
        title: note.title,
      });
    } catch (failure) {
      // Swallowed: the note is written and answering 500 now would tell the
      // caller their write failed when it did not. Best effort means this.
      this.logger.warn(
        `Created ${note.id} and could not announce it: ${
          failure instanceof Error ? failure.message : String(failure)
        }`,
      );
    }
  }

  async list(principal: Principal, input: ListNotesInput = {}): Promise<NotePage> {
    this.authz.require(principal, 'note.read', {
      orgId: this.organisationOf(principal),
    });

    const limit = resolvePageLimit(input.limit);
    const filterHash = hashPaginationFilter(LIST_FILTER);
    const position = input.cursor ? decodeCursor(input.cursor, filterHash) : undefined;

    // One extra row is the cheapest way to know whether another page exists
    // without a second COUNT query.
    const rows = await this.notes.list({
      take: limit + 1,
      after: position ? { createdAt: position.sortKey, id: position.id } : undefined,
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

  async find(principal: Principal, id: string): Promise<Note> {
    this.authz.require(principal, 'note.read', {
      orgId: this.organisationOf(principal),
    });

    const note = await this.notes.find(id);

    if (!note) {
      // A note in another organization is invisible, so this is the same
      // answer for "does not exist" and "not yours" — which is the answer
      // that leaks nothing.
      throw new NotFoundException('That note does not exist.');
    }

    return note;
  }

  async update(
    principal: Principal,
    id: string,
    input: UpdateNoteDto,
  ): Promise<Note> {
    this.authz.require(principal, 'note.update', {
      orgId: this.organisationOf(principal),
      resourceId: id,
    });

    const orgId = this.organisationOf(principal);

    return this.db.withRequestTransaction(async () => {
      const note = await this.notes.update(id, {
        title: input.title,
        body: input.body,
        expectedVersion: input.version,
      });

      await this.publish(noteUpdated, orgId, note);
      return note;
    });
  }

  async remove(principal: Principal, id: string): Promise<void> {
    const orgId = this.organisationOf(principal);
    this.authz.require(principal, 'note.delete', { orgId, resourceId: id });

    await this.db.withRequestTransaction(async () => {
      const removed = await this.notes.remove(id);

      // Deleting something already gone stays a success, so there is nothing
      // to announce: an event here would tell a consumer that a note was
      // deleted every time somebody retried a delete they had already made.
      if (removed) {
        await this.publish(noteDeleted, orgId, removed);
      }
    });
  }

  /**
   * Records that something happened to a note.
   *
   * Metadata, never the note itself. A payload outlives the row it describes
   * by the outbox's retention window and by however long a consumer keeps what
   * it derived from it, so putting the text here would mean a deleted note's
   * contents surviving in tables no erasure procedure knows about.
   */
  private publish(
    event: EventDefinition<{
      noteId: string;
      orgId: string;
      version: number;
      titleLength: number;
      bodyLength: number;
    }>,
    orgId: string,
    note: Note,
  ): Promise<void> {
    return this.outbox.append({
      aggregateType: event.aggregate,
      aggregateId: note.id,
      aggregateVersion: note.version,
      eventType: event.type,
      payload: event.payload.parse({
        noteId: note.id,
        orgId,
        version: note.version,
        titleLength: note.title.length,
        bodyLength: note.body.length,
      }),
    });
  }

  /**
   * Notes belong to an organization, so a caller without one has nowhere to
   * put them. That is a 403 rather than a 404: the route exists, the caller
   * simply is not acting anywhere it applies.
   */
  private organisationOf(principal: Principal): string {
    const orgId = principal.type === 'system' ? undefined : principal.orgId;

    if (!orgId) {
      throw new ForbiddenException(
        'Notes belong to an organization. Choose one before using this route.',
      );
    }

    return orgId;
  }
}
