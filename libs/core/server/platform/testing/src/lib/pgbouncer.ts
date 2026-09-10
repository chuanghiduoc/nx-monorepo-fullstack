import { GenericContainer, Network, Wait } from 'testcontainers';
import type { StartedNetwork } from 'testcontainers';

/** Pinned; a pooler's defaults change between releases. */
export const PGBOUNCER_IMAGE = 'edoburu/pgbouncer:v1.24.1-p1';

const PGBOUNCER_PORT = 5432;
const DATABASE_ALIAS = 'postgres-under-test';

/** A pooler in front of a database takes longer than a database alone. */
export const PGBOUNCER_START_TIMEOUT_MS = 240_000;

export interface TestPgBouncer {
  /** Connection string for the pooled database, as `app_user`. */
  readonly connectionUri: string;
  stop(): Promise<void>;
}

export interface PgBouncerTarget {
  /** The database the pooler sits in front of, on the shared network. */
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

/**
 * Starts PgBouncer in **transaction** pooling mode in front of a database.
 *
 * That mode is the one worth testing. A connection is returned to the pool at
 * every `COMMIT`, so anything left on the session — a `SET`, a prepared
 * statement, an advisory lock — is inherited by whichever client is handed
 * that connection next. The tenant setting is written with `set_config(...,
 * true)`, which the database itself discards at the end of the transaction;
 * this exists to prove that claim against the pooler rather than to assert it.
 *
 * The caller owns the network so the database can join it under a known alias:
 * the pooler reaches the database by container name, not by the mapped port.
 */
export async function startPgBouncer(
  network: StartedNetwork,
  target: PgBouncerTarget,
): Promise<TestPgBouncer> {
  const container = await new GenericContainer(PGBOUNCER_IMAGE)
    .withNetwork(network)
    .withEnvironment({
      DB_HOST: DATABASE_ALIAS,
      DB_NAME: target.database,
      DB_USER: target.user,
      DB_PASSWORD: target.password,
      POOL_MODE: 'transaction',
      AUTH_TYPE: 'scram-sha-256',
      // One server connection, so every transaction in a test is handed the
      // same one. Sharing is what makes a leak observable; a pool large
      // enough to give each client its own connection would hide it.
      MAX_DB_CONNECTIONS: '1',
      DEFAULT_POOL_SIZE: '1',
      // Transaction mode cannot support server-side prepared statements
      // unless the pooler tracks them, which this release does.
      MAX_PREPARED_STATEMENTS: '100',
    })
    .withExposedPorts(PGBOUNCER_PORT)
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(PGBOUNCER_START_TIMEOUT_MS)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(PGBOUNCER_PORT);
  const credentials = `${encodeURIComponent(target.user)}:${encodeURIComponent(target.password)}`;

  return {
    connectionUri: `postgresql://${credentials}@${host}:${port}/${target.database}`,
    stop: () => container.stop().then(() => undefined),
  };
}

/** The alias the pooler resolves the database by. */
export const PGBOUNCER_DATABASE_ALIAS = DATABASE_ALIAS;

/** A network both containers join, created by the caller and stopped by it. */
export function createNetwork(): Promise<StartedNetwork> {
  return new Network().start();
}

export type { StartedNetwork };
