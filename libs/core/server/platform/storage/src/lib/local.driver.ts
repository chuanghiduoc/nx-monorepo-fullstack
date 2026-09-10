import { createHmac, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import type {
  CompletedPart,
  MultipartUpload,
  SignedPart,
  SignedPost,
  SignedUrl,
  StorageDriver,
  StoredObject,
} from './storage.driver.js';

export interface LocalSettings {
  /** Where objects go. One directory, and everything under it is ours. */
  readonly root: string;
  /**
   * Where a caller reaches this API, so a signed URL is one somebody can use.
   */
  readonly publicOrigin: string;
  /** Signs the URLs. Without it a "signed" local URL is any URL. */
  readonly secret: string;
  readonly signedUrlTtlSeconds: number;
}

/** The route the API mounts to receive and serve local objects. */
export const LOCAL_UPLOAD_PATH = '/api/v1/files/local';

/**
 * Files on a disk, signed the same way S3 signs them.
 *
 * A real driver, not a stub, and that is the point: the whole feature runs
 * with no object store at all, and the same test suite runs against both — the
 * only way "works with either" is a fact rather than a hope.
 *
 * **The signature is real.** A local URL carries an expiry and an HMAC over
 * the method, the key and that expiry, and the route that receives it verifies
 * both. A driver that skipped this because "it is only development" would be a
 * driver whose tests prove nothing about the one that matters — and an open
 * write endpoint the day somebody runs it somewhere real.
 */
export class LocalDriver implements StorageDriver {
  readonly name = 'local' as const;

  private readonly settings: LocalSettings;
  /** Parts held until the upload is completed, by `${key}\u0000${uploadId}`. */
  private readonly multiparts = new Map<string, Map<number, Buffer>>();

  constructor(settings: LocalSettings) {
    this.settings = settings;
  }

  async signPut(key: string, _contentType: string): Promise<SignedUrl> {
    return this.sign('PUT', key);
  }

  /**
   * The local answer to a browser POST policy.
   *
   * The fields carry what the S3 policy would put in its conditions, and the
   * receiving route enforces them — the size especially, which it checks as
   * the bytes arrive rather than after.
   */
  async signPost(
    key: string,
    contentType: string,
    maxBytes: number,
  ): Promise<SignedPost> {
    const signed = await this.sign('POST', key, String(maxBytes));

    return {
      url: signed.url,
      fields: {
        key,
        'Content-Type': contentType,
        'x-max-bytes': String(maxBytes),
      },
      expiresAt: signed.expiresAt,
    };
  }

  async signGet(key: string): Promise<SignedUrl> {
    return this.sign('GET', key);
  }

  async beginMultipart(
    key: string,
    contentType: string,
    partCount: number,
  ): Promise<MultipartUpload> {
    const uploadId = `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.multiparts.set(partKey(key, uploadId), new Map());

    const parts: SignedPart[] = [];

    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      const signed = await this.sign(
        'PUT',
        key,
        `${uploadId}:${String(partNumber)}`,
      );
      parts.push({ partNumber, url: signed.url });
    }

    return { uploadId, key, parts };
  }

  /** Receives one part. Called by the route, not by a caller. */
  acceptPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ): void {
    const held = this.multiparts.get(partKey(key, uploadId));

    if (held === undefined) {
      throw new Error(`No multipart upload ${uploadId} for ${key}.`);
    }

    held.set(partNumber, body);
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: readonly CompletedPart[],
  ): Promise<void> {
    const held = this.multiparts.get(partKey(key, uploadId));

    if (held === undefined) {
      throw new Error(`No multipart upload ${uploadId} for ${key}.`);
    }

    // Ascending, like S3 requires, and for the same reason: a caller that
    // uploaded parts concurrently has no reason to report them in order, and
    // concatenating them in the order they arrived would corrupt the file.
    const ordered = [...parts]
      .sort((left, right) => left.partNumber - right.partNumber)
      .map((part) => {
        const body = held.get(part.partNumber);

        if (body === undefined) {
          throw new Error(
            `Part ${part.partNumber} of ${key} was never uploaded.`,
          );
        }

        return body;
      });

    await this.put(key, Buffer.concat(ordered), 'application/octet-stream');
    this.multiparts.delete(partKey(key, uploadId));
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    this.multiparts.delete(partKey(key, uploadId));
  }

  async head(key: string): Promise<StoredObject | undefined> {
    try {
      const found = await stat(this.pathFor(key));
      return { key, sizeBytes: found.size };
    } catch (failure) {
      if (isMissing(failure)) {
        return undefined;
      }
      throw failure;
    }
  }

  /**
   * The first bytes, read with a file handle rather than by reading the file.
   *
   * Sniffing the type of a five-gigabyte upload must not read five gigabytes,
   * on this driver any more than on the other one.
   */
  async readPrefix(key: string, bytes: number): Promise<Buffer> {
    let handle;

    try {
      handle = await open(this.pathFor(key), 'r');
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead);
    } catch (failure) {
      if (isMissing(failure)) {
        return Buffer.alloc(0);
      }
      throw failure;
    } finally {
      // Every path, including the one that threw: a handle left open is a file
      // that cannot be deleted on Windows and a descriptor leak everywhere.
      await handle?.close();
    }
  }

  async put(
    key: string,
    body: Readable | Buffer,
    _contentType: string,
  ): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });

    if (Buffer.isBuffer(body)) {
      await pipeline(Readable.from(body), createWriteStream(path));
      return;
    }

    await pipeline(body, createWriteStream(path));
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async list(prefix: string): Promise<string[]> {
    const root = resolve(this.settings.root);

    try {
      const entries = await readdir(root, {
        recursive: true,
        withFileTypes: true,
      });

      return entries
        .filter((entry) => entry.isFile())
        .map((entry) =>
          relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'),
        )
        .filter((key) => key.startsWith(prefix))
        .sort();
    } catch (failure) {
      if (isMissing(failure)) {
        return [];
      }
      throw failure;
    }
  }

  /** Checks a signature the receiving route was handed. */
  verify(
    method: string,
    key: string,
    expiresAt: number,
    signature: string,
    extra = '',
  ): boolean {
    if (!Number.isSafeInteger(expiresAt) || expiresAt * 1_000 < Date.now()) {
      return false;
    }

    const expected = this.digest(method, key, expiresAt, extra);
    const candidate = Buffer.from(signature, 'hex');

    // `timingSafeEqual` throws on a length mismatch, and a comparison that
    // returned early on length would leak the digest's size.
    return (
      candidate.length === expected.length &&
      timingSafeEqual(candidate, expected)
    );
  }

  /**
   * Where a key lives on disk, refusing anything that escapes the root.
   *
   * The key is derived from a record id, so this should never fire — which is
   * exactly why it is here: the day something builds a key from a filename,
   * `../../etc/passwd` must be a thrown error rather than a write.
   */
  private pathFor(key: string): string {
    const root = resolve(this.settings.root);
    const path = resolve(root, key);

    if (path !== root && !path.startsWith(root + sep)) {
      throw new Error(`The object key "${key}" escapes the storage root.`);
    }

    return path;
  }

  private async sign(
    method: string,
    key: string,
    extra = '',
  ): Promise<SignedUrl> {
    const expiresAt =
      Math.floor(Date.now() / 1_000) + this.settings.signedUrlTtlSeconds;
    const signature = this.digest(method, key, expiresAt, extra).toString('hex');

    const url = new URL(
      `${this.settings.publicOrigin}${LOCAL_UPLOAD_PATH}/${encodeURIComponent(key)}`,
    );
    url.searchParams.set('expires', String(expiresAt));
    url.searchParams.set('signature', signature);

    if (extra !== '') {
      url.searchParams.set('extra', extra);
    }

    return { url: url.toString(), expiresAt: new Date(expiresAt * 1_000) };
  }

  private digest(
    method: string,
    key: string,
    expiresAt: number,
    extra: string,
  ): Buffer {
    // The method is in the signed material, so a GET signature cannot be
    // replayed as a PUT — which would turn a read link into a write one.
    return createHmac('sha256', this.settings.secret)
      .update(`${method}\n${key}\n${String(expiresAt)}\n${extra}`)
      .digest();
  }
}

/**
 * One map key from an object key and an upload id.
 *
 * NUL separates them because it is the one character neither of them can
 * contain, so `partKey('a', 'b:c')` and `partKey('a:b', 'c')` cannot collide
 * the way they would under any printable separator — and a collision here
 * hands one upload's parts to another.
 *
 * Written as an escape and never as the byte itself. A literal NUL in a source
 * file makes git, grep and diff classify the whole file as binary: measured,
 * `git status` reported this file as binary, `grep` refused to print a match
 * in it, and `.gitattributes`'s `text=auto` therefore stopped normalising its
 * line endings. The file stops being reviewable, which is a high price for a
 * character that has a six-keystroke spelling.
 */
function partKey(key: string, uploadId: string): string {
  return `${key}\u0000${uploadId}`;
}

function isMissing(failure: unknown): boolean {
  return (failure as { code?: unknown }).code === 'ENOENT';
}
