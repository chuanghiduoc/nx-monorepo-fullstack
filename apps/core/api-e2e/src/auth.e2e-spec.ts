import { describe, expect, it } from 'vitest';

import { UNTRUSTING_API_URL } from './global-setup.js';

const API_URL = process.env['API_URL'] ?? 'http://localhost:3000';
// better-auth refuses a state-changing call with no Origin (MISSING_OR_NULL_ORIGIN),
// which is its own CSRF protection and separate from our origin-check guard.
const ORIGIN = 'http://localhost:4200';

interface SignedUp {
  cookie: string;
  email: string;
}

let sequence = 0;

async function signUp(): Promise<SignedUp> {
  const email = `auth-${Date.now()}-${(sequence += 1)}@example.com`;
  const response = await fetch(`${API_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email, password: 'password123', name: 'Test User' }),
  });

  if (!response.ok) {
    throw new Error(`sign-up failed: ${response.status} ${await response.text()}`);
  }

  const cookie = (response.headers.get('set-cookie') ?? '')
    .split(/,(?=[^;]+=)/)
    .map((part) => part.split(';')[0].trim())
    .join('; ');

  return { cookie, email };
}

const authed = (cookie: string, init: RequestInit = {}) => ({
  ...init,
  headers: { ...(init.headers ?? {}), cookie },
});

describe('sessions persist in the database', () => {
  it('signs up, reads the session back, and signs out', async () => {
    const { cookie, email } = await signUp();

    const session = await fetch(`${API_URL}/api/auth/get-session`, authed(cookie));
    const body = (await session.json()) as { user?: { email: string } } | null;
    expect(body?.user?.email).toBe(email);

    const signedOut = await fetch(`${API_URL}/api/auth/sign-out`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(signedOut.ok).toBe(true);

    // The Prisma adapter is wired to a real database, so the session is gone
    // for good rather than until the next restart.
    const after = await fetch(`${API_URL}/api/auth/get-session`, authed(cookie));
    await expect(after.json()).resolves.toBeNull();
  });

  it('signs in again with the same credentials', async () => {
    const { email } = await signUp();

    const response = await fetch(`${API_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email, password: 'password123' }),
    });

    expect(response.status).toBe(200);
  });

  it('refuses the wrong password without saying which part was wrong', async () => {
    const { email } = await signUp();

    const response = await fetch(`${API_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email, password: 'not-the-password' }),
    });

    expect(response.status).toBe(401);
    const body = await response.text();
    // Naming the failing field would confirm which addresses are registered.
    expect(body.toLowerCase()).not.toContain('password is');
  });
});

describe('organizations', () => {
  it('creates one, makes it active, and lists it', async () => {
    const { cookie } = await signUp();
    const slug = `org-${Date.now()}`;

    const created = await fetch(
      `${API_URL}/api/auth/organization/create`,
      authed(cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ name: 'Test Org', slug }),
      }),
    );
    expect(created.status).toBe(200);
    const org = (await created.json()) as { id: string };

    const activated = await fetch(
      `${API_URL}/api/auth/organization/set-active`,
      authed(cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ organizationId: org.id }),
      }),
    );
    expect(activated.status).toBe(200);

    // The session now carries the active organization — the value the tenant
    // context is resolved from in Task 4.
    const session = await fetch(`${API_URL}/api/auth/get-session`, authed(cookie));
    const body = (await session.json()) as {
      session: { activeOrganizationId: string | null };
    };
    expect(body.session.activeOrganizationId).toBe(org.id);
  });

  it('does not hide other members’ organizations behind the active one', async () => {
    // better-auth's tables are class AUTH and carry no tenant RLS on purpose:
    // a user must see every organization they belong to before any of them is
    // active.
    const { cookie } = await signUp();

    for (const name of ['First', 'Second']) {
      const response = await fetch(
        `${API_URL}/api/auth/organization/create`,
        authed(cookie, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          body: JSON.stringify({
            name,
            slug: `${name.toLowerCase()}-${Date.now()}-${(sequence += 1)}`,
          }),
        }),
      );
      expect(response.status).toBe(200);
    }

    const listed = await fetch(
      `${API_URL}/api/auth/organization/list`,
      authed(cookie),
    );
    const organizations = (await listed.json()) as { name: string }[];

    expect(organizations.map((o) => o.name).sort()).toEqual(['First', 'Second']);
  });
});

describe('api keys', () => {
  async function createKey(cookie: string): Promise<string> {
    const response = await fetch(
      `${API_URL}/api/auth/api-key/create`,
      authed(cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ name: 'e2e' }),
      }),
    );

    if (!response.ok) {
      throw new Error(`key creation failed: ${response.status} ${await response.text()}`);
    }

    const key = (await response.json()) as { key: string };
    return key.key;
  }

  it('never authenticates a session route', async () => {
    // enableSessionForAPIKeys is off (auth.options.ts). With it on, a valid
    // key would mock a session on *every* endpoint — the vendor's own
    // documentation calls that "not recommended for production use", and it
    // would make "this route requires a session" meaningless.
    const { cookie } = await signUp();
    const key = await createKey(cookie);

    const response = await fetch(`${API_URL}/api/auth/get-session`, {
      headers: { 'x-api-key': key },
    });

    await expect(response.json()).resolves.toBeNull();
  });

  it('does not expose verification over HTTP', async () => {
    // The plugin's HTTP surface is create/get/list/update/delete. Verifying a
    // key is `auth.api.verifyApiKey`, called by the server itself — Task 4's
    // request hook. An endpoint that verified a key for anyone who asked would
    // be an oracle for guessing them.
    const response = await fetch(`${API_URL}/api/auth/api-key/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ key: 'anything' }),
    });

    expect(response.status).toBe(404);
  });

  it('stores keys hashed, so a database read does not hand them out', async () => {
    const { cookie } = await signUp();
    const key = await createKey(cookie);

    const listed = await fetch(`${API_URL}/api/auth/api-key/list`, authed(cookie));
    const { apiKeys } = (await listed.json()) as {
      apiKeys: { start: string | null }[];
    };

    expect(apiKeys).toHaveLength(1);
    // `start` identifies the key in a UI without being the key. The secret
    // itself is returned once, at creation, and stored hashed.
    expect(apiKeys[0].start).toBe(key.slice(0, 6));
    expect(JSON.stringify(apiKeys)).not.toContain(key);
  });
});

