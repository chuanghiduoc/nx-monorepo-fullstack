import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MINIO_START_TIMEOUT_MS,
  startMinio,
  type TestMinio,
} from '@workspace/core-server-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LocalDriver } from './local.driver.js';
import { S3Driver } from './s3.driver.js';
import type { StorageDriver } from './storage.driver.js';

const TTL_SECONDS = 300;
const SECRET = 'a-signing-secret-that-is-long-enough-to-be-one';

/** A real PNG header, so `file-type` and any store agree what this is. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0x21),
]);

let minio: TestMinio;
let scratch: string;

beforeAll(async () => {
  minio = await startMinio();
  scratch = mkdtempSync(join(tmpdir(), 'storage-spec-'));
}, MINIO_START_TIMEOUT_MS);

afterAll(async () => {
  await minio?.stop();
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Both drivers, one suite.
 *
 * "Works with either driver" is a claim, and running the same expectations
 * against both is the only thing that makes it a fact. Everything here is
 * behaviour the interface promises — never a detail of how one of them keeps
 * its objects.
 *
 * Against a real MinIO rather than a double, because what is worth testing is
 * what a store does with what it is sent: whether a `Range` request returns a
 * prefix, whether multipart assembles in part order, whether a HEAD on a
 * missing key is an absence rather than an exception.
 */
