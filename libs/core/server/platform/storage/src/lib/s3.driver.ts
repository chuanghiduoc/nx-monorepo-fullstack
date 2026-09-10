import { Readable } from 'node:stream';

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type {
  CompletedPart,
  MultipartUpload,
  SignedPart,
  SignedPost,
  SignedUrl,
  StorageDriver,
  StoredObject,
} from './storage.driver.js';

export interface S3Settings {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKey: string;
  readonly secretKey: string;
  /** How long a signature is good for. */
  readonly signedUrlTtlSeconds: number;
}

/**
 * The driver a deployment uses.
 *
 * `forcePathStyle`, because MinIO — and every other S3-compatible store worth
 * running locally — serves `endpoint/bucket/key` rather than
 * `bucket.endpoint/key`. Virtual-host style needs DNS for every bucket, which
 * a developer's machine does not have.
 */
export class S3Driver implements StorageDriver {
  readonly name = 's3' as const;

  private readonly client: S3Client;
  private readonly settings: S3Settings;

  constructor(settings: S3Settings) {
    this.settings = settings;
    this.client = new S3Client({
      endpoint: settings.endpoint,
      region: settings.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: settings.accessKey,
        secretAccessKey: settings.secretKey,
      },
    });
  }

  async signPut(key: string, contentType: string): Promise<SignedUrl> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.settings.bucket,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: this.settings.signedUrlTtlSeconds },
    );

    return { url, expiresAt: this.expiry() };
  }

  /**
   * A browser form, with the policy that bounds it.
   *
   * `content-length-range` is what a presigned PUT cannot express, and it is
   * the whole reason this shape exists: the store refuses an oversized upload
   * at the edge rather than after we have paid to receive it.
   *
   * The key is pinned exactly — `['eq', '$key', key]` rather than a prefix —
   * so a form handed to a browser writes to one place and nowhere else.
   */
  async signPost(
    key: string,
    contentType: string,
    maxBytes: number,
  ): Promise<SignedPost> {
    const { url, fields } = await createPresignedPost(this.client, {
      Bucket: this.settings.bucket,
      Key: key,
      Conditions: [
        ['eq', '$key', key],
        ['eq', '$Content-Type', contentType],
        ['content-length-range', 1, maxBytes],
      ],
      Fields: { 'Content-Type': contentType },
      Expires: this.settings.signedUrlTtlSeconds,
    });

    return { url, fields, expiresAt: this.expiry() };
  }

  async signGet(key: string): Promise<SignedUrl> {
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.settings.bucket, Key: key }),
      { expiresIn: this.settings.signedUrlTtlSeconds },
    );

    return { url, expiresAt: this.expiry() };
  }

  async beginMultipart(
    key: string,
    contentType: string,
    partCount: number,
  ): Promise<MultipartUpload> {
    const created = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.settings.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );

    const uploadId = created.UploadId;

    if (uploadId === undefined) {
      throw new Error(`The store did not return an upload id for ${key}.`);
    }

    const parts: SignedPart[] = [];

    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      parts.push({
        partNumber,
        url: await getSignedUrl(
          this.client,
          new UploadPartCommand({
            Bucket: this.settings.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
          }),
          { expiresIn: this.settings.signedUrlTtlSeconds },
        ),
      });
    }

    return { uploadId, key, parts };
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: readonly CompletedPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.settings.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          // Sorted, because S3 requires ascending part numbers and a caller
          // that uploaded them concurrently has no reason to report them in
          // order. Out of order is a `InvalidPartOrder` that names nothing.
          Parts: [...parts]
            .sort((left, right) => left.partNumber - right.partNumber)
            .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
        },
      }),
    );
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.settings.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async head(key: string): Promise<StoredObject | undefined> {
    try {
      const found = await this.client.send(
        new HeadObjectCommand({ Bucket: this.settings.bucket, Key: key }),
      );

      return {
        key,
        sizeBytes: found.ContentLength ?? 0,
        ...(found.ContentType === undefined
          ? {}
          : { contentType: found.ContentType }),
      };
    } catch (failure) {
      if (isNotFound(failure)) {
        return undefined;
      }
      throw failure;
    }
  }

  /**
   * The first bytes, with a `Range` header.
   *
   * Not `GetObject` and then a slice: sniffing the type of a five-gigabyte
   * upload must not read five gigabytes.
   */
  async readPrefix(key: string, bytes: number): Promise<Buffer> {
    try {
      const object = await this.client.send(
        new GetObjectCommand({
          Bucket: this.settings.bucket,
          Key: key,
          Range: `bytes=0-${bytes - 1}`,
        }),
      );

      const body = object.Body;

      if (body === undefined) {
        return Buffer.alloc(0);
      }

      return Buffer.from(await body.transformToByteArray());
    } catch (failure) {
      // An absent object reads as no bytes, matching `head` and matching the
      // local driver. The suite that runs against both is what found this:
      // S3 raises `NoSuchKey` where the local driver returned an empty buffer,
      // so a scan of an upload that never arrived was an exception on one
      // driver and an empty verdict on the other.
      if (isNotFound(failure)) {
        return Buffer.alloc(0);
      }
      throw failure;
    }
  }

  async put(
    key: string,
    body: Readable | Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.settings.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async remove(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.settings.bucket, Key: key }),
    );
  }

  /**
   * Every key under a prefix, following the store's paging to the end.
   *
   * A single `ListObjectsV2` returns at most a thousand keys and says so with
   * a continuation token. Ignoring it is how a cleanup silently stops at the
   * first thousand objects and leaves the rest for ever.
   */
  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;

    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.settings.bucket,
          Prefix: prefix,
          ...(token === undefined ? {} : { ContinuationToken: token }),
        }),
      );

      for (const object of page.Contents ?? []) {
        if (object.Key !== undefined) {
          keys.push(object.Key);
        }
      }

      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined);

    return keys;
  }

  private expiry(): Date {
    return new Date(Date.now() + this.settings.signedUrlTtlSeconds * 1_000);
  }
}

/** S3 says "not there" in three different ways depending on the operation. */
function isNotFound(failure: unknown): boolean {
  const candidate = failure as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };

  return (
    candidate.name === 'NotFound' ||
    candidate.name === 'NoSuchKey' ||
    candidate.$metadata?.httpStatusCode === 404
  );
}