describe('two-factor authentication', () => {
  it('is off until a user enables it, and enabling requires the password', async () => {
    const { cookie } = await signUp();

    const refused = await fetch(
      `${API_URL}/api/auth/two-factor/enable`,
      authed(cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ password: 'wrong-password' }),
      }),
    );
    expect(refused.ok).toBe(false);

    const enabled = await fetch(
      `${API_URL}/api/auth/two-factor/enable`,
      authed(cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ password: 'password123' }),
      }),
    );

    expect(enabled.status).toBe(200);
    const body = (await enabled.json()) as { totpURI: string; backupCodes: string[] };
    expect(body.totpURI).toContain('otpauth://');
    expect(body.backupCodes.length).toBeGreaterThan(0);
  });
});

describe('the request knows who is asking', () => {
  it('reports an organization member as acting in that organization', async () => {
    const { cookie } = await signUp();
    const created = await fetch(
      `${API_URL}/api/auth/organization/create`,
      authed(cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ name: 'Whoami', slug: `whoami-${Date.now()}` }),
      }),
    );
    const org = (await created.json()) as { id: string };

    await fetch(
      `${API_URL}/api/auth/organization/set-active`,
      authed(cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ organizationId: org.id }),
      }),
    );

    const who = await fetch(`${API_URL}/api/whoami`, authed(cookie));
    const body = (await who.json()) as {
      principal: { type: string } | null;
      tenant: { kind: string; orgId?: string } | null;
    };

    expect(body.principal?.type).toBe('user');
    expect(body.tenant).toEqual({ kind: 'org', orgId: org.id, userId: expect.any(String) });
  });

  it('reports a signed-in user with no organization as their own tenant', async () => {
    const { cookie } = await signUp();

    const who = await fetch(`${API_URL}/api/whoami`, authed(cookie));
    const body = (await who.json()) as { tenant: { kind: string } | null };

    // Not "no tenant": rows they own with no organization are theirs.
    expect(body.tenant?.kind).toBe('user');
  });

  it('reports an anonymous request as having no identity at all', async () => {
    const who = await fetch(`${API_URL}/api/whoami`);
    const body = (await who.json()) as { principal: null; tenant: null };

    expect(body.principal).toBeNull();
    expect(body.tenant).toBeNull();
  });

  it('resolves an api key to the key, never to a session', async () => {
    const { cookie } = await signUp();
    const key = await (async () => {
      const response = await fetch(
        `${API_URL}/api/auth/api-key/create`,
        authed(cookie, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          body: JSON.stringify({ name: 'whoami' }),
        }),
      );
      return ((await response.json()) as { key: string }).key;
    })();

    // Both credentials present: the key wins and the cookie is not consulted,
    // so a leaked key cannot ride someone's browser session.
    const who = await fetch(`${API_URL}/api/whoami`, {
      headers: { cookie, 'x-api-key': key },
    });
    const body = (await who.json()) as { principal: { type: string } | null };

    expect(body.principal?.type).toBe('apiKey');
  });

  it('treats an invalid api key as no identity, not as a session', async () => {
    const { cookie } = await signUp();

    const who = await fetch(`${API_URL}/api/whoami`, {
      headers: { cookie, 'x-api-key': 'not-a-key-anyone-issued' },
    });
    const body = (await who.json()) as { principal: null };

    // Falling back to the cookie here would let anyone with a session bypass
    // whatever the key was supposed to restrict.
    expect(body.principal).toBeNull();
  });
});

