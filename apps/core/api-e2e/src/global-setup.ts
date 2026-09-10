import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Redis } from 'ioredis';

import { startModelStub, type ModelStub } from './model-stub.js';

const API_URL = process.env['API_URL'] ?? 'http://localhost:3000';

/**
 * Where the `local` storage driver keeps its objects for this run.
 *
 * A temporary directory, removed with the rest of the rig: a suite that wrote
 * into the repository would leave uploads behind and eventually fail on one
 * left by a previous run.
 */
const LOCAL_STORAGE_ROOT = mkdtempSync(join(tmpdir(), 'core-api-e2e-storage-'));

/**
 * The origin the browser application is served from, and the only one the
 * service is told to trust while this suite runs.
 */
const WEB_ORIGIN = 'http://localhost:4200';

/**
 * A second instance that trusts nobody, on its own port.
 *
 * The suite's requests all come from loopback, and the main instance is told
 * to trust loopback — so on it a forwarded address is always honoured and the
 * *refusal* path is unreachable. That path is the one that protects anything:
 * if a caller could set its own address, the rate limit and the
 * per-organization allowlist would guard nothing.
 */
const UNTRUSTING_PORT = '3010';
export const UNTRUSTING_API_URL = `http://localhost:${UNTRUSTING_PORT}`;

/**
 * A third instance running as production does.
 *
 * Cookie attributes are the ones that ship, and several of them — the
 * `__Secure-` prefix and the `Secure` flag — only appear when `NODE_ENV` says
 * production. Asserting them against a development instance would assert
 * something no deployment ever sends.
 */
const PRODUCTION_PORT = '3011';
export const PRODUCTION_API_URL = `http://localhost:${PRODUCTION_PORT}`;

const READY_TIMEOUT_MS = 60_000;

// High enough that the rest of the suite is never throttled — it grows with
// every feature, and three instances now share one window — and low enough
// that the rate-limit test reaches the ceiling in a second.
//
// Pinned rather than inherited. The task runner loads the developer's `.env`
// into every task, and its value is a production-shaped 100: inheriting it
// silently lowered the ceiling until an unrelated test failed on a 429 that
// had nothing to do with what it was checking.
const THROTTLE_LIMIT = '300';
const THROTTLE_TTL_MS = '30000';
const POLL_INTERVAL_MS = 250;

/** Vitest runs globalSetup in its own context, so the limit is published here. */
export const throttleLimit = Number(THROTTLE_LIMIT);

const instances: ChildProcess[] = [];

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

