import { describe, expect, it } from 'vitest';

import { envSchema } from './env.schema.js';

const base = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/app',
  REDIS_CRITICAL_URL: 'redis://localhost:6379',
  REDIS_CACHE_URL: 'redis://localhost:6380',
  BETTER_AUTH_SECRET: 'a-development-secret-of-at-least-32-chars',
};

describe('trusted proxies', () => {
  it('defaults to the loopback edge a developer runs', () => {
    const parsed = envSchema.parse(base);

    expect(parsed.TRUSTED_PROXIES).toEqual(['127.0.0.1', '::1']);
  });

  it('takes a list, so an edge can be named by address or range', () => {
    const parsed = envSchema.parse({
      ...base,
      TRUSTED_PROXIES: '10.0.0.1, 10.1.0.0/16',
    });

    expect(parsed.TRUSTED_PROXIES).toEqual(['10.0.0.1', '10.1.0.0/16']);
  });

  it('never becomes "trust everything"', () => {
    // A boolean true here would let any client name its own address, and the
    // per-organization IP allowlist would guard nothing. The schema only
    // produces a list.
    const parsed = envSchema.parse({ ...base, TRUSTED_PROXIES: '' });

    expect(Array.isArray(parsed.TRUSTED_PROXIES)).toBe(true);
    expect(parsed.TRUSTED_PROXIES).toEqual([]);
  });
});
