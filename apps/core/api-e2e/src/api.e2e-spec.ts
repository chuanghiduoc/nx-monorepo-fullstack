import { describe, it, expect } from 'vitest';

const API_URL = process.env['API_URL'] ?? 'http://localhost:3000';

describe('core-api', () => {
  it('serves the root endpoint under the /api prefix', async () => {
    const response = await fetch(`${API_URL}/api`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ message: 'Hello API' });
  });

  it('returns a request id header so logs can be correlated', async () => {
    const response = await fetch(`${API_URL}/api`);

    expect(response.headers.get('x-request-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('continues a trace the caller already started', async () => {
    const response = await fetch(`${API_URL}/api`, {
      headers: { 'x-request-id': 'trace-from-the-edge' },
    });

    expect(response.headers.get('x-request-id')).toBe('trace-from-the-edge');
  });

  it('does not expose routes outside the /api prefix', async () => {
    const response = await fetch(`${API_URL}/`);

    expect(response.status).toBe(404);
  });
});

interface ProblemResponse {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  traceId: string;
  errors?: { path: string; message: string }[];
}

describe('error contract (RFC 9457)', () => {
  it('answers an unknown route with a problem document', async () => {
    const response = await fetch(`${API_URL}/api/definitely-not-here`);

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain(
      'application/problem+json',
    );
  });

  it('includes the members a client needs to act on and to report', async () => {
    const response = await fetch(`${API_URL}/api/definitely-not-here`);
    const problem = (await response.json()) as ProblemResponse;

    expect(problem).toMatchObject({
      type: expect.stringContaining('not-found'),
      title: 'Not Found',
      status: 404,
      instance: '/api/definitely-not-here',
    });
    expect(problem.traceId).toBeTruthy();
  });

  it('uses the same trace id in the body and the response header', async () => {
    const response = await fetch(`${API_URL}/api/definitely-not-here`, {
      headers: { 'x-request-id': 'known-trace' },
    });
    const problem = (await response.json()) as ProblemResponse;

    expect(problem.traceId).toBe('known-trace');
    expect(response.headers.get('x-request-id')).toBe('known-trace');
  });
});

describe('better-auth mount (ADR-0002)', () => {
  it('serves its own routes instead of falling through to Nest', async () => {
    const response = await fetch(`${API_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `spike-${Date.now()}@example.com`,
        password: 'password123',
        name: 'Spike',
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain(
      'better-auth.session_token',
    );
  });

  it('issues session cookies that scripts cannot read', async () => {
    const response = await fetch(`${API_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `cookie-${Date.now()}@example.com`,
        password: 'password123',
        name: 'Cookie',
      }),
    });

    const cookies = response.headers.get('set-cookie') ?? '';

    expect(cookies).toContain('HttpOnly');
    expect(cookies).toContain('SameSite=Lax');
  });

  it('returns no session when the request carries no cookie', async () => {
    const response = await fetch(`${API_URL}/api/auth/get-session`);

    // better-auth answers 200 with a literal null rather than an error, so an
    // anonymous request is indistinguishable from a wrong guess at a session.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toBeNull();
  });
});

describe('demo items (the reference feature)', () => {
  const ALLOWED_ORIGIN = 'http://localhost:4200';

  async function create(title: string, origin = ALLOWED_ORIGIN) {
    return fetch(`${API_URL}/api/v1/demo-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ title }),
    });
  }

  it('creates an item and points at it with Location', async () => {
    const response = await create(`item-${Date.now()}`);

    expect(response.status).toBe(201);
    expect(response.headers.get('location')).toMatch(/^\/api\/v1\/demo-items\//);
  });

  it('lets the database mint a version 7 uuid', async () => {
    const response = await create(`uuid-${Date.now()}`);
    const item = (await response.json()) as { id: string };

    // The 13th hex digit is the UUID version.
    expect(item.id[14]).toBe('7');
  });

  it('returns a page shaped {items, nextCursor}', async () => {
    const response = await fetch(`${API_URL}/api/v1/demo-items`);
    const page = (await response.json()) as { items: unknown[]; nextCursor: unknown };

    expect(Array.isArray(page.items)).toBe(true);
    expect(page).toHaveProperty('nextCursor');
  });

  it('rejects an empty title with field-level errors', async () => {
    const response = await create('');
    const problem = (await response.json()) as ProblemResponse;

    expect(response.status).toBe(400);
    expect(problem.errors?.[0]).toMatchObject({ path: 'title' });
  });

  it('rejects a state-changing request from another origin', async () => {
    const response = await create('csrf-attempt', 'https://evil.example.com');

    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toContain(
      'application/problem+json',
    );
  });

  it('rejects a state-changing request with no origin and no api key', async () => {
    const response = await fetch(`${API_URL}/api/v1/demo-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'no-origin' }),
    });

    expect(response.status).toBe(403);
  });

  it('never blocks a read, whatever the origin', async () => {
    const response = await fetch(`${API_URL}/api/v1/demo-items`, {
      headers: { Origin: 'https://evil.example.com' },
    });

    expect(response.status).toBe(200);
  });
});

describe('rate limiting', () => {
  // The suite runs the API with THROTTLE_LIMIT set low so the limit can be
  // reached without sending a hundred requests.
  const LIMIT = Number(process.env['THROTTLE_LIMIT'] ?? '20');

  it('answers with a problem document once the window is exhausted', async () => {
    let limited: Response | undefined;

    for (let attempt = 0; attempt <= LIMIT + 1; attempt += 1) {
      const response = await fetch(`${API_URL}/api`);
      if (response.status === 429) {
        limited = response;
        break;
      }
    }

    expect(limited).toBeDefined();
    expect(limited?.headers.get('content-type')).toContain(
      'application/problem+json',
    );
  });

  it('tells the client when to come back', async () => {
    const response = await fetch(`${API_URL}/api`);

    // Still limited from the previous test; the window has not elapsed.
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
