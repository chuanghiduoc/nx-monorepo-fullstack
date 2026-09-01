/**
 * JSON with a stable key order.
 *
 * Object key order carries no meaning in JSON, so two serialisations of the
 * same value must hash to the same thing. Idempotency uses this so a client
 * that serialises differently on retry is not told its request changed;
 * pagination uses it so the filter hash of a query does not depend on how the
 * query object happened to be built.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);

  return `{${entries.join(',')}}`;
}
