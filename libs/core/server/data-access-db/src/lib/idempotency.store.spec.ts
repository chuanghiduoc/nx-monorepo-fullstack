import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { IdempotencyStore } from './idempotency.store.js';
import { PrismaService } from './prisma.service.js';

const CONTAINER_START_TIMEOUT_MS = 180_000;
const libraryRoot = join(import.meta.dirname, '..', '..');

const scope = { scopeType: 'USER', scopeId: 'user-1' } as const;
const route = 'POST:/api/v1/demo-items';
const key = 'idem-key-1';
const requestHash = 'hash-of-the-body';

describe('IdempotencyStore', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaService;
  let store: IdempotencyStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine').start();
    process.env['DATABASE_URL'] = container.getConnectionUri();

    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: libraryRoot,
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });

    prisma = new PrismaService();
    await prisma.$connect();
    store = new IdempotencyStore(prisma);
  }, CONTAINER_START_TIMEOUT_MS);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  beforeEach(async () => {
    await prisma.idempotencyRecord.deleteMany();
  });

  it('claims a key that has never been seen', async () => {
    const claim = await store.claim({ ...scope, route, key, requestHash });

    expect(claim.outcome).toBe('claimed');
  });

  it('rejects a second claim while the first is still working', async () => {
    await store.claim({ ...scope, route, key, requestHash });

    const second = await store.claim({ ...scope, route, key, requestHash });

    expect(second.outcome).toBe('in-progress');
  });

  it('replays the stored response once the first attempt completed', async () => {
    const claim = await store.claim({ ...scope, route, key, requestHash });
    if (claim.outcome !== 'claimed') throw new Error('expected a claim');

    await store.complete({
      ...scope,
      route,
      key,
      fenceToken: claim.fenceToken,
      responseStatus: 201,
      responseBody: { id: 'created-id' },
    });

    const replay = await store.claim({ ...scope, route, key, requestHash });

    expect(replay).toMatchObject({
      outcome: 'replay',
      responseStatus: 201,
      responseBody: { id: 'created-id' },
    });
  });

  it('refuses the same key with a different request', async () => {
    await store.claim({ ...scope, route, key, requestHash });

    const mismatched = await store.claim({
      ...scope,
      route,
      key,
      requestHash: 'a-different-body',
    });

    expect(mismatched.outcome).toBe('request-mismatch');
  });

  it('keeps keys separate per scope, so two users never collide', async () => {
    await store.claim({ ...scope, route, key, requestHash });

    const otherUser = await store.claim({
      scopeType: 'USER',
      scopeId: 'user-2',
      route,
      key,
      requestHash,
    });

    expect(otherUser.outcome).toBe('claimed');
  });

  it('lets a later attempt reclaim an expired lease', async () => {
    await store.claim({ ...scope, route, key, requestHash, leaseMs: -1000 });

    const reclaimed = await store.claim({ ...scope, route, key, requestHash });

    expect(reclaimed.outcome).toBe('claimed');
  });

  it('gives the reclaiming attempt a higher fence token', async () => {
    const first = await store.claim({
      ...scope, route, key, requestHash, leaseMs: -1000,
    });
    if (first.outcome !== 'claimed') throw new Error('expected a claim');

    const second = await store.claim({ ...scope, route, key, requestHash });
    if (second.outcome !== 'claimed') throw new Error('expected a reclaim');

    expect(second.fenceToken).toBeGreaterThan(first.fenceToken);
  });

  it('refuses a completion from an attempt whose lease was taken away', async () => {
    const first = await store.claim({
      ...scope, route, key, requestHash, leaseMs: -1000,
    });
    if (first.outcome !== 'claimed') throw new Error('expected a claim');

    await store.claim({ ...scope, route, key, requestHash });

    // The original attempt wakes up and tries to finish: it must not overwrite
    // the result of the attempt that legitimately owns the key now.
    const stale = store.complete({
      ...scope,
      route,
      key,
      fenceToken: first.fenceToken,
      responseStatus: 500,
      responseBody: { stale: true },
    });

    await expect(stale).rejects.toThrow(/fence/i);
  });

  it('only one of many simultaneous claims wins', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.claim({ ...scope, route, key, requestHash }),
      ),
    );

    const claimed = attempts.filter((a) => a.outcome === 'claimed');

    expect(claimed).toHaveLength(1);
  });
});
