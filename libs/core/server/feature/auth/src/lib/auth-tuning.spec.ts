import { describe, expect, it } from 'vitest';

import { envSchema } from '@workspace/core-server-core';

import { SCHEMA_GENERATION_TUNING, authOptionsFor } from './auth.options.js';

/**
 * The numbers an operator sets, and whether better-auth receives them.
 *
 * This exists because for a while it did not. The four values were read from
 * `process.env` at the top of `auth.options.ts`, and measured on
 * `@nestjs/config` 12: `ConfigModule.forRoot` is what loads `.env` into
 * `process.env`, and it runs when the application module's decorator is
 * evaluated — after every `import` in that file, including the one that
 * reached this module. So a value set in `.env` was validated, reached
 * `AppConfig`, and never reached the library. `SESSION_MAX_AGE_SECONDS=3600`
 * meant a seven-day session, and nothing anywhere said so.
 */
describe('the numbers an operator can move', () => {
  it('puts the session lifetime it was given into the options', () => {
    const options = authOptionsFor({
      ...SCHEMA_GENERATION_TUNING,
      sessionMaxAgeSeconds: 3_600,
      sessionUpdateAgeSeconds: 600,
    });

    expect(options.session.expiresIn).toBe(3_600);
    expect(options.session.updateAge).toBe(600);
  });

  it('puts the rate limits it was given into the options', () => {
    const options = authOptionsFor({
      ...SCHEMA_GENERATION_TUNING,
      rateLimitMax: 42,
      credentialMaxAttempts: 3,
    });

    expect(options.rateLimit.max).toBe(42);

    // Every credential route, not only the one somebody remembered. The rules
    // are wildcards so a sign-in method added later is covered by the same
    // number rather than by the library's default.
    const credentialRules = Object.entries(options.rateLimit.customRules);
    expect(credentialRules.length).toBeGreaterThan(0);
    for (const [route, rule] of credentialRules) {
      expect(rule.max, `${route} should use the credential limit`).toBe(3);
    }
  });

  it('reads nothing from the environment when it is built', () => {
    // The property that made this a bug: a value in the environment must not
    // reach the options except through the validated configuration, or there
    // are two sources of truth and the quiet one wins.
    process.env['SESSION_MAX_AGE_SECONDS'] = '999';

    try {
      const options = authOptionsFor(SCHEMA_GENERATION_TUNING);

      expect(options.session.expiresIn).toBe(
        SCHEMA_GENERATION_TUNING.sessionMaxAgeSeconds,
      );
    } finally {
      delete process.env['SESSION_MAX_AGE_SECONDS'];
    }
  });

  it('agrees with the schema about what happens when nobody sets anything', () => {
    // The defaults used for schema generation and the schema's own defaults
    // are two lists of the same four numbers, and a reader would reasonably
    // assume they match. This is what makes that true rather than assumed.
    const parsed = envSchema.parse({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://app_user:app_user@localhost:5432/app',
      REDIS_CRITICAL_URL: 'redis://localhost:6379',
      REDIS_CACHE_URL: 'redis://localhost:6380',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      BETTER_AUTH_URL: 'http://localhost:3000',
      CORS_ORIGINS: 'http://localhost:4200',
    });

    expect({
      sessionMaxAgeSeconds: parsed.SESSION_MAX_AGE_SECONDS,
      sessionUpdateAgeSeconds: parsed.SESSION_UPDATE_AGE_SECONDS,
      rateLimitMax: parsed.AUTH_RATE_LIMIT_MAX,
      credentialMaxAttempts: parsed.AUTH_CREDENTIAL_MAX_ATTEMPTS,
    }).toEqual(SCHEMA_GENERATION_TUNING);
  });
});