describe.each([
  [
    's3',
    () =>
      new S3Driver({
        endpoint: minio.endpoint,
        region: minio.region,
        bucket: minio.bucket,
        accessKey: minio.accessKey,
        secretKey: minio.secretKey,
        signedUrlTtlSeconds: TTL_SECONDS,
      }) as StorageDriver,
  ],
  [
    'local',
    () =>
      new LocalDriver({
        root: scratch,
        publicOrigin: 'http://localhost:3000',
        secret: SECRET,
        signedUrlTtlSeconds: TTL_SECONDS,
      }) as StorageDriver,
  ],
])('the %s driver', (name, build) => {
  const keyFor = (what: string) => `org/${name}/${what}-${Date.now()}`;

  it('names itself, so a log line says which one ran', () => {
    expect(build().name).toBe(name);
  });

  it('stores an object and reports what the store holds', async () => {
    const driver = build();
    const key = keyFor('put');

    await driver.put(key, PNG, 'image/png');

    const found = await driver.head(key);

    // The size comes from the store, never from the caller: a caller's claim
    // about how big its upload was is a caller's claim.
    expect(found?.sizeBytes).toBe(PNG.byteLength);
  });

  it('says nothing is there rather than throwing', async () => {
    // An absence is an answer. A driver that threw would make "has this been
    // uploaded yet" a try/catch at every call site.
    expect(await build().head(keyFor('missing'))).toBeUndefined();
  });

  it('reads a prefix without reading the object', async () => {
    const driver = build();
    const key = keyFor('prefix');
    const large = Buffer.concat([PNG, Buffer.alloc(200_000, 0x41)]);

    await driver.put(key, large, 'image/png');

    const prefix = await driver.readPrefix(key, 16);

    // Sniffing the type of a large upload must not read the whole thing.
    expect(prefix.byteLength).toBe(16);
    expect(prefix.subarray(0, 8)).toEqual(PNG.subarray(0, 8));
  });

  it('returns an empty prefix for an object that is not there', async () => {
    expect((await build().readPrefix(keyFor('gone'), 16)).byteLength).toBe(0);
  });

  it('removes an object, and removing it again is not an error', async () => {
    const driver = build();
    const key = keyFor('remove');

    await driver.put(key, PNG, 'image/png');
    await driver.remove(key);
    await driver.remove(key);

    expect(await driver.head(key)).toBeUndefined();
  });

  it('lists what is under a prefix and nothing else', async () => {
    const driver = build();
    const stamp = String(Date.now());
    const mine = `org/${name}/list-${stamp}`;
    const theirs = `org/${name}/other-${stamp}`;

    await driver.put(`${mine}/a`, PNG, 'image/png');
    await driver.put(`${mine}/b`, PNG, 'image/png');
    await driver.put(`${theirs}/c`, PNG, 'image/png');

    const listed = await driver.list(mine);

    // The cleanup decides what to delete from this, so a prefix that leaked
    // one neighbouring key would delete somebody else's object.
    expect(listed.sort()).toEqual([`${mine}/a`, `${mine}/b`]);
  });

  it('signs a URL that expires', async () => {
    const signed = await build().signPut(keyFor('sign'), 'image/png');

    expect(signed.url).toMatch(/^https?:\/\//);
    expect(signed.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(signed.expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + TTL_SECONDS * 1_000 + 1_000,
    );
  });

  it('signs a browser form whose policy bounds the size', async () => {
    const signed = await build().signPost(keyFor('post'), 'image/png', 1_024);

    // The size bound is the whole reason this shape exists beside `signPut`:
    // a PUT URL cannot express it, so a browser handed one is an unbounded
    // write. Both drivers carry it, but not in the same place — S3 puts the
    // conditions inside a base64 `Policy` field, so a test that searched the
    // fields as text passed on the local driver and failed on the real one.
    expect(signed.url).toMatch(/^https?:\/\//);
    expect(policyText(signed.fields)).toContain('1024');
  });

  it('assembles a multipart upload in part order', async () => {
    const driver = build();
    const key = keyFor('multipart');

    // Five megabytes is S3's minimum for every part but the last, so a test
    // with smaller parts passes locally and fails against a real store.
    const first = Buffer.alloc(5 * 1024 * 1024, 0x41);
    const second = Buffer.alloc(1_024, 0x42);

    const upload = await driver.beginMultipart(key, 'application/octet-stream', 2);
    expect(upload.parts).toHaveLength(2);

    const etags = await uploadParts(driver, upload, [first, second]);

    // Reported out of order deliberately: a caller that uploaded parts
    // concurrently has no reason to report them in order, and assembling them
    // in arrival order would corrupt the file.
    await driver.completeMultipart(key, upload.uploadId, [
      { partNumber: 2, etag: etags[1] as string },
      { partNumber: 1, etag: etags[0] as string },
    ]);

    const found = await driver.head(key);
    expect(found?.sizeBytes).toBe(first.byteLength + second.byteLength);

    const head = await driver.readPrefix(key, 4);
    expect(head.every((byte) => byte === 0x41)).toBe(true);
  }, 120_000);

  it('abandons a multipart upload without leaving the object', async () => {
    const driver = build();
    const key = keyFor('abort');

    const upload = await driver.beginMultipart(key, 'application/octet-stream', 1);
    await driver.abortMultipart(key, upload.uploadId);

    // A store that kept the parts would be paying for them for ever.
    expect(await driver.head(key)).toBeUndefined();
  });
});

/**
 * The policy a signed form carries, whichever driver produced it.
 *
 * S3 base64-encodes its conditions into `Policy`; the local driver states them
 * as plain fields. Decoding the one and reading the other is what lets a
 * single expectation mean the same thing for both.
 */
function policyText(fields: Record<string, string>): string {
  const encoded = fields['Policy'];

  return encoded === undefined
    ? JSON.stringify(fields)
    : Buffer.from(encoded, 'base64').toString('utf8');
}

/**
 * Uploads each part the way a caller would, and returns the etags.
 *
 * The local driver has no HTTP route in this suite, so its parts go through
 * the method the route would call. That is the one place the two paths differ,
 * and it is why it is here rather than in a test.
 */
async function uploadParts(
  driver: StorageDriver,
  upload: { uploadId: string; key: string; parts: { partNumber: number; url: string }[] },
  bodies: readonly Buffer[],
): Promise<string[]> {
  const etags: string[] = [];

  for (const part of upload.parts) {
    const body = bodies[part.partNumber - 1];

    if (body === undefined) {
      throw new Error(`No body for part ${part.partNumber}`);
    }

    if (driver instanceof LocalDriver) {
      driver.acceptPart(upload.key, upload.uploadId, part.partNumber, body);
      etags.push(`local-${part.partNumber}`);
      continue;
    }

    const response = await fetch(part.url, {
      method: 'PUT',
      body: new Uint8Array(body),
    });

    if (!response.ok) {
      throw new Error(
        `Part ${part.partNumber} failed: ${response.status} ${await response.text()}`,
      );
    }

    const etag = response.headers.get('etag');

    if (etag === null) {
      throw new Error(`The store returned no etag for part ${part.partNumber}`);
    }

    etags.push(etag);
  }

  return etags;
}
