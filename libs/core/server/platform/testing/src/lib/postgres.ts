import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { StartedNetwork } from 'testcontainers';

/**
 * Pulled once, then cached by Docker; pinned to what docker-compose runs.
 *
 * `pgvector/pgvector:pg18` rather than `postgres:18-alpine`, and the reason is
 * not a preference: measured, the Alpine image's `pg_available_extensions`
 * lists `pg_trgm` and `pgcrypto` and **no `vector`**, so a migration that
 * creates the extension fails on it. This image is PostgreSQL 18.6 — the same
 * server — with `vector` 0.8.6, on Debian.
 *
 * The cost is a larger image and a slower first pull. The alternative is a
 * schema the tests cannot apply.
 */
export const POSTGRES_IMAGE = 'pgvector/pgvector:pg18';

/** Enough for a cold image pull on CI; a warm start takes a few seconds. */
export const POSTGRES_START_TIMEOUT_MS = 180_000;

// src/lib -> testing -> platform -> server -> core -> libs -> workspace root.
// The migrations and the prisma config live with the data-access library.
const WORKSPACE_ROOT = join(import.meta.dirname, '../../../../../../..');
const dataAccessRoot = join(
  WORKSPACE_ROOT,
  'libs/core/server/platform/data-access-db',
);

/** The application's role: bound by RLS, no DDL, no BYPASSRLS. */
const APP_ROLE = 'app_user';
const APP_PASSWORD = 'app_user';

/** The worker's role: the same rights minus the ones only a request needs. */
const WORKER_ROLE = 'worker_user';
const WORKER_PASSWORD = 'worker_user';

/**
 * The erasure job's role: the only one that may delete a person or edit an
 * audit record. Neither application connects as it, which is the property a
 * test running as it is there to prove.
 */
const ERASURE_ROLE = 'erasure_role';
const ERASURE_PASSWORD = 'erasure_role';

export interface StartPostgresOptions {
  /**
   * A network to join, and the alias to answer to on it.
   *
   * Only needed when another container has to reach this one — a pooler in
   * front of it, say. The mapped port a test uses is not reachable from
   * inside another container.
   */
  readonly network?: StartedNetwork;
  readonly networkAlias?: string;
}

export interface TestPostgres {
  /**
   * Connection string for the migrated database **as `app_user`**.
   *
   * Not the container's superuser: `FORCE ROW LEVEL SECURITY` binds table
   * owners and never superusers, so a suite running as one would prove
   * isolation it does not have.
   */
  readonly connectionUri: string;
  /** Owner connection, for migrations and for setup a policy would block. */
  readonly migrationUri: string;
  /** Creates an empty sibling database, e.g. a Prisma shadow database. */
  createDatabase(name: string): Promise<string>;
  /** The database name, for a client that reaches this over a network alias. */
  readonly database: string;
  /** The application role and its password, for the same reason. */
  readonly appUser: string;
  readonly appPassword: string;
  /**
   * Connection string for the same database **as `worker_user`**.
   *
   * A test that starts the worker has to hand it the role the worker really
   * connects as; running it as `app_user` would prove nothing about the
   * grants it depends on.
   */
  readonly workerUri: string;
  readonly workerUser: string;
  readonly workerPassword: string;
  /**
   * Connection string as `erasure_role`.
   *
   * A separate one because the whole point of that role is that neither
   * application holds its rights: a test that erased as the owner would prove
   * nothing about the grants, and one that erased as `worker_user` would prove
   * the opposite of what is wanted.
   */
  readonly erasureUri: string;
  stop(): Promise<void>;
}

/**
 * One way to get a database in a test.
 *
 * Starts a real PostgreSQL 18 and applies every migration with the same
 * command a deployment uses — so a test never runs against a schema that
 * differs from production's, and a migration that fails to apply fails here.
 *
 * The prisma CLI is invoked directly rather than through its Nx target: test
 * files run in parallel workers, and concurrent `nx run` processes contend
 * for the workspace lock.
 *
 * `DATABASE_URL` is set on the process because the data-access layer reads it
 * at construction time, which is the same contract the application has.
 */
