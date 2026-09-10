import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';

/** Pinned to what docker-compose runs, for the same reason PostgreSQL is. */
export const REDIS_IMAGE = 'redis:8-alpine';
const REDIS_PORT = 6379;

/** A cold pull of the image; a warm start takes about a second. */
export const REDIS_START_TIMEOUT_MS = 120_000;

export interface TestRedis {
  /** `redis://host:port`, ready to hand to ioredis. */
  readonly url: string;
  readonly host: string;
  readonly port: number;
  stop(): Promise<void>;
}

/**
 * A real Redis for the suites that need one.
 *
 * Real rather than mocked, because what is worth testing is what the server
 * does: whether a Pub/Sub message published by one client reaches a subscriber
 * held by another, whether a blocking pop actually blocks. A double would
 * confirm that ioredis was called.
 *
 * Started here rather than in each suite so the image is pinned in one place —
 * three suites reached for their own copy of the same constant before this
 * existed, which is three places for the version to drift.
 */
export async function startRedis(): Promise<TestRedis> {
  const container: StartedTestContainer = await new GenericContainer(REDIS_IMAGE)
    .withExposedPorts(REDIS_PORT)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(REDIS_PORT);

  return {
    url: `redis://${host}:${String(port)}`,
    host,
    port,
    stop: () => container.stop().then(() => undefined),
  };
}
