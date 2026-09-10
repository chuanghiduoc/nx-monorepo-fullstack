import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { WorkerConfig } from '@workspace/core-server-core';
import {
  Database,
  FileRepository,
  type FileRecord,
  type FileStatus,
  type ScanVerdict,
} from '@workspace/core-server-data-access-db';
import type { JobDefinition } from '@workspace/core-server-queue';
import { RealtimeBus } from '@workspace/core-server-realtime';
import {
  SNIFF_BYTES,
  STORAGE_DRIVER,
  verifyContentType,
  type StorageDriver,
} from '@workspace/core-server-storage';

/** How many files one run claims. */
const SCAN_BATCH = 20;

/** How many objects one cleanup pass removes. */
const CLEANUP_BATCH = 100;

const MINUTE_MS = 60 * 1_000;

/**
 * The recurring scan has no payload: what to look at is decided by the rows.
 */
export const fileScan: JobDefinition<Record<string, never>> = {
  queue: 'files',
  name: 'scan',
  payload: z.object({}).strict(),
};

/**
 * Decides what an uploaded file actually is, and cleans up what never arrived.
 *
 * **The worker owns every state past `PENDING`.** The API creates a record and
 * accepts "the upload finished"; the checks that decide `READY` or `REJECTED`
 * read the object, and a request that read a fifty-megabyte upload to sniff
 * its type would hold a connection for as long as that took.
 *
 * The scan is a schedule rather than a queue message, and that is deliberate:
 * an upload completes when a *store* accepts it, and nothing on our side is
 * notified. Polling `UPLOADED` is how the work is found at all — a signed PUT
 * goes straight to S3 and never touches this process.
 */
@Injectable()
export class FileScanner {
  private readonly logger = new Logger(FileScanner.name);
  private readonly db: Database;
  private readonly files: FileRepository;
  private readonly storage: StorageDriver;
  private readonly config: WorkerConfig;
  private readonly realtime: RealtimeBus;

  constructor(
    @Inject(Database) db: Database,
    @Inject(FileRepository) files: FileRepository,
    @Inject(STORAGE_DRIVER) storage: StorageDriver,
    @Inject(WorkerConfig) config: WorkerConfig,
    @Inject(RealtimeBus) realtime: RealtimeBus,
  ) {
    this.db = db;
    this.files = files;
    this.storage = storage;
    this.config = config;
    this.realtime = realtime;
  }

  /** How often this runs, and therefore part of the schedule's identity. */
  get intervalMs(): number {
    return this.config.get('FILE_SCAN_INTERVAL_MINUTES') * MINUTE_MS;
  }

  async run(): Promise<{ scanned: number; swept: number }> {
    const claimed = await this.db.withSystemTransaction(() =>
      this.files.claimForScan(SCAN_BATCH),
    );

    let scanned = 0;

    for (const file of claimed) {
      // One at a time and each in its own transaction: a scan that throws must
      // not undo the verdicts already recorded, and each verdict is
      // independently meaningful.
      await this.scan(file);
      scanned += 1;
    }

    return { scanned, swept: await this.sweep() };
  }

