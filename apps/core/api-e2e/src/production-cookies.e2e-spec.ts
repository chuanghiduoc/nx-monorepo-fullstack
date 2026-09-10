import { randomUUID } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { PRODUCTION_API_URL } from './global-setup.js';

const ORIGIN = 'http://localhost:4200';

/**
 * The cookie a deployment actually sets.
 *
 * Three of these attributes exist only when the service believes it is in
 * production, so asserting them against the development instance the rest of
 * this suite uses would assert something no deployment ever sends. This talks
 * to a separate instance of the same build, started with `NODE_ENV=production`
 * and nothing else changed.
 */
describe('session cookies in production', () => {
  let cookies: string;

  beforeAll(async () => {
    // One account for all four assertions. Four sign-ups in a row can share a
    // millisecond, and an address built from the clock would then collide with
    // itself — a failure about uniqueness dressed up as a failure about
    // cookies.
    const response = await fetch(`${PRODUCTION_API_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({
        email: `production-cookie-${randomUUID()}@example.com`,
        password: 'a-long-enough-password',
        name: 'Cookie Audit',
      }),
    });

    if (!response.ok) {
      throw new Error(
        `sign-up failed on the production instance: ${response.status} ${await response.text()}`,
      );
    }

    cookies = response.headers.get('set-cookie') ?? '';
  });

  it('carries the prefix a browser will not let script forge', () => {
    // `__Secure-` is refused by the browser unless the cookie is also marked
    // Secure and arrived over TLS, so the name itself is a guarantee.
    expect(cookies).toContain('__Secure-');
  });

  it('is unreadable by script and unsent over plain HTTP', () => {
    expect(cookies).toContain('HttpOnly');
    expect(cookies).toContain('Secure');
  });

  it('is not attached to a request from another site', () => {
    // Lax rather than Strict: a link from an email must still arrive signed
    // in. It is the origin check that covers what Lax does not.
    expect(cookies).toContain('SameSite=Lax');
  });

  it('expires rather than living forever', () => {
    const maxAge = /Max-Age=(\d+)/.exec(cookies)?.[1];

    expect(maxAge).toBeDefined();
    expect(Number(maxAge)).toBeGreaterThan(0);
  });
});