async function waitForApi(url: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const port = new URL(url).port;

  while (Date.now() < deadline) {
    const died = diedEarly.get(port);

    if (died !== undefined) {
      throw new Error(died);
    }

    try {
      const response = await fetch(`${url}/api`);
      if (response.ok) return;
    } catch {
      // Server not accepting connections yet.
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(
    `core-api did not become ready on ${url} within ${READY_TIMEOUT_MS}ms`,
  );
}

/**
 * What a running service reads from its own environment.
 *
 * `app_user`, not the owner: the service under test must run with the rights
 * it will have in production, which is what makes a row-level policy mean
 * anything. The values that decide what is *being tested* — the trusted hops,
 * the allowed origin, the rate limit — are pinned by the caller rather than
 * inherited.
 */
function baseEnvironment(port: string, baseUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PORT: port,
    HOST: '127.0.0.1',
    DATABASE_URL:
      process.env['DATABASE_URL'] ??
      'postgresql://app_user:app_user@localhost:5432/app',
    REDIS_CRITICAL_URL:
      process.env['REDIS_CRITICAL_URL'] ?? 'redis://localhost:6379',
    REDIS_CACHE_URL:
      process.env['REDIS_CACHE_URL'] ?? 'redis://localhost:6380',
    // The `local` driver, so the suite exercises the whole upload path with
    // no object store: the signed URL points back at this API, and the route
    // that receives it verifies the signature the driver produced. The S3
    // driver has its own suite against a real MinIO.
    // A channel of its own, so a developer's running stack on the same Redis
    // does not put its events into this suite's streams.
    REALTIME_CHANNEL: 'realtime-e2e',
    // The stub above, reached through the ordinary OpenAI-compatible path: the
    // real SDK, the real transport, the real route. `AI_PROVIDER=none` is what
    // ships and is proven in the facade's own suite; what cannot be proven
    // there is that an answer arrives over SSE.
    AI_PROVIDER: 'openai',
    AI_API_KEY: 'an-e2e-key-that-is-never-checked',
    AI_BASE_URL: modelStub?.baseUrl ?? 'http://127.0.0.1:1/v1',
    AI_EMBEDDING_BASE_URL: modelStub?.baseUrl ?? 'http://127.0.0.1:1/v1',
    STORAGE_DRIVER: 'local',
    STORAGE_PUBLIC_ORIGIN: baseUrl,
    STORAGE_LOCAL_ROOT: LOCAL_STORAGE_ROOT,
    // A literal this suite invents so the schema's length rule passes. The
    // marker sits on the line rather than allowlisting the file, so a real key
    // committed here later still stops the build.
    STORAGE_SIGNING_SECRET: 'an-e2e-signing-secret-that-is-long-enough', // gitleaks:allow
    THROTTLE_LIMIT,
    THROTTLE_TTL_MS,
    // Every account this suite creates comes from one address, which is what
    // a credential limit is designed to stop. Pinned high here for the same
    // reason the request limit is.
    AUTH_CREDENTIAL_MAX_ATTEMPTS: '1000',
    AUTH_RATE_LIMIT_MAX: '20000',
    // Long enough to satisfy the schema; a real deployment reads this from its
    // secret manager.
    BETTER_AUTH_SECRET:
      process.env['BETTER_AUTH_SECRET'] ??
      'e2e-secret-that-is-at-least-32-characters-long',
    BETTER_AUTH_URL: baseUrl,
    CORS_ORIGINS: WEB_ORIGIN,
  };
}

/**
 * Starts the production bundle rather than a dev server: these tests are the
 * last gate before the artifact ships, so they must exercise the artifact.
 */
/**
 * Refuses to start when something already holds a port this suite needs.
 *
 * Measured: a `pnpm dev` left running held port 3000, the suite's own instance
 * exited immediately with `EADDRINUSE`, and `waitForApi` was answered by **the
 * other process** — a different build with the shipped rate limits, so fifteen
 * tests failed with 429s that had nothing to do with the code. A suite that
 * silently tests somebody else's process is the worst kind of green, and it
 * took an hour to see.
 *
 * Checked by binding rather than by watching for an early exit: a squatter
 * answers `/api` straight away, so the poll can succeed before the child's
 * `exit` event is even delivered. Binding is a yes-or-no question with no race
 * in it.
 */
async function assertPortIsFree(port: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();

    probe.once('error', (failure: NodeJS.ErrnoException) => {
      reject(
        new Error(
          `Port ${port} is already in use (${failure.code ?? 'unknown'}), so this suite cannot start its own ` +
            'API there — and the one already listening would answer every request instead. ' +
            'A `pnpm dev` left running is the usual cause.',
        ),
      );
    });

    probe.once('listening', () => {
      probe.close(() => {
        resolve();
      });
    });

    probe.listen(Number(port), '127.0.0.1');
  });
}

/**
 * Starts one instance, and refuses to let it die quietly.
 *
 * The `exit` handler catches what the port check cannot: a boot that fails for
 * its own reasons — a bad variable, a database that is not there — which would
 * otherwise be a `waitForApi` timeout thirty seconds later saying nothing.
 *
 * The failure is recorded rather than thrown: this runs before the promise
 * chain `setup` awaits, and a throw here would be an unhandled rejection with
 * no context. `waitForApi` reads it and says which port and why.
 */
