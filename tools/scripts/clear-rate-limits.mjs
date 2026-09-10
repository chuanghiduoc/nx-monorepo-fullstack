import { Redis } from 'ioredis';

/**
 * Empties the rate-limit counters left behind by a previous run.
 *
 * They live in Redis and outlive the process under test, so a second run
 * inside the same window starts already throttled and fails on 429s that have
 * nothing to do with the code. The alternative is waiting the window out.
 *
 * This runs as part of the API's own start command rather than as a test
 * framework hook, because those hooks run *after* the servers are up: by then
 * the readiness probe has already been answered 429 and given up, reporting a
 * server that never started.
 */
const url = process.env['REDIS_CRITICAL_URL'] ?? 'redis://localhost:6379';
const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });

try {
  await redis.connect();
  // Two kinds of key: the hit counter, and the block marker written once a
  // window is exhausted. Clearing only the counter leaves the block in place
  // and every request in the next run is still refused.
  const keys = [
    ...(await redis.keys('*:hits')),
    ...(await redis.keys('*:blocked')),
  ];

  if (keys.length > 0) {
    await redis.del(...keys);
  }
} catch (error) {
  // The service is about to fail to start for the same reason; let that be
  // the error the developer reads, not this one.
  console.warn(`Could not clear rate-limit counters: ${String(error)}`);
} finally {
  redis.disconnect();
}
