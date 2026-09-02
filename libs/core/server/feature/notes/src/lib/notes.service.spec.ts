import { NotFoundException } from '@nestjs/common';
import { AuthzService, type Principal } from '@workspace/core-server-authz';
import type { NoteRepository } from '@workspace/core-server-data-access-db';
import { describe, expect, it, vi } from 'vitest';

import { NotesService } from './notes.service.js';

const ORG = '0199a1b2-0000-7000-8000-00000000000a';

const rolePermissions = {
  member: { note: ['create', 'read', 'update', 'delete'] },
  observer: { note: ['read'] },
};

const member = (roles: string[]): Principal =>
  ({ type: 'user', id: 'user-1', orgId: ORG, roles }) as Principal;

/**
 * Signed in, but not acting inside any organization.
 *
 * A separate builder rather than `member(roles, undefined)`: passing undefined
 * to a parameter with a default silently gets the default, which is how this
 * test first passed while proving nothing.
 */
const memberWithoutOrganisation = (roles: string[]): Principal =>
  ({ type: 'user', id: 'user-1', roles }) as Principal;

/**
 * The decisions the service makes on its own, without a database.
 *
 * Isolation and storage are proven against a real PostgreSQL elsewhere; what
 * is worth testing here is the order of the checks — a permission refused
 * after the work has been done is not a permission at all.
 */
function serviceWith(repository: Partial<NoteRepository>) {
  return new NotesService(
    repository as NoteRepository,
    new AuthzService(rolePermissions),
  );
}

describe('permission comes before work', () => {
  it('refuses to create without the permission, and does not call the repository', async () => {
    const create = vi.fn();
    const notes = serviceWith({ create });

    await expect(
      notes.create(member(['observer']), { title: 'x', body: '' }),
    ).rejects.toThrow();

    expect(create).not.toHaveBeenCalled();
  });

  it('refuses to delete without the permission', async () => {
    const remove = vi.fn();
    const notes = serviceWith({ remove });

    await expect(notes.remove(member(['observer']), 'id')).rejects.toThrow();

    expect(remove).not.toHaveBeenCalled();
  });

  it('allows what the role grants', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'n1' });
    const notes = serviceWith({ create });

    await notes.create(member(['member']), { title: 'x', body: '' });

    expect(create).toHaveBeenCalledWith(ORG, { title: 'x', body: '' });
  });
});

describe('a caller with no organization', () => {
  it('is refused, because notes belong to one', async () => {
    const notes = serviceWith({});

    // 403, not 404: the route exists, the caller is simply not acting
    // anywhere it applies. Asserted by status rather than by class, because
    // two libraries each resolving @nestjs/common would each have their own
    // ForbiddenException and `instanceof` would compare the wrong pair.
    const refused = await notes
      .list(memberWithoutOrganisation(['member']))
      .then(() => undefined, (error: unknown) => error);

    expect((refused as { getStatus?: () => number }).getStatus?.()).toBe(403);
    expect((refused as Error).message).toMatch(/organization/i);
  });
});

describe('a note that is not there', () => {
  it('is reported as missing, whether it never existed or belongs elsewhere', async () => {
    const notes = serviceWith({ find: vi.fn().mockResolvedValue(undefined) });

    // Under the policy a note in another organization is invisible, so both
    // cases arrive here identically — which is the answer that leaks nothing.
    await expect(notes.find(member(['member']), 'id')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('paging', () => {
  it('asks for one row more than the page, to know whether another exists', async () => {
    const list = vi.fn().mockResolvedValue([]);
    const notes = serviceWith({ list });

    await notes.list(member(['member']), { limit: 10 });

    // The alternative is a second COUNT query on every page.
    expect(list).toHaveBeenCalledWith({ take: 11, after: undefined });
  });

  it('returns no cursor when the last page is exactly full', async () => {
    const page = Array.from({ length: 3 }, (_, i) => ({
      id: `n${i}`,
      title: `t${i}`,
      body: '',
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    const notes = serviceWith({ list: vi.fn().mockResolvedValue(page) });

    const result = await notes.list(member(['member']), { limit: 3 });

    // A `hasMore` derived from `items.length === limit` would hand out a
    // cursor to an empty page.
    expect(result.items).toHaveLength(3);
    expect(result.nextCursor).toBeNull();
  });

  it('refuses a limit outside the range rather than clamping it', async () => {
    const notes = serviceWith({ list: vi.fn() });

    await expect(
      notes.list(member(['member']), { limit: 10_000 }),
    ).rejects.toThrow(/limit/i);
  });
});
