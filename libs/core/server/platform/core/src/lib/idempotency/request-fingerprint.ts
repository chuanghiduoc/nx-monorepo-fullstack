import { createHash } from 'node:crypto';

import { canonicalJson } from '../serialisation/canonical-json.js';

/**
 * Method plus path, without the query string.
 *
 * The route is part of the idempotency identity so one key cannot mean two
 * different operations; the query string is not, because it does not identify
 * the route.
 */
export function normaliseRoute(method: string, url: string): string {
  const path = url.split('?')[0].replace(/\/+$/, '') || '/';

  return `${method.toUpperCase()}:${path}`;
}

/**
 * A fingerprint of the request that a retry of the *same* request reproduces.
 *
 * Object key order carries no meaning in JSON, so it is normalised away —
 * otherwise a client that serialises differently on retry would be told its
 * request had changed.
 */
export function fingerprintRequest(
  method: string,
  url: string,
  body: unknown,
): string {
  return createHash('sha256')
    .update(normaliseRoute(method, url))
    .update('\n')
    .update(canonicalJson(body))
    .digest('hex');
}
