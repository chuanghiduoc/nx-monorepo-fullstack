import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { Injectable, Module, type OnApplicationShutdown, type OnModuleDestroy } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Redis } from 'ioredis';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { startPostgres, type TestPostgres } from '@workspace/core-server-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REDIS_IMAGE = 'redis:8-alpine';
const REDIS_PORT = 6379;
/**
 * How long a spawned worker has to say it is running.
 *
 * Generous, because this suite starts a real process that starts a real Nest
 * application while the rest of the workspace's suites are starting their own
 * PostgreSQL and Redis containers alongside it. At sixty seconds it passed
 * alone and failed inside `pnpm verify` — which is a measurement of the
 * machine, not of the worker, and the worst kind of red: one that says nothing
 * true.
 *
 * If a worker genuinely cannot start, it says so and exits, and the assertions
 * on its output catch that immediately rather than waiting this out.
 */
const BOOT_TIMEOUT_MS = 180_000;
const SUITE_TIMEOUT_MS = 300_000;
const POLL_MS = 100;

// src/app -> src -> the application root, where tsconfig.app.json lives.
const workerRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(
  describe: string,
  condition: () => Promise<boolean> | boolean,
  deadlineMs = BOOT_TIMEOUT_MS,
  /**
   * What the process printed, for the failure message.
   *
   * Without it a timeout says only that something did not happen, and the one
   * thing that would explain it — the child's own output, which this suite is
   * already collecting — is thrown away. A red test that says nothing is worse
   * than a slow one.
   */
  diagnose?: () => string,
): Promise<void> {
  const giveUpAt = Date.now() + deadlineMs;

  for (;;) {
    if (await condition()) {
      return;
    }
    if (Date.now() > giveUpAt) {
      const printed = diagnose?.().trim();
      throw new Error(
        `Timed out after ${deadlineMs}ms waiting until ${describe}.` +
          (printed ? `
The process printed:
${printed}` : ''),
      );
    }
    await sleep(POLL_MS);
  }
}

interface Replica {
  readonly process: ChildProcessWithoutNullStreams;
  readonly output: () => string;
  readonly heartbeatFile: string;
  readonly exited: Promise<number | null>;
}

/**
 * Ends a spawned process and everything under it.
 *
 * On Windows the direct child is the shell, and killing a shell leaves the
 * process it started running: measured, a worker survived `SIGKILL` of its
 * parent and went on writing heartbeats into a directory the suite was about
 * to delete. `taskkill /T` is what walks the tree.
 */
function kill(child: ChildProcessWithoutNullStreams): void {
  if (process.platform !== 'win32' || child.pid === undefined) {
    child.kill('SIGKILL');
    return;
  }

  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
    });
  } catch {
    // Already gone, which is the outcome this is for.
  }
}

/**
 * The worker, as a process.
 *
 * Started the way a container starts it — `main.ts`, its own environment, its
 * own signals — because the three things this file is about are all
 * properties of a process and of nothing smaller: which database role it
 * connects as, what a SIGTERM does to it, and what two of them agree on.
 */
