import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { betterAuth } from 'better-auth';
import { Redis } from 'ioredis';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { AppConfig, closeRedis } from '@workspace/core-server-core';
import { AuthDatabaseProvider } from '@workspace/core-server-data-access-db';

import { authOptionsFor, type AuthTuning } from './auth.options.js';
import { redisRateLimitStorage, type RateLimitStorage } from './rate-limit.js';

/**
 * The concrete instance type, inferred from our own options.
 *
 * `ReturnType<typeof betterAuth>` would erase the plugin set — better-auth
 * types `auth.api` from what was passed in, so a widened type loses every
 * plugin endpoint (`verifyApiKey`, the organization calls) at the point they
 * are needed most.
 */
export type Auth = ReturnType<typeof createAuth>;

function createAuth(options: {
  database: Parameters<typeof betterAuth>[0]['database'];
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
  rateLimitStorage: RateLimitStorage;
  tuning: AuthTuning;
}) {
  const { rateLimitStorage, tuning, ...rest } = options;
  const authOptions = authOptionsFor(tuning);

  return betterAuth({
    ...authOptions,
    ...rest,
    // Shared across replicas rather than counted per process. See
    // `rate-limit.ts` for why the library's own default is not enough.
    rateLimit: { ...authOptions.rateLimit, customStorage: rateLimitStorage },
  });
}

/**
 * Owns the better-auth instance.
 *
 * It is a provider rather than a module-level singleton because the adapter
 * needs the client attached to the connection pool Nest opens and closes —
 * one pool for the whole service, not one for authentication and one for
 * everything else.
 *
 * **Never call `auth.api.*` while a `Database` transaction is active.** The
 * adapter talks to the root client, which the Phase 2 proxy refuses inside a
 * transaction; the principal is resolved once per request, before any
 * transaction opens.
 */
@Injectable()
export class AuthService implements OnApplicationShutdown {
  private readonly logger = new Logger(AuthService.name);
  readonly instance: Auth;

  /**
   * The rate limiter's own connection, kept so it can be closed.
   *
   * better-auth is handed a storage adapter, not a client, and never closes
   * what it was given — the same contract BullMQ has. Without this the socket
   * outlives the application: a test suite that will not exit, and a server
   * that sees a client vanish rather than say goodbye.
   */
  private readonly rateLimitRedis: Redis;

  constructor(
    @Inject(AuthDatabaseProvider) authDatabase: AuthDatabaseProvider,
    @Inject(AppConfig) config: AppConfig,
  ) {
    this.rateLimitRedis = new Redis(config.get('REDIS_CRITICAL_URL'));

    this.instance = createAuth({
      database: prismaAdapter(authDatabase.client, { provider: 'postgresql' }),
      secret: config.get('BETTER_AUTH_SECRET'),
      baseURL: config.get('BETTER_AUTH_URL'),
      // The same list the origin-check guard uses: one source for "which
      // origins may act on this API".
      trustedOrigins: config.get('CORS_ORIGINS'),
      rateLimitStorage: redisRateLimitStorage(this.rateLimitRedis),
      // From the validated configuration, not from `process.env` at import
      // time. Measured: `ConfigModule.forRoot` is what loads `.env`, and it
      // runs after every import in the application module has already been
      // evaluated — so a value set there reached `AppConfig` and never reached
      // better-auth. The schema said one thing and the service did another,
      // with nothing anywhere reporting it.
      tuning: {
        sessionMaxAgeSeconds: config.get('SESSION_MAX_AGE_SECONDS'),
        sessionUpdateAgeSeconds: config.get('SESSION_UPDATE_AGE_SECONDS'),
        rateLimitMax: config.get('AUTH_RATE_LIMIT_MAX'),
        credentialMaxAttempts: config.get('AUTH_CREDENTIAL_MAX_ATTEMPTS'),
      },
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await closeRedis(
      this.rateLimitRedis,
      'The authentication rate limiter’s Redis',
      this.logger,
    );
  }
}
