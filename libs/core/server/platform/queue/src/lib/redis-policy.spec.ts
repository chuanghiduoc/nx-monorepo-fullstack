import { Redis } from 'ioredis';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EvictionPolicyError, assertNoEviction } from './redis-policy.js';

/** Pinned to what docker-compose runs, so the answer is the same answer. */
const REDIS_IMAGE = 'redis:8-alpine';
const REDIS_PORT = 6379;
const START_TIMEOUT_MS = 180_000;

/**
 * Against real instances, because the claim is about what Redis reports.
 *
 * Three containers, one per answer that matters: the policy the queue needs,
 * a policy that can drop a job, and a Redis that will not let anyone ask. The
 * third is a real ACL rather than a stub — the whole point of that branch is
 * what a restricted server actually replies, and a hand-written rejection
 * would only confirm the string this file chose to write.
 */
describe('the queue refusing a Redis that may evict', () => {
  let safe: StartedTestContainer;
  let evicting: StartedTestContainer;
  let restricted: StartedTestContainer;
  let safeClient: Redis;
  let evictingClient: Redis;
  let restrictedClient: Redis;

  beforeAll(async () => {
    [safe, evicting, restricted] = await Promise.all([
      new GenericContainer(REDIS_IMAGE)
        .withCommand(['redis-server', '--maxmemory-policy', 'noeviction'])
        .withExposedPorts(REDIS_PORT)
        .withWaitStrategy(Wait.forListeningPorts())
        .start(),
      new GenericContainer(REDIS_IMAGE)
        .withCommand([
          'redis-server',
          '--maxmemory',
          '64mb',
          '--maxmemory-policy',
          'allkeys-lru',
        ])
        .withExposedPorts(REDIS_PORT)
        .withWaitStrategy(Wait.forListeningPorts())
        .start(),
      // How a managed service usually does it: the command is still there,
      // the connecting user is simply not allowed to run it.
      new GenericContainer(REDIS_IMAGE)
        .withCommand([
          'redis-server',
          '--maxmemory-policy',
          'noeviction',
          '--user',
          'default',
          'on',
          'nopass',
          '~*',
          '&*',
          '+@all',
          '-config',
        ])
        .withExposedPorts(REDIS_PORT)
        .withWaitStrategy(Wait.forListeningPorts())
        .start(),
    ]);

    safeClient = new Redis({
      host: safe.getHost(),
      port: safe.getMappedPort(REDIS_PORT),
    });
    evictingClient = new Redis({
      host: evicting.getHost(),
      port: evicting.getMappedPort(REDIS_PORT),
    });
    restrictedClient = new Redis({
      host: restricted.getHost(),
      port: restricted.getMappedPort(REDIS_PORT),
    });
  }, START_TIMEOUT_MS);

  afterAll(async () => {
    safeClient?.disconnect();
    evictingClient?.disconnect();
    restrictedClient?.disconnect();
    await Promise.all([safe?.stop(), evicting?.stop(), restricted?.stop()]);
  });

  it('accepts the one policy that cannot drop a job', async () => {
    await expect(assertNoEviction(safeClient)).resolves.toBeUndefined();
  });

  it('refuses one that can, and names the policy it found', async () => {
    // The library itself only logs a warning here and carries on. A warning
    // at startup is read once, by whoever happened to be watching.
    await expect(assertNoEviction(evictingClient)).rejects.toThrow(
      EvictionPolicyError,
    );
    await expect(assertNoEviction(evictingClient)).rejects.toThrow(
      /allkeys-lru/,
    );
  });

  it('says why, not only what', async () => {
    // The message is read by somebody who has just had a deployment refuse to
    // start, and it has to be enough on its own.
    const failure = await assertNoEviction(evictingClient).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/noeviction/);
    expect((failure as Error).message).toMatch(/drop a job/);
  });

  it('lets a Redis that will not let it ask alone', async () => {
    // Managed services routinely restrict CONFIG. Refusing to start there
    // would be refusing to run in production to prove a point about it.
    // Checked first that the restriction is real, so a server that quietly
    // allowed the command would fail this test rather than pass it.
    await expect(
      restrictedClient.config('GET', 'maxmemory-policy'),
    ).rejects.toThrow(/NOPERM|unknown command/i);

    await expect(assertNoEviction(restrictedClient)).resolves.toBeUndefined();
  });

  it('does not read a broken connection as consent', async () => {
    // The tolerated case is one refusal and nothing else. A connection that
    // is gone says nothing about the eviction policy, and swallowing it would
    // turn this check into one that always passes — which is the same as not
    // having it, except that it looks like it is there.
    const gone = new Redis({
      host: safe.getHost(),
      port: safe.getMappedPort(REDIS_PORT),
    });
    gone.disconnect();

    await expect(assertNoEviction(gone)).rejects.toThrow(/closed/i);
  });
});
