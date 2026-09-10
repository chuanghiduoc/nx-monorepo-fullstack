import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';

/** Pinned to what docker-compose runs, for the same reason PostgreSQL is. */
export const MINIO_IMAGE = 'minio/minio:RELEASE.2025-09-07T16-13-09Z';
const MINIO_PORT = 9000;

/** A cold pull of the image; a warm start takes a couple of seconds. */
export const MINIO_START_TIMEOUT_MS = 180_000;

const ROOT_USER = 'minio';
const ROOT_PASSWORD = 'minio12345';

export interface TestMinio {
  readonly endpoint: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly region: string;
  /** A bucket that exists, created before this resolves. */
  readonly bucket: string;
  stop(): Promise<void>;
}

/**
 * A real object store for the storage suite.
 *
 * Real rather than mocked, because everything worth testing about the S3
 * driver is what the store does with what it is sent: whether a presigned POST
 * policy actually refuses an oversized upload, whether a `Range` request
 * returns a prefix, whether a multipart upload assembles in the order the
 * parts were numbered. A double would confirm the SDK was called.
 *
 * The bucket is created with the SDK rather than with `mc`, so the harness
 * needs nothing inside the image beyond the server itself.
 */
export async function startMinio(bucket = 'test'): Promise<TestMinio> {
  const container: StartedTestContainer = await new GenericContainer(MINIO_IMAGE)
    .withCommand(['server', '/data'])
    .withEnvironment({
      MINIO_ROOT_USER: ROOT_USER,
      MINIO_ROOT_PASSWORD: ROOT_PASSWORD,
    })
    .withExposedPorts(MINIO_PORT)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  const endpoint = `http://${container.getHost()}:${String(
    container.getMappedPort(MINIO_PORT),
  )}`;

  await createBucket(endpoint, bucket);

  return {
    endpoint,
    accessKey: ROOT_USER,
    secretKey: ROOT_PASSWORD,
    region: 'us-east-1',
    bucket,
    stop: () => container.stop().then(() => undefined),
  };
}

/**
 * Creates the bucket, waiting for the server to answer.
 *
 * `Wait.forListeningPorts` returns as soon as the port is open, which is
 * before MinIO will serve an API call. Retrying here is what turns a flaky
 * "connection reset" at the top of a suite into a couple of hundred
 * milliseconds nobody notices.
 */
async function createBucket(endpoint: string, bucket: string): Promise<void> {
  const { CreateBucketCommand, S3Client } = await import('@aws-sdk/client-s3');

  const client = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: ROOT_USER, secretAccessKey: ROOT_PASSWORD },
  });

  const deadline = Date.now() + 30_000;

  for (;;) {
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      return;
    } catch (failure) {
      const name = (failure as { name?: unknown }).name;

      if (
        name === 'BucketAlreadyOwnedByYou' ||
        name === 'BucketAlreadyExists'
      ) {
        return;
      }

      if (Date.now() > deadline) {
        throw failure;
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}