function startApi(
  distDir: string,
  environment: NodeJS.ProcessEnv,
): ChildProcess {
  const port = environment['PORT'] ?? '?';

  const instance = spawn(process.execPath, ['main.js'], {
    cwd: distDir,
    stdio: 'inherit',
    env: environment,
  });

  instance.once('exit', (code, signal) => {
    if (stopping) {
      return;
    }

    diedEarly.set(
      port,
      `the instance for port ${port} exited (code ${String(code)}, signal ${String(signal)}) before it answered. ` +
        'Something else is probably already on that port — a `pnpm dev` left running is the usual one.',
    );
  });

  instances.push(instance);
  return instance;
}

/** Instances that exited before they answered, by port, for the message. */
const diedEarly = new Map<string, string>();

/** Set by `teardown`, so an expected exit is not reported as a failure. */
let stopping = false;

/**
 * A provider that answers from this process, so the assistant can be proven.
 *
 * Started before the instances, because its address is in their environment.
 * Reaching a real provider instead would be slow, flaky, expensive and
 * impossible in CI without a key; leaving it out would mean no end-to-end proof
 * that an answer ever streams.
 */
let modelStub: ModelStub | undefined;

export async function setup(): Promise<void> {
  await clearRateLimitCounters();

  if (process.env['API_URL']) {
    await waitForApi(API_URL);
    return;
  }

  modelStub = await startModelStub();

  const distDir = join(import.meta.dirname, '..', '..', 'api', 'dist');

  // Before anything is spawned, and all three at once: a suite that started two
  // instances and then discovered the third's port was taken would leave two
  // running.
  await Promise.all(
    ['3000', UNTRUSTING_PORT, PRODUCTION_PORT].map(assertPortIsFree),
  );

  startApi(distDir, baseEnvironment('3000', API_URL));

  // The same build, told to trust an address these requests will never come
  // from. Everything else matches, so any difference in behaviour is the
  // trusted-hop list and nothing else.
  startApi(distDir, {
    ...baseEnvironment(UNTRUSTING_PORT, UNTRUSTING_API_URL),
    TRUSTED_PROXIES: '10.99.99.99',
  });

  // The same build again, this time claiming to be production. Only the
  // cookie audit uses it.
  startApi(distDir, {
    ...baseEnvironment(PRODUCTION_PORT, PRODUCTION_API_URL),
    NODE_ENV: 'production',
  });

  await Promise.all(
    [API_URL, UNTRUSTING_API_URL, PRODUCTION_API_URL].map(waitForApi),
  );
}

/** How long a signalled API has to stop before it is killed outright. */
const SHUTDOWN_GRACE_MS = 5_000;

/**
 * Stops the APIs this suite started, and waits until they are gone.
 *
 * `kill()` alone was not enough, and the failure it caused was hard to read: it
 * signals and returns, so the run ends while the processes are still holding
 * port 3000. The next `pnpm verify` then started an API that could not bind and
 * every authentication test failed — measured three times, each time looking
 * like a broken feature rather than a leftover process.
 *
 * `SIGKILL` after a grace period, because an API that ignores the first signal
 * is an API nobody will notice is still running until the port is needed.
 */
export async function teardown(): Promise<void> {
  // From here an instance exiting is expected, not a symptom.
  stopping = true;

  rmSync(LOCAL_STORAGE_ROOT, { recursive: true, force: true });
  await modelStub?.stop();

  await Promise.all(
    instances.map(
      (instance) =>
        new Promise<void>((resolve) => {
          if (instance.exitCode !== null || instance.signalCode !== null) {
            resolve();
            return;
          }

          const giveUp = setTimeout(() => {
            instance.kill('SIGKILL');
          }, SHUTDOWN_GRACE_MS);
          giveUp.unref();

          instance.once('exit', () => {
            clearTimeout(giveUp);
            resolve();
          });

          instance.kill();
        }),
    ),
  );

  instances.length = 0;
}
