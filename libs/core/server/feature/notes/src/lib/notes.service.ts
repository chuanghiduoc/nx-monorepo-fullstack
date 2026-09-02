import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuthzService, type Principal } from '@workspace/core-server-authz';
import {
  decodeCursor,
  encodeCursor,
  hashPaginationFilter,
  resolvePageLimit,
} from '@workspace/core-server-core';
import { NoteRepository, type Note } from '@workspace/core-server-data-access-db';

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

  constructor(
    @Inject(NoteRepository) notes: NoteRepository,
    @Inject(AuthzService) authz: AuthzService,
  ) {
    this.notes = notes;
    this.authz = authz;
  }

  // Every method is `async`, including the ones whose body is a single call:
  // a permission refusal thrown synchronously would escape the promise chain,
  // and a caller's `.catch()` would never see it.
  async create(principal: Principal, input: CreateNoteDto): Promise<Note> {
    const orgId = this.organisationOf(principal);
    this.authz.require(principal, 'note.create', { orgId });

    return this.notes.create(orgId, { title: input.title, body: input.body });
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

    return this.notes.update(id, {
      title: input.title,
      body: input.body,
      expectedVersion: input.version,
    });
  }

  async remove(principal: Principal, id: string): Promise<void> {
    this.authz.require(principal, 'note.delete', {
      orgId: this.organisationOf(principal),
      resourceId: id,
    });

    await this.notes.remove(id);
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
