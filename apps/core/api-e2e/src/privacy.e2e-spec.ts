import { beforeAll, describe, expect, it } from 'vitest';

const API_URL = process.env['API_URL'] ?? 'http://localhost:3000';
const ORIGIN = 'http://localhost:4200';

let sequence = 0;

interface Member {
  cookie: string;
  orgId: string;
}

/**
 * The routes a person and an organization use to control their own data.
 *
 * Two things are being checked and only one of them is the happy path. The
 * other is that neither route can do the dangerous half: the erasure request
 * writes a date and deletes nothing, and no response anywhere returns a
 * webhook secret except the one that created it.
 */
describe('privacy and webhooks', () => {
  let alice: Member;
  let bob: Member;

  beforeAll(async () => {
    alice = await signUpWithOrganisation();
    bob = await signUpWithOrganisation();
  });

  describe('asking to be forgotten', () => {
    it('reports no request for an account that has not made one', async () => {
      const response = await request('GET', '/api/v1/me/erasure', bob);
      const body = (await response.json()) as {
        erasureRequestedAt: string | null;
      };

      expect(response.status).toBe(200);
      expect(body.erasureRequestedAt).toBeNull();
    });

    it('schedules one and says when it happens', async () => {
      const member = await signUpWithOrganisation();

      const response = await request('POST', '/api/v1/me/erasure', member);
      const body = (await response.json()) as {
        erasureRequestedAt: string;
        erasesAt: string;
        graceDays: number;
      };

      // The date matters more than the acknowledgement: it is the deadline for
      // changing their mind, and a bare "accepted" leaves them to guess it.
      expect(response.status).toBe(201);
      expect(body.graceDays).toBeGreaterThan(0);
      expect(Date.parse(body.erasesAt)).toBeGreaterThan(
        Date.parse(body.erasureRequestedAt),
      );
    });

    it('still lets the account work during the window', async () => {
      const member = await signUpWithOrganisation();
      await request('POST', '/api/v1/me/erasure', member);

      // Nothing is deleted yet. An account that stopped working the moment it
      // was scheduled would make the grace window unusable — the whole point
      // of it is that a person can change their mind.
      const notes = await request('GET', '/api/v1/notes', member);
      expect(notes.status).toBe(200);
    });

    it('does not extend the window when asked twice', async () => {
      const member = await signUpWithOrganisation();

      const first = (await (
        await request('POST', '/api/v1/me/erasure', member)
      ).json()) as { erasureRequestedAt: string };
      const second = (await (
        await request('POST', '/api/v1/me/erasure', member)
      ).json()) as { erasureRequestedAt: string };

      // A person who asked on the first and again on the tenth expects the
      // first date to hold. Extending it silently would be the wrong direction
      // for a promise.
      expect(second.erasureRequestedAt).toBe(first.erasureRequestedAt);
    });

    it('lets them change their mind', async () => {
      const member = await signUpWithOrganisation();
      await request('POST', '/api/v1/me/erasure', member);

      expect((await request('DELETE', '/api/v1/me/erasure', member)).status).toBe(
        200,
      );

      const after = (await (
        await request('GET', '/api/v1/me/erasure', member)
      ).json()) as { erasureRequestedAt: string | null };
      expect(after.erasureRequestedAt).toBeNull();
    });

    it('refuses a caller with no session', async () => {
      const response = await fetch(`${API_URL}/api/v1/me/erasure`, {
        method: 'POST',
        headers: { origin: ORIGIN },
      });

      // 403 rather than 401, which is what `CurrentPrincipal` raises
      // everywhere in this API. Arguably 401 is the better code — the caller
      // is unauthenticated rather than forbidden — but it is one decision for
      // every route, not one this feature gets to make differently, and a
      // route that answered 401 while the rest answered 403 would be worse
      // than either.
      expect(response.status).toBe(403);
    });
  });

  describe('webhook endpoints', () => {
    it('returns the secret once, and never again', async () => {
      const created = await request('POST', '/api/v1/webhooks', alice, {
        url: 'https://example.com/hook',
        eventTypes: ['note.created'],
      });
      const body = (await created.json()) as { id: string; secret: string };

      expect(created.status).toBe(201);
      expect(body.secret).toMatch(/^[A-Za-z0-9_-]{20,}$/);

      // Not because the handler chooses to omit it: `app_user` holds a
      // column-level SELECT that excludes the column, so no route can read it
      // back even if one tried.
      const listed = (await (
        await request('GET', '/api/v1/webhooks', alice)
      ).json()) as { items: Record<string, unknown>[] };

      const found = listed.items.find((item) => item['id'] === body.id);
      expect(found).toBeDefined();
      expect(found).not.toHaveProperty('secret');
    });

    it('refuses an endpoint pointing inside our own network', async () => {
      const response = await request('POST', '/api/v1/webhooks', alice, {
        url: 'http://localhost:9999/hook',
      });

      // Refused at creation as well as at delivery. Both are needed: this one
      // turns "the endpoint never fires" into a message while somebody can
      // still fix the URL, and the delivery-time one catches a name that
      // starts resolving somewhere else afterwards.
      expect(response.status).toBe(400);
      expect(await response.text()).toMatch(/resolves to|private/i);
    });

    it('refuses a URL carrying credentials', async () => {
      const response = await request('POST', '/api/v1/webhooks', alice, {
        url: 'https://user:pass@example.com/hook',
      });

      expect(response.status).toBe(400);
    });

    it('shows one organization nothing of another’s', async () => {
      await request('POST', '/api/v1/webhooks', alice, {
        url: 'https://example.com/alice',
      });

      const listed = (await (
        await request('GET', '/api/v1/webhooks', bob)
      ).json()) as { items: { url: string }[] };

      expect(listed.items.map((item) => item.url)).not.toContain(
        'https://example.com/alice',
      );
    });

    it('hides another organization’s endpoint behind a 404', async () => {
      const created = (await (
        await request('POST', '/api/v1/webhooks', alice, {
          url: 'https://example.com/hidden',
        })
      ).json()) as { id: string };

      // Not a 403: telling Bob the id exists is telling him something about
      // Alice's organization.
      const response = await request(
        'DELETE',
        `/api/v1/webhooks/${created.id}`,
        bob,
      );
      expect(response.status).toBe(404);
    });

    it('turns one off without deleting it', async () => {
      const created = (await (
        await request('POST', '/api/v1/webhooks', alice, {
          url: 'https://example.com/toggle',
        })
      ).json()) as { id: string };

      const patched = await request(
        'PATCH',
        `/api/v1/webhooks/${created.id}`,
        alice,
        { enabled: false },
      );
      expect(patched.status).toBe(204);

      const listed = (await (
        await request('GET', '/api/v1/webhooks', alice)
      ).json()) as { items: { id: string; enabled: boolean }[] };

      // A delivery that has been failing for a week is switched off by a
      // person, and the endpoint has to still be there for them to look at.
      expect(
        listed.items.find((item) => item.id === created.id)?.enabled,
      ).toBe(false);
    });

    it('refuses a change that changes nothing', async () => {
      const created = (await (
        await request('POST', '/api/v1/webhooks', alice, {
          url: 'https://example.com/empty-patch',
        })
      ).json()) as { id: string };

      const response = await request(
        'PATCH',
        `/api/v1/webhooks/${created.id}`,
        alice,
        {},
      );

      expect(response.status).toBe(400);
    });
  });
});

async function signUp(): Promise<{ cookie: string }> {
  const email = `privacy-${Date.now()}-${(sequence += 1)}@example.com`;
  const response = await fetch(`${API_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({
      email,
      password: 'password123',
      name: 'Privacy User',
    }),
  });

  if (!response.ok) {
    throw new Error(
      `sign-up failed: ${response.status} ${await response.text()}`,
    );
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
      slug: `privacy-org-${Date.now()}-${sequence}`,
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
