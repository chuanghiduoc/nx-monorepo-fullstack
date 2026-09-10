import { Buffer } from 'node:buffer';

import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  PayloadTooLargeException,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { AppConfig, SignedRequest } from '@workspace/core-server-core';
import {
  LocalDriver,
  STORAGE_DRIVER,
  type StorageDriver,
} from '@workspace/core-server-storage';
// For `request.file()`, which the plugin adds to Fastify's request type. The
// plugin itself is registered by the application, not here: this import is
// erased at compile time, and the `post` route below refuses rather than
// crashes if an application mounts this controller without registering it.
import type {} from '@fastify/multipart';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** One message for every refusal a signature can produce. */
const NOT_VALID = 'That link is not valid.';

/** What the size bound says when it fires. */
const TOO_LARGE = 'The upload is larger than the signed policy allows.';

const OK = 200;

/** A part URL signs `uploadId:partNumber`; anything else is a whole object. */
const PART_EXTRA = /^(?<uploadId>[^:]+):(?<partNumber>\d+)$/;

/**
 * The other end of a `local` driver's signed URL.
 *
 * Without it the local driver signs URLs nothing serves, which is a driver
 * that looks complete and cannot store a byte. The e2e suite is what noticed:
 * the `PUT` came back with a 404 that named nothing.
 *
 * All three shapes are served, because the driver signs all three and a shape
 * it signs but cannot receive is worse than one it refuses — `post` is the
 * API's default, so a local deployment would fail on the ordinary path.
 *
 * **Excluded from the OpenAPI document.** It is not part of the API's contract
 * — it is where a signed URL happens to point, and publishing it would invite
 * a client to call it directly, without a signature, which is the one thing it
 * refuses.
 *
 * Every request here is verified against the signature the driver produced:
 * the method, the key and the expiry are all in the signed material, so a read
 * link cannot be replayed as a write and an expired one is refused.
 */
@ApiExcludeController()
// The signature is the whole of the authorization here: no session cookie is
// read, so there is no ambient authority a cross-site page could borrow, and
// requiring an allowed `Origin` would refuse a server upload while stopping
// nothing.
@SignedRequest()
@Controller({ path: 'v1/files/local' })
export class LocalStorageController {
  private readonly storage: StorageDriver;
  private readonly config: AppConfig;

  constructor(
    @Inject(STORAGE_DRIVER) storage: StorageDriver,
    @Inject(AppConfig) config: AppConfig,
  ) {
    this.storage = storage;
    this.config = config;
  }

  /** Receives a whole object, or one part of a multipart upload. */
  @Put(':key')
  @HttpCode(OK)
  async put(
    @Param('key') key: string,
    @Query('expires') expires: string,
    @Query('signature') signature: string,
    @Query('extra') extra: string | undefined,
    @Req() request: FastifyRequest,
  ): Promise<{ ok: true }> {
    const local = this.mustBeLocal();
    const objectKey = decodeURIComponent(key);
    const signed = extra ?? '';

    if (!local.verify('PUT', objectKey, Number(expires), signature, signed)) {
      // One message for a bad signature and an expired one: telling a caller
      // which it was tells them something about the key.
      throw new ForbiddenException(NOT_VALID);
    }

    const body = await this.readWholeBody(request);
    const part = PART_EXTRA.exec(signed)?.groups;

    if (part !== undefined) {
      // The part's identity is signed rather than merely passed, so a caller
      // holding one part URL cannot write over another part.
      local.acceptPart(
        objectKey,
        part['uploadId'] as string,
        Number(part['partNumber']),
        body,
      );

      return { ok: true };
    }

    await local.put(objectKey, body, 'application/octet-stream');

    return { ok: true };
  }