describe('the worker process', () => {
  let postgres: TestPostgres;
  let redisContainer: StartedTestContainer;
  let redis: Redis;
  let scratch: string;
  const replicas: Replica[] = [];

  const start = (extra: Record<string, string> = {}): Replica => {
    const heartbeatFile = join(scratch, `heartbeat-${replicas.length}`);
    const child = spawn(
      'pnpm',
      ['exec', 'tsx', '--tsconfig', 'tsconfig.app.json', 'src/main.ts'],
      {
        cwd: workerRoot,
        shell: process.platform === 'win32',
        env: {
          ...withoutInheritedDatabaseUrls(),
          NODE_ENV: 'test',
          LOG_LEVEL: 'info',
          WORKER_DATABASE_URL: postgres.workerUri,
          REDIS_CRITICAL_URL: redisUrl(),
          WORKER_HEARTBEAT_FILE: heartbeatFile,
          RETENTION_SWEEP_INTERVAL_MINUTES: '1',
          // Small, because this suite starts several full worker processes
          // against one container while the rest of the workspace's suites are
          // starting their own. The shipped defaults size a worker that has a
          // machine to itself, and several of those at once is a load this rig
          // does not have to reproduce to test what it is testing.
          //
          // Measured rather than assumed: with the defaults, four of these
          // tests failed with a replica that exited 1 having printed nothing;
          // with these values all of them pass. What exactly ran out was not
          // established — connections and memory are both plausible and the
          // replica said nothing either way — so this is a smaller rig, not a
          // diagnosis.
          //
          // The pool is exactly what the registry's own arithmetic asks for at
          // this concurrency: one connection per consumer, one per scheduled
          // sweep, one for the relay. Left at six it was one short the day the
          // file scanner became the third of each, and the worker refused to
          // start with a message saying so — which is the check working. Add a
          // job and this fails again, loudly, in the right place.
          WORKER_CONCURRENCY: '1',
          WORKER_DATABASE_POOL_MAX: '7',
          ...extra,
        },
      },
    ) as ChildProcessWithoutNullStreams;

    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    // A process that never started prints nothing at all, and "it printed
    // nothing" is the least useful failure message there is. These say which
    // of the two happened.
    child.on('error', (failure: Error) => {
      output += `
[spawn failed] ${failure.message}
`;
    });
    child.on('exit', (code, signal) => {
      output += `
[exited] code=${String(code)} signal=${String(signal)}
`;
    });

    const replica: Replica = {
      process: child,
      output: () => output,
      heartbeatFile,
      exited: new Promise((resolve) => {
        child.on('exit', (code) => {
          resolve(code);
        });
      }),
    };

    replicas.push(replica);
    return replica;
  };

  const redisUrl = () =>
    `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(REDIS_PORT)}`;

  /**
   * The environment without the developer's own connection strings.
   *
   * The task runner loads `.env` into every task, and a worker that inherited
   * `DATABASE_URL` would connect to the developer's database instead of the
   * container — which is exactly the failure the separate variable exists to
   * make impossible.
   */
  const withoutInheritedDatabaseUrls = (): NodeJS.ProcessEnv => {
    const environment = { ...process.env };
    delete environment['DATABASE_URL'];
    delete environment['MIGRATION_DATABASE_URL'];
    delete environment['SHADOW_DATABASE_URL'];
    return environment;
  };

  const isRunning = (replica: Replica) =>
    replica.output().includes('core-worker is running');

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'core-worker-spec-'));

    [postgres, redisContainer] = await Promise.all([
      startPostgres(),
      new GenericContainer(REDIS_IMAGE)
        .withCommand(['redis-server', '--maxmemory-policy', 'noeviction'])
        .withExposedPorts(REDIS_PORT)
        .withWaitStrategy(Wait.forListeningPorts())
        .start(),
    ]);

    redis = new Redis({
      host: redisContainer.getHost(),
      port: redisContainer.getMappedPort(REDIS_PORT),
      maxRetriesPerRequest: null,
    });
  }, SUITE_TIMEOUT_MS);

  afterAll(async () => {
    for (const replica of replicas) {
      kill(replica.process);
    }
    redis?.disconnect();
    await Promise.all([postgres?.stop(), redisContainer?.stop()]);
    rmSync(scratch, { recursive: true, force: true });
  });

  it(
    'starts without any of the variables only the API needs',
    async () => {
      const replica = start();
      await until(
        'the worker reports it is running',
        () => isRunning(replica),
        BOOT_TIMEOUT_MS,
        replica.output,
      );

      // No BETTER_AUTH_SECRET, no CORS_ORIGINS, no PORT. A worker validated
      // against the API's schema could not boot without them, and the compose
      // file would have to hand it a signing key it never uses.
      expect(replica.output()).not.toMatch(/Invalid environment configuration/);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'connects as the worker role, not the application role',
    async () => {
      const replica = replicas[0] ?? start();
      await until(
        'the worker reports it is running',
        () => isRunning(replica),
        BOOT_TIMEOUT_MS,
        replica.output,
      );

      const backends = await connectedRoles();

      // The whole least-privilege argument for this process rests on this one
      // fact, and nothing else in the system would report it if it were wrong:
      // app_user boots just as happily.
      expect(backends).toContain(postgres.workerUser);
      expect(backends).not.toContain(postgres.appUser);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'records liveness only once its queue has answered',
    async () => {
      const replica = replicas[0] ?? start();
      await until('a heartbeat has been written', () => {
        try {
          return readFileSync(replica.heartbeatFile, 'utf8').trim().length > 0;
        } catch {
          return false;
        }
      });

      const written = Number(readFileSync(replica.heartbeatFile, 'utf8').trim());
      expect(Date.now() - written).toBeLessThan(BOOT_TIMEOUT_MS);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    'leaves one schedule between two replicas',
    async () => {
      const first = replicas[0] ?? start();
      await until('the first replica is running', () => isRunning(first));

      const second = start();
      await until('the second replica is running', () => isRunning(second));

      // Two replicas booting is the normal case. An in-process timer would
      // fire once per replica, on the same rows; a scheduler keyed by a stable
      // id leaves one schedule and one job per tick however many ask for it —
      // and an id that encoded the interval would leave two whenever a deploy
      // changed it, with each version deleting the other's.
      const schedules = await redis.zrange('bull:retention:repeat', '0', '-1');
      expect(schedules).toHaveLength(1);
      expect(schedules[0]).toBe('sweep');
    },
    SUITE_TIMEOUT_MS,
  );

  // Windows has no POSIX signal delivery: Node documents SIGTERM, SIGINT and
  // SIGKILL as all terminating the target unconditionally, so the handler
  // never runs and the exit code is a signal rather than a number. The
  // behaviour is real and worth testing — it is what a rolling deploy does —
  // so it is tested where signals exist, and again against the built image in
  // the production-shaped run, which is Linux wherever it is started from.
  it.skipIf(process.platform === 'win32')(
    'stops cleanly on SIGTERM',
    async () => {
      const replica = start();
      await until(
        'the worker reports it is running',
        () => isRunning(replica),
        BOOT_TIMEOUT_MS,
        replica.output,
      );

      replica.process.kill('SIGTERM');
      const code = await replica.exited;

      expect(code).toBe(0);
      expect(replica.output()).toMatch(/letting the job in flight finish/);
      expect(replica.output()).toMatch(/Stopped\./);
      // A drain that ran after the database had gone would say so here.
      expect(replica.output()).not.toMatch(
        /Connection terminated|Did not stop cleanly/,
      );
    },
    SUITE_TIMEOUT_MS,
  );

  async function connectedRoles(): Promise<string[]> {
    const client = new Client({ connectionString: postgres.migrationUri });
    await client.connect();

    try {
      const result = await client.query<{ usename: string }>(
        'SELECT DISTINCT usename FROM pg_stat_activity WHERE datname = current_database()',
      );
      return result.rows.map((row) => row.usename);
    } finally {
      await client.end();
    }
  }
});

/**
 * Why `main.ts` owns the signal instead of using `enableShutdownHooks`.
 *
 * Nest runs every `onModuleDestroy` before any `onApplicationShutdown`, and
 * the database client disconnects in the first of those. A drain written as an
 * `onApplicationShutdown` hook would therefore wait, correctly and uselessly,
 * for a job whose transaction had already lost its connection.
 *
 * This pins that ordering. If a future Nest changes it, this test fails and
 * the workaround in `main.ts` can go.
 */
describe('the order Nest shuts a context down in', () => {
  it('destroys modules before it runs application shutdown', async () => {
    const order: string[] = [];

    @Injectable()
    class Recorder implements OnModuleDestroy, OnApplicationShutdown {
      onModuleDestroy(): void {
        order.push('onModuleDestroy');
      }

      onApplicationShutdown(): void {
        order.push('onApplicationShutdown');
      }
    }

    @Module({ providers: [Recorder] })
    class Tiny {}

    const app = await NestFactory.createApplicationContext(Tiny, {
      logger: false,
    });
    await app.close();

    expect(order).toEqual(['onModuleDestroy', 'onApplicationShutdown']);
  });
});
