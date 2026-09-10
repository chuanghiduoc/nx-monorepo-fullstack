import { Readable } from 'node:stream';

/** Where an object lives, and what a caller is allowed to know about it. */
export interface StoredObject {
  readonly key: string;
  readonly sizeBytes: number;
  readonly contentType?: string;
}

/** A signed URL and the moment it stops working. */
export interface SignedUrl {
  readonly url: string;
  readonly expiresAt: Date;
}

/**
 * A browser form that uploads straight to the store.
 *
 * The fields are the policy: they bound the content length and pin the key, so
 * a browser handed one of these cannot write anywhere else or write anything
 * larger. A presigned PUT cannot express either — which is why both exist.
 */
export interface SignedPost {
  readonly url: string;
  readonly fields: Record<string, string>;
  readonly expiresAt: Date;
}

/** One part of a multipart upload, and where to send it. */
export interface SignedPart {
  readonly partNumber: number;
  readonly url: string;
}

export interface MultipartUpload {
  readonly uploadId: string;
  readonly key: string;
  readonly parts: SignedPart[];
}

/** What the caller reports back after uploading each part. */
export interface CompletedPart {
  readonly partNumber: number;
  readonly etag: string;
}

/**
 * Where files go.
 *
 * Two implementations, and both are real. The S3 driver is what a deployment
 * uses; the local one exists so the whole feature runs with nothing but a
 * disk — and so the same test suite runs against both, which is the only way
 * "works with either" is a fact rather than a hope.
 *
 * Every method is about **objects**, never about records. The record is the
 * database's business and the object is this interface's, and the one rule
 * that binds them is that the key is derived from the record's id: an object
 * with no record is rubbish the cleanup may remove, and the cleanup can only
 * say that because it can ask.
 */
export interface StorageDriver {
  /** Which implementation this is, for logs and for the contract's tests. */
  readonly name: 's3' | 'local';

  /**
   * A URL a caller may PUT to.
   *
   * The simplest shape and the weakest: it bounds neither the size nor the
   * type. Right for a server uploading something it produced; wrong for a
   * browser, which is what `signedPost` is for.
   */
  signPut(key: string, contentType: string): Promise<SignedUrl>;

  /**
   * A form a browser may POST to, with the policy that bounds it.
   *
   * `maxBytes` is enforced by the store, not by us: the upload is refused at
   * the edge rather than after we have paid to receive it.
   */
  signPost(
    key: string,
    contentType: string,
    maxBytes: number,
  ): Promise<SignedPost>;

  /** A URL a caller may GET. Handed out only after authorization. */
  signGet(key: string): Promise<SignedUrl>;

  /**
   * Starts a multipart upload and signs every part.
   *
   * The only shape that survives a dropped connection, which is why it exists
   * for large files and is overkill for small ones.
   */
  beginMultipart(
    key: string,
    contentType: string,
    partCount: number,
  ): Promise<MultipartUpload>;

  completeMultipart(
    key: string,
    uploadId: string,
    parts: readonly CompletedPart[],
  ): Promise<void>;

  /** Abandons one, so a store is not left paying for orphaned parts. */
  abortMultipart(key: string, uploadId: string): Promise<void>;

  /**
   * What the store says is there, or `undefined` when nothing is.
   *
   * The size comes from here rather than from the caller, always. A caller's
   * claim about how big its upload was is a caller's claim.
   */
  head(key: string): Promise<StoredObject | undefined>;

  /**
   * The first bytes of an object.
   *
   * For sniffing the type, which needs a few hundred bytes and must never
   * read a whole upload into memory to get them.
   */
  readPrefix(key: string, bytes: number): Promise<Buffer>;

  /** Writes an object directly. The local driver's upload path, and tests. */
  put(key: string, body: Readable | Buffer, contentType: string): Promise<void>;

  remove(key: string): Promise<void>;

  /**
   * Every key under a prefix.
   *
   * For the cleanup that removes objects no record claims. Bounded by the
   * store's own paging, which both drivers follow to the end.
   */
  list(prefix: string): Promise<string[]>;
}

/** The injection token, because an interface is not one at runtime. */
export const STORAGE_DRIVER = Symbol('STORAGE_DRIVER');
