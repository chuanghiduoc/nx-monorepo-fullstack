import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const API_URL = process.env['API_URL'] ?? 'http://localhost:3000';
const READY_TIMEOUT_MS = 60_000;

// Low enough that the rate-limit test does not need a hundred requests, high
// enough that the other suites are not throttled. Exported through the
// environment so the suite and the server agree on the number.
const THROTTLE_LIMIT = process.env['THROTTLE_LIMIT'] ?? '40';
const THROTTLE_TTL_MS = process.env['THROTTLE_TTL_MS'] ?? '30000';
const POLL_INTERVAL_MS = 250;

let api: ChildProcess | undefined;

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

  throw new Error(`core-api did not become ready on ${API_URL} within ${READY_TIMEOUT_MS}ms`);
}

/**
 * Starts the production bundle rather than a dev server: these tests are the
 * last gate before the artifact ships, so they must exercise the artifact.
 * Set API_URL to point at an already-running instance and nothing is spawned.
 */
/** Vitest runs globalSetup in its own context, so the limit is published here. */
export const throttleLimit = Number(THROTTLE_LIMIT);

export async function setup(): Promise<void> {
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
      DATABASE_URL:
        process.env['DATABASE_URL'] ??
        'postgresql://postgres:postgres@localhost:5432/app',
      REDIS_CRITICAL_URL:
        process.env['REDIS_CRITICAL_URL'] ?? 'redis://localhost:6379',
      REDIS_CACHE_URL:
        process.env['REDIS_CACHE_URL'] ?? 'redis://localhost:6380',
      THROTTLE_LIMIT: THROTTLE_LIMIT,
      THROTTLE_TTL_MS: THROTTLE_TTL_MS,
    },
  });

  await waitForApi();
}

export async function teardown(): Promise<void> {
  api?.kill();
}