export async function startPostgres(
  options: StartPostgresOptions = {},
): Promise<TestPostgres> {
  let image = new PostgreSqlContainer(POSTGRES_IMAGE);

  if (options.network && options.networkAlias) {
    image = image
      .withNetwork(options.network)
      .withNetworkAliases(options.networkAlias);
  }

  const container = await image.start();
  const migrationUri = container.getConnectionUri();

  // Migrations run as the owner; the roles they create are NOLOGIN, so the
  // suite's login is granted here — the same split a deployment makes, where
  // the password comes from the environment rather than from git.
  runMigrations(migrationUri);
  const connectionUri = await grantLogin(
    container,
    migrationUri,
    APP_ROLE,
    APP_PASSWORD,
  );
  const workerUri = await grantLogin(
    container,
    migrationUri,
    WORKER_ROLE,
    WORKER_PASSWORD,
  );
  const erasureUri = await grantLogin(
    container,
    migrationUri,
    ERASURE_ROLE,
    ERASURE_PASSWORD,
  );

  process.env['DATABASE_URL'] = connectionUri;

  return {
    connectionUri,
    migrationUri,
    createDatabase: (name) => createDatabase(container, name),
    database: container.getDatabase(),
    appUser: APP_ROLE,
    appPassword: APP_PASSWORD,
    workerUri,
    workerUser: WORKER_ROLE,
    workerPassword: WORKER_PASSWORD,
    erasureUri,
    stop: () => container.stop().then(() => undefined),
  };
}

async function grantLogin(
  container: StartedPostgreSqlContainer,
  migrationUri: string,
  role: string,
  password: string,
): Promise<string> {
  await psql(container, `ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);

  const uri = new URL(migrationUri);
  uri.username = role;
  uri.password = password;
  return uri.toString();
}

async function psql(
  container: StartedPostgreSqlContainer,
  sql: string,
): Promise<void> {
  const result = await container.exec([
    'psql',
    '-U',
    container.getUsername(),
    '-d',
    container.getDatabase(),
    '-c',
    sql,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(`psql failed (${sql}): ${result.output}`);
  }
}

/**
 * The environment the migration runs in, with every other database removed.
 *
 * The Prisma configuration prefers `MIGRATION_DATABASE_URL` when it is set,
 * and a developer's `.env` sets it to their local database — which the task
 * runner loads into every task. Inheriting the ambient environment therefore
 * pointed `migrate deploy` at the developer's own database while the container
 * stayed empty: the suite then failed on a role that had never been created,
 * and the real database had migrations applied to it by a test run.
 *
 * Deleting the keys rather than blanking them matters: an empty string is
 * still a value the configuration would prefer over the one passed here.
 */
function migrationEnvironment(connectionUri: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };

  delete environment['MIGRATION_DATABASE_URL'];
  delete environment['SHADOW_DATABASE_URL'];
  environment['DATABASE_URL'] = connectionUri;

  return environment;
}

function runMigrations(connectionUri: string): void {
  try {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: dataAccessRoot,
      env: migrationEnvironment(connectionUri),
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
  } catch (error) {
    const failure = error as {
      message?: string;
      stderr?: Buffer;
      stdout?: Buffer;
    };
    throw new Error(
      `prisma migrate deploy failed in ${dataAccessRoot}: ${failure.message ?? ''}
${failure.stderr?.toString() ?? ''}${failure.stdout?.toString() ?? ''}`,
    );
  }
}

async function createDatabase(
  container: StartedPostgreSqlContainer,
  name: string,
): Promise<string> {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`Database name "${name}" is not a plain identifier`);
  }

  await psql(container, `CREATE DATABASE ${name}`);

  // The owner connection: a shadow database is Prisma's to reset, and
  // app_user has no rights there.
  return container.getConnectionUri().replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
}
