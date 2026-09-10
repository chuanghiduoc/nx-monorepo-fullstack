import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { redisRateLimitStorage, type RateLimitStorage } from './rate-limit.js';

/** Pinned to what docker-compose runs, so the commands are the same ones. */
const REDIS_IMAGE = 'redis:8-alpine';
const REDIS_PORT = 6379;
const START_TIMEOUT_MS = 180_000;

/**
 * Against a real Redis, because the point is the commands.
 *
 * A double would confirm the arithmetic and nothing else — and the arithmetic
 * is not where this could be wrong. Whether `EXPIRE ... NX` leaves the first
 * expiry alone, and whether `TTL` reports what is left, are properties of the
 * server.
 */
describe('the shared rate-limit counter', () => {
  let container: StartedTestContainer;
  let redis: Redis;
  let storage: RateLimitStorage;

  beforeAll(async () => {
    container = await new GenericContainer(REDIS_IMAGE)
      .withExposedPorts(REDIS_PORT)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();

    redis = new Redis({
      host: container.getHost(),
      port: container.getMappedPort(REDIS_PORT),
    });
    storage = redisRateLimitStorage(redis);
  }, START_TIMEOUT_MS);

  afterAll(async () => {
    redis?.disconnect();
    await container?.stop();
  });

  const rule = { window: 60, max: 3 };
  const freshKey = () => `rate-limit-test:${randomUUID()}`;

  it('allows exactly as many attempts as the rule names', async () => {
    const key = freshKey();

    for (let attempt = 1; attempt <= rule.max; attempt += 1) {
      const verdict = await storage.consume(key, rule);
      expect(verdict.allowed).toBe(true);
      expect(verdict.retryAfter).toBeNull();
    }

    const refused = await storage.consume(key, rule);
    expect(refused.allowed).toBe(false);
  });

  it('says how long to wait, and it is inside the window', async () => {
    const key = freshKey();

    for (let attempt = 0; attempt <= rule.max; attempt += 1) {
      await storage.consume(key, rule);
    }

    const refused = await storage.consume(key, rule);

    expect(refused.retryAfter).toBeGreaterThan(0);
    expect(refused.retryAfter).toBeLessThanOrEqual(rule.window);
  });

  it('fixes the window at the first attempt rather than extending it', async () => {
    const key = freshKey();

    await storage.consume(key, rule);
    const afterFirst = await redis.ttl(key);

    // A second attempt a moment later must not push the expiry back. If it
    // did, somebody hammering the endpoint would hold their own lockout open
    // forever and never be let back in.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await storage.consume(key, rule);
    const afterSecond = await redis.ttl(key);

    expect(afterSecond).toBeLessThan(afterFirst);
  });

  it('counts two callers separately', async () => {
    const one = freshKey();
    const other = freshKey();

    for (let attempt = 0; attempt <= rule.max; attempt += 1) {
      await storage.consume(one, rule);
    }

    // Sharing a counter across replicas must not mean sharing it across
    // people: the key is what separates them.
    expect((await storage.consume(one, rule)).allowed).toBe(false);
    expect((await storage.consume(other, rule)).allowed).toBe(true);
  });
});
