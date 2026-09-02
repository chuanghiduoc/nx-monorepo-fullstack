import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

/** Pulled once, then cached by Docker; pinned to what docker-compose runs. */
export const POSTGRES_IMAGE = 'postgres:18-alpine';

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
export async function startPostgres(): Promise<TestPostgres> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const migrationUri = container.getConnectionUri();

  // Migrations run as the owner; the roles they create are NOLOGIN, so the
  // suite's login is granted here — the same split a deployment makes, where
  // the password comes from the environment rather than from git.
  runMigrations(migrationUri);
  const connectionUri = await grantAppLogin(container, migrationUri);

  process.env['DATABASE_URL'] = connectionUri;

  return {
    connectionUri,
    migrationUri,
    createDatabase: (name) => createDatabase(container, name),
    stop: () => container.stop().then(() => undefined),
  };
}

async function grantAppLogin(
  container: StartedPostgreSqlContainer,
  migrationUri: string,
): Promise<string> {
  await psql(
    container,
    `ALTER ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'`,
  );

  const uri = new URL(migrationUri);
  uri.username = APP_ROLE;
  uri.password = APP_PASSWORD;
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

function runMigrations(connectionUri: string): void {
  try {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: dataAccessRoot,
      env: { ...process.env, DATABASE_URL: connectionUri },
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
