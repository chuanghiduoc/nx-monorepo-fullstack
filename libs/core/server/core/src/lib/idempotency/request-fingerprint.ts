import { createHash } from 'node:crypto';

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
    .update(canonicalise(body))
    .digest('hex');
}

function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalise).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalise(item)}`);

  return `{${entries.join(',')}}`;
}
