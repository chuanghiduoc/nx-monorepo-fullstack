import { describe, expect, it } from 'vitest';

const API_URL = process.env['API_URL'] ?? 'http://localhost:3000';
const ORIGIN = 'http://localhost:4200';

/**
 * What a browser is told it may do.
 *
 * Every one of these is invisible to a command-line client: a tool that sends
 * no origin gets an answer regardless, so a broken policy passes every other
 * test in this suite and breaks only the application.
 *
 * Each test asserts the origin was *accepted* as well as whatever else it
 * checks. The plugin emits the methods, the credentials flag and the reflected
 * headers whether or not the origin matched — so without that assertion these
 * would all stay green against a service configured for the wrong site, which
 * is the exact failure they exist to catch.
 */
describe('cross-origin policy', () => {
  const preflight = (method: string, headers = 'content-type') =>
    fetch(`${API_URL}/api/v1/notes/0199a1b2-0000-7000-8000-00000000000a`, {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': method,
        'access-control-request-headers': headers,
      },
    });

  it('accepts the origin the application is served from', async () => {
    const response = await preflight('GET');

    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('names every method the application actually uses', async () => {
    const response = await preflight('DELETE');
    const allowed = (response.headers.get('access-control-allow-methods') ?? '')
      .split(',')
      .map((method) => method.trim().toUpperCase());

    // The plugin's default is GET, HEAD and POST. A browser refuses anything
    // the preflight did not name, so an update or a delete from a page fails
    // while the same call from a tool succeeds.
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(allowed).toEqual(
      expect.arrayContaining(['GET', 'POST', 'PATCH', 'DELETE']),
    );
  });

  it('lets the browser send the session cookie', async () => {
    const response = await preflight('POST');

    // Without this the browser omits the cookie and every request arrives
    // anonymous, which reads as broken authorisation rather than a missing
    // header.
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(response.headers.get('access-control-allow-credentials')).toBe(
      'true',
    );
  });

  it('answers only the origins it was configured with', async () => {
    const response = await fetch(`${API_URL}/api`, {
      headers: { origin: 'https://evil.example' },
    });

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows the header idempotent writes are keyed by', async () => {
    const response = await preflight('POST', 'content-type,idempotency-key');
    const allowed = (
      response.headers.get('access-control-allow-headers') ?? ''
    ).toLowerCase();

    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(allowed).toContain('idempotency-key');
  });

  it('lets the browser read the headers the service sets on purpose', async () => {
    const response = await fetch(`${API_URL}/api`, {
      headers: { origin: ORIGIN },
    });
    const exposed = (
      response.headers.get('access-control-expose-headers') ?? ''
    ).toLowerCase();

    // Otherwise a page can read only the six safelisted headers, and the id a
    // caller is meant to quote when reporting a problem is invisible to the
    // one caller who would report it.
    expect(exposed).toContain('x-request-id');
    expect(exposed).toContain('retry-after');
    expect(exposed).toContain('location');
  });

  it('lets a browser reuse one preflight answer', async () => {
    const response = await preflight('PATCH');

    // Without a max-age every cross-origin edit pays two round trips instead
    // of one, for the life of the deployment.
    expect(Number(response.headers.get('access-control-max-age'))).toBeGreaterThan(
      0,
    );
  });
});
