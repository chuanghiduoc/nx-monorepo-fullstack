import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

const API_URL = process.env['API_URL'] ?? 'http://localhost:3000';
const READY_TIMEOUT_MS = 60_000;
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
export async function setup(): Promise<void> {
  if (process.env['API_URL']) {
    await waitForApi();
    return;
  }

  const distDir = join(import.meta.dirname, '..', '..', 'api', 'dist');

  api = spawn(process.execPath, ['main.js'], {
    cwd: distDir,
    stdio: 'inherit',
    env: { ...process.env, PORT: '3000' },
  });

  await waitForApi();
}

export async function teardown(): Promise<void> {
  api?.kill();
}
