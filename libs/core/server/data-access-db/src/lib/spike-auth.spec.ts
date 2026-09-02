import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import {
  POSTGRES_START_TIMEOUT_MS,
  startPostgres,
  type TestPostgres,
} from '@workspace/core-server-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from './prisma.service.js';
import { Database } from './transaction/database.js';

/**
 * Task 0, second assumption: does the better-auth Prisma adapter reach the
 * root client, and does the Phase 2 proxy refuse it inside a transaction?
 * The answer decides where the principal is resolved for the whole phase.
 */
describe('Phase 3 spike: better-auth inside a transaction', () => {
  let postgres: TestPostgres;
  let prisma: PrismaService;
  let db: Database;
  let auth: ReturnType<typeof betterAuth>;

  beforeAll(async () => {
    postgres = await startPostgres();
    prisma = new PrismaService();
    await prisma.$connect();
    db = new Database(prisma);

    auth = betterAuth({
      // The proxied root client, on purpose: a violation must be loud.
      database: prismaAdapter(prisma, { provider: 'postgresql' }),
      emailAndPassword: { enabled: true },
      secret: 'spike-secret-not-used-anywhere-else',
      baseURL: 'http://localhost:3000',
    });
  }, POSTGRES_START_TIMEOUT_MS);

  afterAll(async () => {
    await prisma?.$disconnect();
    await postgres?.stop();
  });

  // getSession with no cookie returns null without touching the database, so
  // it proves nothing. A sign-up always reaches the adapter — here it will
  // fail on a missing table, and the point is *which* error comes back: a
  // Prisma "table does not exist" means the call reached the database, a
  // "root database client was used" means the proxy refused it first.
  let attempt = 0;
  const getSession = () =>
    auth.api.signUpEmail({
      body: {
        email: `spike-${(attempt += 1)}@example.com`,
        password: 'password123',
        name: 'Spike',
      },
    });

  it('outside a transaction', async () => {
    const outcome = await getSession().then(
      () => 'resolved',
      (error: unknown) => `threw: ${(error as Error).message.slice(0, 90)}`,
    );
    console.log('[spike] outside a transaction ->', outcome);
    expect(outcome).toBeDefined();
  });

  it('inside a tenant transaction', async () => {
    const outcome = await db
      .withTenantTransaction(
        { kind: 'org', orgId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', userId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c' },
        () =>
          getSession().then(
            () => 'resolved',
            (error: unknown) => `threw: ${(error as Error).message.slice(0, 90)}`,
          ),
      )
      .catch((error: unknown) => `transaction threw: ${(error as Error).message.slice(0, 90)}`);

    console.log('[spike] inside withTenantTransaction ->', outcome);
    expect(outcome).toBeDefined();
  });

  it('inside a system transaction', async () => {
    const outcome = await db
      .withSystemTransaction(() =>
        getSession().then(
          () => 'resolved',
          (error: unknown) => `threw: ${(error as Error).message.slice(0, 90)}`,
        ),
      )
      .catch((error: unknown) => `transaction threw: ${(error as Error).message.slice(0, 90)}`);

    console.log('[spike] inside withSystemTransaction ->', outcome);
    expect(outcome).toBeDefined();
  });
});