describe('the client address behind a proxy', () => {
  it('takes the forwarded address from a hop it was told to trust', async () => {
    // The suite runs the service with TRUSTED_PROXIES covering loopback, which
    // is where these requests come from — the same shape as an edge in front
    // of the service.
    const who = await fetch(`${API_URL}/api/whoami`, {
      headers: { 'x-forwarded-for': '203.0.113.99' },
    });
    const { ip } = (await who.json()) as { ip: string };

    expect(ip).toBe('203.0.113.99');
  });

  it('ignores a forwarded address from a hop it was not told to trust', async () => {
    // The direction that actually protects anything. The main instance trusts
    // loopback, so on it this header is always honoured; this one trusts a
    // single address these requests can never come from.
    const who = await fetch(`${UNTRUSTING_API_URL}/api/whoami`, {
      headers: { 'x-forwarded-for': '203.0.113.99' },
    });
    const { ip } = (await who.json()) as { ip: string };

    expect(ip).not.toBe('203.0.113.99');
    expect(ip).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
  });

  it('is what every per-caller decision uses', async () => {
    // Rate limiting, the per-organization IP allowlist and the logs all read
    // request.ip. If it could be set by the caller, none of them would mean
    // anything — which is why the trusted hops are named rather than assumed.
    const first = await fetch(`${API_URL}/api/whoami`);
    const { ip } = (await first.json()) as { ip: string };

    expect(ip).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
  });
});

describe('the per-organization IP allowlist', () => {
  async function organisationFor(cookie: string): Promise<string> {
    const created = await fetch(
      `${API_URL}/api/auth/organization/create`,
      authed(cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ name: 'Guarded', slug: `guarded-${Date.now()}-${(sequence += 1)}` }),
      }),
    );
    const org = (await created.json()) as { id: string };

    await fetch(
      `${API_URL}/api/auth/organization/set-active`,
      authed(cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ organizationId: org.id }),
      }),
    );

    return org.id;
  }

  it('lets a member through when the organization has set no allowlist', async () => {
    const { cookie } = await signUp();
    await organisationFor(cookie);

    const response = await fetch(`${API_URL}/api/whoami`, authed(cookie));

    // No allowlist is the absence of a rule, not a rule admitting nobody.
    expect(response.status).toBe(200);
  });

  it('does not touch a request that belongs to no organization', async () => {
    const { cookie } = await signUp();

    const response = await fetch(`${API_URL}/api/whoami`, authed(cookie));

    expect(response.status).toBe(200);
  });

  it('does not touch an anonymous request', async () => {
    const response = await fetch(`${API_URL}/api`);

    expect(response.status).toBe(200);
  });
});
