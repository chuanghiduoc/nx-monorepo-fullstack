import { Inject, Injectable } from '@nestjs/common';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { AppConfig } from '@workspace/core-server-core';
import { AuthDatabaseProvider } from '@workspace/core-server-data-access-db';

import { authOptions } from './auth.options.js';

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
}) {
  return betterAuth({ ...authOptions, ...options });
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
export class AuthService {
  readonly instance: Auth;

  constructor(
    @Inject(AuthDatabaseProvider) authDatabase: AuthDatabaseProvider,
    @Inject(AppConfig) config: AppConfig,
  ) {
    this.instance = createAuth({
      database: prismaAdapter(authDatabase.client, { provider: 'postgresql' }),
      secret: config.get('BETTER_AUTH_SECRET'),
      baseURL: config.get('BETTER_AUTH_URL'),
      // The same list the origin-check guard uses: one source for "which
      // origins may act on this API".
      trustedOrigins: config.get('CORS_ORIGINS'),
    });
  }
}
