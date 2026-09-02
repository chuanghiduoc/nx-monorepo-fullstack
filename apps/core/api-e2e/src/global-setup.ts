import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

import { Redis } from 'ioredis';

const API_URL = process.env['API_URL'] ?? 'http://localhost:3000';
const READY_TIMEOUT_MS = 60_000;

// Low enough that the rate-limit test does not need a hundred requests, high
// enough that the other suites are not throttled. Exported through the
// environment so the suite and the server agree on the number.
const THROTTLE_LIMIT = process.env['THROTTLE_LIMIT'] ?? '40';
const THROTTLE_TTL_MS = process.env['THROTTLE_TTL_MS'] ?? '30000';
const POLL_INTERVAL_MS = 250;

let api: ChildProcess | undefined;

/**
 * Rate-limit counters live in Redis and outlive the process under test, so a
 * second run inside the same window would start already throttled and every
 * suite after the rate-limit one would fail. Clearing them here is what makes
 * the suite repeatable; the alternative — waiting out the window — turns a
 * 30-second run into a 30-second wait.
 */
async function clearRateLimitCounters(): Promise<void> {
  const url = process.env['REDIS_CRITICAL_URL'] ?? 'redis://localhost:6379';
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });

  try {
    await redis.connect();
    // Two kinds of key: the hit counter and the block marker the throttler
    // writes once a window is exhausted. Clearing only the counter leaves the
    // block in place, and every request in the next run is answered 429 —
    // including the readiness probe, which then reports the server as never
    // having started.
    const keys = [
      ...(await redis.keys('*:hits')),
      ...(await redis.keys('*:blocked')),
    ];
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch (error) {
    // The server will fail to boot for the same reason; let that be the error
    // the developer reads, not this one.
    console.warn(`Could not clear rate-limit counters: ${String(error)}`);
  } finally {
    redis.disconnect();
  }
}

async function waitForApi(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${API_URL}/api`);
      if (response.ok) return;
    } catch {
      // Server not accepting connections yet.
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(
    `core-api did not become ready on ${API_URL} within ${READY_TIMEOUT_MS}ms`,
  );
}

/**
 * Starts the production bundle rather than a dev server: these tests are the
 * last gate before the artifact ships, so they must exercise the artifact.
 * Set API_URL to point at an already-running instance and nothing is spawned.
 */
/** Vitest runs globalSetup in its own context, so the limit is published here. */
export const throttleLimit = Number(THROTTLE_LIMIT);

export async function setup(): Promise<void> {
  await clearRateLimitCounters();

  if (process.env['API_URL']) {
    await waitForApi();
    return;
  }

  const distDir = join(import.meta.dirname, '..', '..', 'api', 'dist');

  api = spawn(process.execPath, ['main.js'], {
    cwd: distDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: '3000',
      HOST: '127.0.0.1',
      // core-api validates its configuration at boot (AppConfigModule), so the
      // suite must supply what a running service would have.
      // app_user, not the owner: the service under test must run with the
      // rights it will have in production, which is what makes an RLS policy
      // mean anything.
      DATABASE_URL:
        process.env['DATABASE_URL'] ??
        'postgresql://app_user:app_user@localhost:5432/app',
      REDIS_CRITICAL_URL:
        process.env['REDIS_CRITICAL_URL'] ?? 'redis://localhost:6379',
      REDIS_CACHE_URL:
        process.env['REDIS_CACHE_URL'] ?? 'redis://localhost:6380',
      THROTTLE_LIMIT: THROTTLE_LIMIT,
      THROTTLE_TTL_MS: THROTTLE_TTL_MS,
      // Long enough to satisfy the schema; a real deployment reads this from
      // its secret manager.
      BETTER_AUTH_SECRET:
        process.env['BETTER_AUTH_SECRET'] ??
        'e2e-secret-that-is-at-least-32-characters-long',
      BETTER_AUTH_URL: process.env['BETTER_AUTH_URL'] ?? API_URL,
    },
  });

  await waitForApi();
}

export async function teardown(): Promise<void> {
  api?.kill();
}
