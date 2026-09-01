import { describe, expect, it } from 'vitest';

import { envSchema } from './env.schema.js';

const validEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/app',
  REDIS_CRITICAL_URL: 'redis://localhost:6379',
  REDIS_CACHE_URL: 'redis://localhost:6380',
};

describe('envSchema', () => {
  it('names the missing variable so the failure is actionable', () => {
    const result = envSchema.safeParse({});

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('DATABASE_URL');
  });

  it('rejects a database url that is not postgres', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      DATABASE_URL: 'mysql://user:pass@localhost:3306/app',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a redis url that is not redis', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      REDIS_CRITICAL_URL: 'http://localhost:6379',
    });

    expect(result.success).toBe(false);
  });

  it('requires both redis roles, because one instance cannot serve both', () => {
    const { REDIS_CACHE_URL: _omitted, ...withoutCache } = validEnv;

    const result = envSchema.safeParse(withoutCache);

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('REDIS_CACHE_URL');
  });

  it('defaults the port when none is given', () => {
    const parsed = envSchema.parse(validEnv);

    expect(parsed.PORT).toBe(3000);
  });

  it('coerces a numeric port from the string the environment provides', () => {
    const parsed = envSchema.parse({ ...validEnv, PORT: '8080' });

    expect(parsed.PORT).toBe(8080);
  });

  it('rejects a port that is not a usable number', () => {
    const result = envSchema.safeParse({ ...validEnv, PORT: 'not-a-port' });

    expect(result.success).toBe(false);
  });

  it('defaults to development so production behaviour is never implicit', () => {
    const parsed = envSchema.parse(validEnv);

    expect(parsed.NODE_ENV).toBe('development');
  });

  it('defaults the rate limit to a value that protects without blocking', () => {
    const parsed = envSchema.parse(validEnv);

    expect(parsed.THROTTLE_LIMIT).toBe(100);
    expect(parsed.THROTTLE_TTL_MS).toBe(60_000);
  });

  it('lets operations tighten the rate limit without a rebuild', () => {
    const parsed = envSchema.parse({ ...validEnv, THROTTLE_LIMIT: '5' });

    expect(parsed.THROTTLE_LIMIT).toBe(5);
  });

  it('splits the cors origin list', () => {
    const parsed = envSchema.parse({
      ...validEnv,
      CORS_ORIGINS: 'http://localhost:4200,https://app.example.com',
    });

    expect(parsed.CORS_ORIGINS).toEqual([
      'http://localhost:4200',
      'https://app.example.com',
    ]);
  });
});
