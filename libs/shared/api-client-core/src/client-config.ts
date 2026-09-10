import type { CreateClientConfig } from './generated/client.gen.js';

const DEFAULT_API_URL = 'http://localhost:3000';

/**
 * Where the API lives, from whichever side is asking.
 *
 * A browser bundle only carries variables the framework inlined, which is why
 * the public origin is read first: on the server both names are readable and
 * `API_URL` may point at an address only the server can reach. Falling back to
 * localhost fails towards local development rather than towards a relative
 * fetch against whatever host happens to be serving the page.
 */
function baseUrl(): string {
  return (
    process.env['NEXT_PUBLIC_API_ORIGIN'] ??
    process.env['API_URL'] ??
    DEFAULT_API_URL
  );
}

/**
 * Called by the generated client when it is created.
 *
 * Credentials travel on every request because the session is a cookie. Without
 * this the browser omits it on any cross-origin call and every request arrives
 * anonymous, which the API answers with 403 — a failure that looks like broken
 * authorisation rather than a missing option.
 */
export const createClientConfig: CreateClientConfig = (config) => ({
  ...config,
  baseUrl: baseUrl(),
  credentials: 'include',
});