  /**
   * Receives a browser form, the way an object store's POST policy would.
   *
   * The signed `extra` is the byte ceiling the policy states, which is why the
   * bound here is the one the ticket promised rather than the deployment's
   * maximum: a caller cannot widen its own policy by editing a form field.
   */
  @Post(':key')
  @HttpCode(OK)
  async post(
    @Param('key') key: string,
    @Query('expires') expires: string,
    @Query('signature') signature: string,
    @Query('extra') extra: string | undefined,
    @Req() request: FastifyRequest,
  ): Promise<{ ok: true }> {
    const local = this.mustBeLocal();
    const objectKey = decodeURIComponent(key);
    const signed = extra ?? '';

    if (!local.verify('POST', objectKey, Number(expires), signature, signed)) {
      throw new ForbiddenException(NOT_VALID);
    }

    const maxBytes = Number(signed);

    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new ForbiddenException(NOT_VALID);
    }

    if (typeof request.file !== 'function') {
      throw new NotFoundException(
        'This application did not register a multipart parser, so a form upload cannot be received.',
      );
    }

    const uploaded = await request.file({ limits: { fileSize: maxBytes } });

    if (uploaded === undefined) {
      throw new NotFoundException('The form carried no file.');
    }

    const body = await uploaded.toBuffer();

    // Busboy stops at the ceiling rather than throwing, so a truncated file
    // would otherwise be stored as a short one and pass the scan as whatever
    // its first bytes happen to look like.
    if (uploaded.file.truncated) {
      throw new PayloadTooLargeException(TOO_LARGE);
    }

    await local.put(objectKey, body, 'application/octet-stream');

    return { ok: true };
  }

  /** Serves an object a signed `GET` asked for. */
  @Get(':key')
  async get(
    @Param('key') key: string,
    @Query('expires') expires: string,
    @Query('signature') signature: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const local = this.mustBeLocal();
    const objectKey = decodeURIComponent(key);

    if (!local.verify('GET', objectKey, Number(expires), signature)) {
      throw new ForbiddenException(NOT_VALID);
    }

    const object = await local.head(objectKey);

    if (object === undefined) {
      throw new NotFoundException('There is nothing stored under that key.');
    }

    // Read whole rather than streamed, because the local driver is for
    // development and a test rig: the size ceiling is the upload policy's, and
    // streaming here would be machinery for a path that never carries a real
    // workload.
    const bytes = await local.readPrefix(objectKey, object.sizeBytes);

    await reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', String(bytes.byteLength))
      .send(bytes);
  }

  /**
   * The driver, when it is the one these routes belong to.
   *
   * A deployment on S3 mounts this controller and never reaches it — the
   * signed URLs point at the store. Answering anyway would be a second,
   * unsigned way into a bucket. Mounted unconditionally for the same reason:
   * a route that exists in one environment and not another is a route the
   * tests prove nothing about.
   */
  private mustBeLocal(): LocalDriver {
    if (!(this.storage instanceof LocalDriver)) {
      throw new ForbiddenException(
        'This deployment stores files in an object store; these routes do nothing here.',
      );
    }

    return this.storage;
  }

  /**
   * The whole body, bounded as it arrives.
   *
   * A `PUT` carries no policy of its own — it is the shape a server uses, and
   * an object store bounds it at the bucket rather than at the URL — so the
   * bound is the deployment's ceiling. Enforced chunk by chunk rather than
   * after the body is in memory, which is the difference between refusing an
   * oversized upload and being killed by one.
   */
  private async readWholeBody(request: FastifyRequest): Promise<Buffer> {
    const limit = this.config.get('STORAGE_MAX_UPLOAD_BYTES');
    const declared = Number(request.headers['content-length'] ?? 0);

    if (Number.isFinite(declared) && declared > limit) {
      throw new PayloadTooLargeException(TOO_LARGE);
    }

    const chunks: Buffer[] = [];
    let total = 0;

    for await (const chunk of request.raw) {
      const buffer = Buffer.from(chunk as Buffer);
      total += buffer.byteLength;

      if (total > limit) {
        throw new PayloadTooLargeException(TOO_LARGE);
      }

      chunks.push(buffer);
    }

    return Buffer.concat(chunks);
  }
}
