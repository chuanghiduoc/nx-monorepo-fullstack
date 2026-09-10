import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthzService, type Principal } from '@workspace/core-server-authz';
import { AppConfig } from '@workspace/core-server-core';
import {
  Database,
  FileRepository,
  type FileRecord,
} from '@workspace/core-server-data-access-db';
import {
  STORAGE_DRIVER,
  type CompletedPart,
  type StorageDriver,
} from '@workspace/core-server-storage';

export type UploadShape = 'put' | 'post' | 'multipart';

export interface UploadTicket {
  readonly file: FileRecord;
  readonly shape: UploadShape;
  readonly url?: string;
  readonly fields?: Record<string, string>;
  readonly uploadId?: string;
  readonly parts?: { partNumber: number; url: string }[];
  readonly expiresAt: Date;
}

/** How many files one page of the listing returns. */
const LIST_LIMIT = 100;

/**
 * Uploading and downloading, from the request's side.
 *
 * **This service never decides that a file is safe.** It creates a record in
 * `PENDING`, hands back somewhere to put the bytes, and accepts "the upload
 * finished". Everything after that is the worker's, because the checks read
 * the object and a request that read a fifty-megabyte upload would hold a
 * connection for as long as that took.
 *
 * The grant enforces it rather than this code: `app_user` may write `status`
 * and `uploaded_at` and no other column, so no route here — and no injection
 * through one — can mark a file `READY`.
 */
@Injectable()
export class FilesService {
  private readonly db: Database;
  private readonly files: FileRepository;
  private readonly storage: StorageDriver;
  private readonly authz: AuthzService;
  private readonly config: AppConfig;

  constructor(
    @Inject(Database) db: Database,
    @Inject(FileRepository) files: FileRepository,
    @Inject(STORAGE_DRIVER) storage: StorageDriver,
    @Inject(AuthzService) authz: AuthzService,
    @Inject(AppConfig) config: AppConfig,
  ) {
    this.db = db;
    this.files = files;
    this.storage = storage;
    this.authz = authz;
    this.config = config;
  }

  /**
   * Creates the record, then signs somewhere to put the bytes.
   *
   * The record comes first, always. An object with no record is rubbish the
   * cleanup removes; creating the object first would leave a window in which
   * neither is true and nothing could tell.
   */
  async requestUpload(
    principal: Principal,
    orgId: string,
    input: {
      fileName: string;
      contentType: string;
      shape: UploadShape;
      partCount?: number;
    },
  ): Promise<UploadTicket> {
    this.authz.require(principal, 'file.create', { orgId });

    const file = await this.db.withRequestTransaction(() =>
      this.files.create(orgId, {
        fileName: input.fileName,
        declaredType: input.contentType,
        uploadedBy: principal.type === 'system' ? undefined : principal.id,
      }),
    );

    const maxBytes = this.config.get('STORAGE_MAX_UPLOAD_BYTES');

    if (input.shape === 'post') {
      const signed = await this.storage.signPost(
        file.objectKey,
        input.contentType,
        maxBytes,
      );

      return {
        file,
        shape: 'post',
        url: signed.url,
        fields: signed.fields,
        expiresAt: signed.expiresAt,
      };
    }

    if (input.shape === 'multipart') {
      if (input.partCount === undefined) {
        throw new BadRequestException('A multipart upload needs partCount.');
      }

      const upload = await this.storage.beginMultipart(
        file.objectKey,
        input.contentType,
        input.partCount,
      );

      return {
        file,
        shape: 'multipart',
        uploadId: upload.uploadId,
        parts: upload.parts.map((part) => ({ ...part })),
        // Every part URL was signed with the same lifetime, so one expiry
        // describes them all.
        expiresAt: new Date(
          Date.now() +
            this.config.get('STORAGE_SIGNED_URL_TTL_SECONDS') * 1_000,
        ),
      };
    }

    const signed = await this.storage.signPut(file.objectKey, input.contentType);

    return {
      file,
      shape: 'put',
      url: signed.url,
      expiresAt: signed.expiresAt,
    };
  }

  /**
   * Accepts "the upload finished", and checks that it did.
   *
   * The store is asked rather than believed: a caller that says it uploaded
   * something and did not would otherwise leave a record the scanner picks up
   * and rejects a minute later, which is a worse message and a slower one.
   */
  async completeUpload(
    principal: Principal,
    orgId: string,
    id: string,
    multipart?: { uploadId: string; parts: readonly CompletedPart[] },
  ): Promise<FileRecord> {
    this.authz.require(principal, 'file.create', { orgId, resourceId: id });

    const file = await this.mustFind(orgId, id);

    if (file.status !== 'PENDING') {
      throw new ConflictException(
        `That upload is already ${file.status.toLowerCase()}.`,
      );
    }

    if (multipart !== undefined) {
      // A multipart upload is only an object once it has been assembled, and
      // the caller is the only one that knows the etags. The upload id comes
      // back from the caller for the same reason: it belongs to an upload in
      // progress, and a column holding one would outlive the upload.
      await this.storage.completeMultipart(
        file.objectKey,
        multipart.uploadId,
        multipart.parts,
      );
    }

    const object = await this.storage.head(file.objectKey);

    if (object === undefined) {
      throw new BadRequestException(
        'No object was uploaded for that ticket, so there is nothing to complete.',
      );
    }

    await this.db.withRequestTransaction(() =>
      this.files.markUploaded(orgId, id),
    );

    return { ...file, status: 'UPLOADED' };
  }

  async list(principal: Principal, orgId: string): Promise<FileRecord[]> {
    this.authz.require(principal, 'file.read', { orgId });

    return this.db.withRequestTransaction(() =>
      this.files.list(orgId, LIST_LIMIT),
    );
  }

  /**
   * A URL to read the object, but only for a file that has been checked.
   *
   * `READY` and nothing else. A `PENDING` file has not been scanned, a
   * `REJECTED` one is not what it claimed, and a `QUARANTINED` one could not
   * be checked at all — handing out any of them would make the scan
   * decorative.
   */
  async download(
    principal: Principal,
    orgId: string,
    id: string,
  ): Promise<{ url: string; expiresAt: Date }> {
    this.authz.require(principal, 'file.read', { orgId, resourceId: id });

    const file = await this.mustFind(orgId, id);

    if (file.status !== 'READY') {
      throw new ConflictException(
        file.reason ??
          `That file is ${file.status.toLowerCase()} and cannot be downloaded yet.`,
      );
    }

    const signed = await this.storage.signGet(file.objectKey);

    return { url: signed.url, expiresAt: signed.expiresAt };
  }

  /**
   * Removes a file, record first and object second.
   *
   * The order is what makes a failure recoverable: after the record is gone
   * the object is rubbish the cleanup removes, and a half-done delete leaves
   * nothing a caller can still see. The reverse would leave a record pointing
   * at nothing.
   */
  async remove(
    principal: Principal,
    orgId: string,
    id: string,
  ): Promise<void> {
    this.authz.require(principal, 'file.delete', { orgId, resourceId: id });

    const removed = await this.db.withRequestTransaction(() =>
      this.files.remove(orgId, id),
    );

    if (removed === undefined) {
      throw new NotFoundException('No such file');
    }

    await this.storage.remove(removed.objectKey);
  }

  private async mustFind(orgId: string, id: string): Promise<FileRecord> {
    const file = await this.db.withRequestTransaction(() =>
      this.files.byId(orgId, id),
    );

    if (file === undefined) {
      // Not a 403: telling a caller the id exists is telling them something
      // about another organization.
      throw new NotFoundException('No such file');
    }

    return file;
  }

}
