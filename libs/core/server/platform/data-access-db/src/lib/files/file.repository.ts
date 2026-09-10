import { Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client.js';
import { activeTransaction } from '../transaction/transaction-context.js';

/** Every state a file record can be in. */
export const FILE_STATUSES = [
  'PENDING',
  'UPLOADED',
  'SCANNING',
  'READY',
  'REJECTED',
  'QUARANTINED',
] as const;

export type FileStatus = (typeof FILE_STATUSES)[number];

export interface FileRecord {
  readonly id: string;
  readonly orgId: string;
  readonly objectKey: string;
  readonly fileName: string;
  readonly declaredType: string;
  readonly detectedType: string | null;
  readonly sizeBytes: number | null;
  readonly status: FileStatus;
  readonly reason: string | null;
  readonly createdAt: Date;
}

export interface CreateFile {
  readonly fileName: string;
  readonly declaredType: string;
  readonly uploadedBy?: string;
}

/** What the scan concluded, and where the record goes next. */
export interface ScanVerdict {
  readonly status: Extract<FileStatus, 'READY' | 'REJECTED' | 'QUARANTINED'>;
  readonly detectedType: string | null;
  readonly sizeBytes: number;
  readonly reason: string | null;
}

/**
 * File records, and the state machine over them.
 *
 * **The object key is derived from the id**, never from the name. Two people
 * uploading `invoice.pdf` must not collide, a name is a caller's string, and
 * the cleanup decides what to delete by asking whether an object has a record —
 * which only works if the key says which record.
 *
 * Raw SQL for the same reason the rest of this library uses it: `app_user`
 * holds a column-level `UPDATE` on `status` and `uploaded_at` alone, so a
 * Prisma `update()` — which writes every field it was given and returns every
 * column — fails on the grant. That grant is what makes "only the worker moves
 * the state" true rather than a convention.
 */
@Injectable()
export class FileRepository {
  /**
   * Creates a record in `PENDING` and returns it with its key.
   *
   * The record comes first, always. An object with no record is rubbish the
   * cleanup removes; a record with no object is an upload that never happened,
   * and the sweep removes that too. Creating the object first would leave a
   * window where neither is true.
   */
  async create(orgId: string, input: CreateFile): Promise<FileRecord> {
    const rows = await this.client().$queryRaw<RawFile[]>`
      INSERT INTO "stored_files"
        (org_id, object_key, file_name, declared_type, uploaded_by)
      VALUES (
        ${orgId}::uuid,
        -- Derived from the id the row is about to get, which is why it is
        -- computed here rather than passed in: the key and the record cannot
        -- disagree if neither exists before the other.
        ${orgId}::text || '/' || gen_random_uuid()::text,
        ${input.fileName}, ${input.declaredType},
        ${input.uploadedBy ?? null}::uuid)
      RETURNING id, org_id, object_key, file_name, declared_type, detected_type,
                size_bytes, status, reason, created_at`;

    const row = rows[0];

    if (row === undefined) {
      throw new Error(
        'The file record was not created: the transaction’s organization does not match.',
      );
    }

    return toRecord(row);
  }

  /** This organization's files, newest first. */
  async list(orgId: string, limit: number): Promise<FileRecord[]> {
    const rows = await this.client().$queryRaw<RawFile[]>`
      SELECT id, org_id, object_key, file_name, declared_type, detected_type,
             size_bytes, status, reason, created_at
        FROM "stored_files"
       WHERE org_id = ${orgId}::uuid
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit}`;

    return rows.map(toRecord);
  }

  async byId(orgId: string, id: string): Promise<FileRecord | undefined> {
    const rows = await this.client().$queryRaw<RawFile[]>`
      SELECT id, org_id, object_key, file_name, declared_type, detected_type,
             size_bytes, status, reason, created_at
        FROM "stored_files"
       WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid`;

    const row = rows[0];

    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * The one transition a request may make: "the upload finished".
   *
   * `PENDING → UPLOADED` and nothing else. The `WHERE` is what bounds it — a
   * caller cannot mark its own file `READY` and skip the check that is the
   * entire point of the scan — and the column-level grant is what stops the
   * statement being replaced by one that could.
   */
  async markUploaded(orgId: string, id: string): Promise<boolean> {
    const moved = await this.client().$executeRaw`
      UPDATE "stored_files"
         SET status = 'UPLOADED', uploaded_at = now(), updated_at = now()
       WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid AND status = 'PENDING'`;

    return moved > 0;
  }

  async remove(orgId: string, id: string): Promise<FileRecord | undefined> {
    const rows = await this.client().$queryRaw<RawFile[]>`
      DELETE FROM "stored_files"
       WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid
      RETURNING id, org_id, object_key, file_name, declared_type, detected_type,
                size_bytes, status, reason, created_at`;

    const row = rows[0];

    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * Claims one uploaded file for scanning.
   *
   * `FOR UPDATE SKIP LOCKED`, so replicas take different files rather than
   * contending for the same one and two of three finding nothing.
   */
  async claimForScan(limit: number): Promise<FileRecord[]> {
    const rows = await this.client().$queryRaw<RawFile[]>`
      WITH claimed AS MATERIALIZED (
        SELECT id FROM "stored_files"
         WHERE status = 'UPLOADED'
         ORDER BY created_at
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED)
      UPDATE "stored_files"
         SET status = 'SCANNING', scan_attempts = scan_attempts + 1,
             updated_at = now()
       WHERE id IN (SELECT id FROM claimed)
      RETURNING id, org_id, object_key, file_name, declared_type, detected_type,
                size_bytes, status, reason, created_at`;

    return rows.map(toRecord);
  }

  /**
   * Records what the scan decided.
   *
   * Only from `SCANNING`, so a verdict from a scan whose claim expired cannot
   * overwrite one another replica already recorded.
   */
  async settle(id: string, verdict: ScanVerdict): Promise<boolean> {
    const settled = await this.client().$executeRaw`
      UPDATE "stored_files"
         SET status = ${verdict.status},
             detected_type = ${verdict.detectedType},
             size_bytes = ${verdict.sizeBytes}::bigint,
             reason = ${verdict.reason},
             updated_at = now()
       WHERE id = ${id}::uuid AND status = 'SCANNING'`;

    return settled > 0;
  }

  /**
   * Returns a scan that failed to the queue, or gives up on it.
   *
   * A scan that keeps timing out ends `QUARANTINED` rather than `READY`: the
   * failure mode of guessing is the one that matters, and a file nobody could
   * check is not a file anybody should download.
   */
  async failScan(
    id: string,
    maxAttempts: number,
    reason: string,
  ): Promise<FileStatus> {
    const rows = await this.client().$queryRaw<{ status: FileStatus }[]>`
      UPDATE "stored_files"
         SET status = CASE WHEN scan_attempts >= ${maxAttempts}
                           THEN 'QUARANTINED' ELSE 'UPLOADED' END,
             reason = CASE WHEN scan_attempts >= ${maxAttempts}
                           THEN ${reason} ELSE NULL END,
             updated_at = now()
       WHERE id = ${id}::uuid AND status = 'SCANNING'
      RETURNING status`;

    return rows[0]?.status ?? 'SCANNING';
  }

  /**
   * Removes abandoned uploads — `PENDING` past a window, never `READY`.
   *
   * The window matters: a signed URL is good for fifteen minutes, so a record
   * younger than that is an upload still in flight rather than one that never
   * happened.
   */
  async sweepAbandoned(
    olderThanMinutes: number,
    limit: number,
  ): Promise<FileRecord[]> {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1_000);

    const rows = await this.client().$queryRaw<RawFile[]>`
      WITH stale AS MATERIALIZED (
        SELECT id FROM "stored_files"
         WHERE status = 'PENDING' AND created_at < ${cutoff}
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED)
      DELETE FROM "stored_files"
       WHERE id IN (SELECT id FROM stale) AND status = 'PENDING'
      RETURNING id, org_id, object_key, file_name, declared_type, detected_type,
                size_bytes, status, reason, created_at`;

    return rows.map(toRecord);
  }

  private client(): Prisma.TransactionClient {
    const active = activeTransaction();

    if (!active) {
      throw new Error(
        'A file record is read or written inside a transaction — a tenant one for a request, ' +
          'a system one for the scanner. Wrap the call in withTenantTransaction(context, ...) ' +
          'or withSystemTransaction(...).',
      );
    }

    return active.client;
  }
}

interface RawFile {
  id: string;
  org_id: string;
  object_key: string;
  file_name: string;
  declared_type: string;
  detected_type: string | null;
  size_bytes: bigint | null;
  status: FileStatus;
  reason: string | null;
  created_at: Date;
}

/** `bigint` at the boundary, `number` inside, and loud when that is a lie. */
function toRecord(row: RawFile): FileRecord {
  const sizeBytes = row.size_bytes === null ? null : Number(row.size_bytes);

  if (sizeBytes !== null && !Number.isSafeInteger(sizeBytes)) {
    throw new Error(
      `File ${row.id} reports ${String(row.size_bytes)} bytes, which JavaScript cannot ` +
        'represent exactly. The column is bigint deliberately.',
    );
  }

  return {
    id: row.id,
    orgId: row.org_id,
    objectKey: row.object_key,
    fileName: row.file_name,
    declaredType: row.declared_type,
    detectedType: row.detected_type,
    sizeBytes,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
  };
}