  /**
   * Reads the first bytes and decides.
   *
   * The size comes from the store rather than from whoever uploaded it, and
   * the type comes from the bytes rather than from what was declared. Both are
   * the same rule: a caller's claim about its own upload is a caller's claim.
   */
  private async scan(file: FileRecord): Promise<void> {
    try {
      const object = await this.storage.head(file.objectKey);

      if (object === undefined) {
        // The record says the upload finished and the store disagrees. Not a
        // transient failure — retrying will find the same nothing — so it goes
        // straight to the attempt ceiling's destination.
        await this.settle(file, {
          status: 'REJECTED',
          detectedType: null,
          sizeBytes: 0,
          reason: 'The upload was reported as finished and no object exists.',
        });
        return;
      }

      const maxBytes = this.config.get('STORAGE_MAX_UPLOAD_BYTES');

      if (object.sizeBytes > maxBytes) {
        // A presigned POST policy would have refused this at the edge. A
        // presigned PUT cannot, which is why the check exists here as well.
        await this.settle(file, {
          status: 'REJECTED',
          detectedType: null,
          sizeBytes: object.sizeBytes,
          reason: `The upload is ${String(object.sizeBytes)} bytes, and the limit is ${String(maxBytes)}.`,
        });
        return;
      }

      const prefix = await this.storage.readPrefix(file.objectKey, SNIFF_BYTES);
      const verdict = await verifyContentType(prefix, file.declaredType);

      await this.settle(file, {
        status: verdict.matches ? 'READY' : 'REJECTED',
        detectedType: verdict.detected ?? null,
        sizeBytes: object.sizeBytes,
        reason: verdict.matches ? null : (verdict.reason ?? 'The bytes were refused.'),
      });

      if (!verdict.matches) {
        this.logger.warn(
          `Rejected ${file.fileName} (${file.id}): ${verdict.reason ?? 'no reason given'}`,
        );
      }
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure);

      const after = await this.db.withSystemTransaction(() =>
        this.files.failScan(
          file.id,
          this.config.get('FILE_SCAN_MAX_ATTEMPTS'),
          `The scan failed repeatedly; the last reason was: ${reason}`,
        ),
      );

      this.logger.error(
        `Scanning ${file.id} failed (${reason}); it is now ${after}.`,
      );

      if (after === 'QUARANTINED') {
        // Terminal, so somebody is waiting on an answer that will never
        // improve. `REJECTED` and `QUARANTINED` are different names because
        // "we looked and it is wrong" and "we could not look" are different
        // facts, and a client showing them the same way is a client that tells
        // people to re-upload a file that is fine.
        await this.announce(file, 'QUARANTINED', {
          detectedType: null,
          sizeBytes: file.sizeBytes,
          reason:
            'The scan failed repeatedly, so nothing here has read the file.',
        });
      }
    }
  }

  /**
   * Records the verdict, then says so.
   *
   * **After the transaction, never inside it.** A message announcing a verdict
   * that then rolled back is a lie the browser cannot detect, and there is no
   * second message that takes it back. The cost of this order is the opposite
   * failure — a committed verdict nobody was told about — and that one the
   * client recovers from by re-reading, which realtime never promises to
   * replace.
   */
  private async settle(file: FileRecord, verdict: ScanVerdict): Promise<void> {
    await this.db.withSystemTransaction(() =>
      this.files.settle(file.id, verdict),
    );

    await this.announce(file, verdict.status, verdict);
  }

  /**
   * Tells whoever is watching that organization's stream.
   *
   * Best effort by construction, and swallowed on failure for the same reason:
   * the verdict is already recorded, and a Redis that is unreachable must not
   * turn a successful scan into a retried one — the retry would re-read the
   * object and reach the same conclusion, and the record cannot move twice.
   */
  private async announce(
    file: FileRecord,
    status: FileStatus,
    detail: {
      detectedType: string | null;
      sizeBytes: number | null;
      reason: string | null;
    },
  ): Promise<void> {
    try {
      await this.realtime.publish(
        { kind: 'org', orgId: file.orgId },
        `file.${status.toLowerCase()}`,
        {
          id: file.id,
          fileName: file.fileName,
          status,
          detectedType: detail.detectedType,
          sizeBytes: detail.sizeBytes,
          reason: detail.reason,
        },
      );
    } catch (failure) {
      this.logger.warn(
        `Scanned ${file.id} and could not announce it: ${
          failure instanceof Error ? failure.message : String(failure)
        }`,
      );
    }
  }

  /**
   * Removes uploads that never happened, record first and object second.
   *
   * The order is what makes it safe to run twice: after the record is gone the
   * object is rubbish nothing claims, and deleting rubbish twice is deleting
   * it once. The reverse order would leave a record pointing at nothing.
   *
   * It only ever touches `PENDING` rows past a window — never `READY`, and
   * never one younger than a signed URL's lifetime, which is an upload still
   * in flight rather than one that never happened.
   */
  private async sweep(): Promise<number> {
    const abandoned = await this.db.withSystemTransaction(() =>
      this.files.sweepAbandoned(
        this.config.get('STORAGE_ABANDONED_UPLOAD_MINUTES'),
        CLEANUP_BATCH,
      ),
    );

    for (const file of abandoned) {
      try {
        await this.storage.remove(file.objectKey);
      } catch (failure) {
        // The record is already gone, so the object is unreachable rubbish
        // rather than a file somebody can still see. Worth a line; not worth
        // failing the run and re-sweeping everything else.
        const reason =
          failure instanceof Error ? failure.message : String(failure);
        this.logger.warn(
          `Could not remove the object for abandoned upload ${file.id}: ${reason}`,
        );
      }
    }

    if (abandoned.length > 0) {
      this.logger.log(
        `Removed ${abandoned.length} upload(s) that were never completed.`,
      );
    }

    return abandoned.length;
  }
}
