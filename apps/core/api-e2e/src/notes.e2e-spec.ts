import { beforeAll, describe, expect, it } from 'vitest';

const API_URL = process.env['API_URL'] ?? 'http://localhost:3000';
const ORIGIN = 'http://localhost:4200';

let sequence = 0;

interface Member {
  cookie: string;
  orgId: string;
}

/**
 * The reference feature, end to end.
 *
 * Every layer the platform has is on this path: a session, an active
 * organization, roles read from the membership, the authorization facade, a
 * transaction that sets the tenant, and a row-level security policy underneath
 * it. A test here failing means one of them is wrong; that is the point of
 * having a reference feature at all.
 */
describe('notes', () => {
  let alice: Member;
  let bob: Member;

  beforeAll(async () => {
    alice = await signUpWithOrganisation();
    bob = await signUpWithOrganisation();
  });

  it('creates one and points at it', async () => {
    const response = await request('POST', '/api/v1/notes', alice, {
      title: 'First',
      body: 'Hello',
    });

    expect(response.status).toBe(201);
    const note = (await response.json()) as { id: string; version: number };
    expect(response.headers.get('location')).toBe(`/api/v1/notes/${note.id}`);
    expect(note.version).toBe(1);
  });

  it('lists only the organization’s own notes', async () => {
    await request('POST', '/api/v1/notes', alice, { title: "Alice's", body: '' });
    await request('POST', '/api/v1/notes', bob, { title: "Bob's", body: '' });

    const response = await request('GET', '/api/v1/notes', alice);
    const page = (await response.json()) as { items: { title: string }[] };

    // Not a `where` clause the service remembered to write: the query asks for
    // notes, and the database supplies the tenant.
    expect(page.items.map((n) => n.title)).not.toContain("Bob's");
    expect(page.items.map((n) => n.title)).toContain("Alice's");
  });

  it('hides another organization’s note behind a 404', async () => {
    const created = await request('POST', '/api/v1/notes', bob, {
      title: 'Private',
      body: '',
    });
    const note = (await created.json()) as { id: string };

    const response = await request('GET', `/api/v1/notes/${note.id}`, alice);

    // The same answer as "does not exist", which is the answer that leaks
    // nothing about what other organizations hold.
    expect(response.status).toBe(404);
  });

  it('refuses an edit based on a version that has moved on', async () => {
    const created = await request('POST', '/api/v1/notes', alice, {
      title: 'Contested',
      body: '',
    });
    const note = (await created.json()) as { id: string; version: number };

    const first = await request('PATCH', `/api/v1/notes/${note.id}`, alice, {
      title: 'Edited once',
      version: note.version,
    });
    expect(first.status).toBe(200);

    // The second editor read version 1, as the first did.
    const stale = await request('PATCH', `/api/v1/notes/${note.id}`, alice, {
      title: 'Edited twice',
      version: note.version,
    });

    expect(stale.status).toBe(409);
    const problem = (await stale.json()) as { type: string };
    expect(problem.type).toContain('conflict');
  });

  it('raises the version on every accepted edit', async () => {
    const created = await request('POST', '/api/v1/notes', alice, {
      title: 'Versioned',
      body: '',
    });
    const note = (await created.json()) as { id: string; version: number };

    const updated = await request('PATCH', `/api/v1/notes/${note.id}`, alice, {
      body: 'changed',
      version: note.version,
    });
    const after = (await updated.json()) as { version: number };

    expect(after.version).toBe(note.version + 1);
  });

  it('deletes, and deleting again is still success', async () => {
    const created = await request('POST', '/api/v1/notes', alice, {
      title: 'Temporary',
      body: '',
    });
    const note = (await created.json()) as { id: string };

    const first = await request('DELETE', `/api/v1/notes/${note.id}`, alice);
    const second = await request('DELETE', `/api/v1/notes/${note.id}`, alice);

    // A client retrying a delete it never saw the answer to must not be told
    // the resource vanished mysteriously.
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
  });

  it('refuses a caller with no organization', async () => {
    const { cookie } = await signUp();

    const response = await request('GET', '/api/v1/notes', { cookie });

    // 403, not 404: the route exists, the caller is simply not acting
    // anywhere it applies.
    expect(response.status).toBe(403);
  });

  it('refuses an anonymous caller', async () => {
    const response = await fetch(`${API_URL}/api/v1/notes`);

    expect(response.status).toBe(403);
  });

  it('rejects a malformed identifier before looking anything up', async () => {
    const response = await request('GET', '/api/v1/notes/not-a-uuid', alice);

    expect(response.status).toBe(400);
  });

  it('pages without repeating or skipping a note', async () => {
    const fresh = await signUpWithOrganisation();
    for (let i = 0; i < 7; i += 1) {
      await request('POST', '/api/v1/notes', fresh, {
        title: `page-${i}`,
        body: '',
      });
    }

    const titles: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 10; page += 1) {
      const path = cursor
        ? `/api/v1/notes?limit=3&cursor=${encodeURIComponent(cursor)}`
        : '/api/v1/notes?limit=3';
      const response = await request('GET', path, fresh);
      const body = (await response.json()) as {
        items: { title: string }[];
        nextCursor: string | null;
      };

      titles.push(...body.items.map((n) => n.title));
      if (body.nextCursor === null) break;
      cursor = body.nextCursor;
    }

    expect(titles).toHaveLength(7);
    expect(new Set(titles).size).toBe(7);
  });
});

async function signUp(): Promise<{ cookie: string }> {
  const email = `notes-${Date.now()}-${(sequence += 1)}@example.com`;
  const response = await fetch(`${API_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email, password: 'password123', name: 'Notes User' }),
  });

  if (!response.ok) {
    throw new Error(`sign-up failed: ${response.status} ${await response.text()}`);
  }

  const cookie = (response.headers.get('set-cookie') ?? '')
    .split(/,(?=[^;]+=)/)
    .map((part) => part.split(';')[0].trim())
    .join('; ');

  return { cookie };
}

async function signUpWithOrganisation(): Promise<Member> {
  const { cookie } = await signUp();

  const created = await fetch(`${API_URL}/api/auth/organization/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
    body: JSON.stringify({
      name: `Org ${(sequence += 1)}`,
      slug: `notes-org-${Date.now()}-${sequence}`,
    }),
  });
  const org = (await created.json()) as { id: string };

  await fetch(`${API_URL}/api/auth/organization/set-active`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
    body: JSON.stringify({ organizationId: org.id }),
  });

  return { cookie, orgId: org.id };
}

function request(
  method: string,
  path: string,
  member: { cookie: string },
  body?: unknown,
): Promise<Response> {
  return fetch(`${API_URL}${path}`, {
    method,
    headers: {
      cookie: member.cookie,
      origin: ORIGIN,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
