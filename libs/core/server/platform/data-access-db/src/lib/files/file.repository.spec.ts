import { Client } from 'pg';
import {
  POSTGRES_START_TIMEOUT_MS,
  startPostgres,
  type TestPostgres,
} from '@workspace/core-server-testing';
import type { TenantScopedContext } from '@workspace/core-server-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../prisma.service.js';
import { Database } from '../transaction/database.js';
import { FileRepository } from './file.repository.js';

const ORG = '0199a1b2-0000-7000-8000-00000000000a';
const OTHER_ORG = '0199a1b2-0000-7000-8000-00000000000b';
const USER = '0199a1b2-0000-7000-8000-0000000000aa';

const CONTEXT: TenantScopedContext = { kind: 'org', orgId: ORG, userId: USER };
const OTHER_CONTEXT: TenantScopedContext = {
  kind: 'org',
  orgId: OTHER_ORG,
  userId: USER,
};

const MAX_SCAN_ATTEMPTS = 3;

/**
 * File records, under the real grants and the real policy.
 *
 * The state machine is the feature, and the property that matters most is who
 * may move it: a request creates `PENDING` and may say "the upload finished",
 * and everything after that belongs to the worker. Half of these tests are
 * about the transitions a request is refused.
 */
describe('file records', () => {
  let postgres: TestPostgres;
  let owner: Client;
  let asApp: PrismaService;
  let asWorker: PrismaService;
  let appDb: Database;
  let workerDb: Database;
  let files: FileRepository;

  const create = (context = CONTEXT, declared = 'image/png') =>
    appDb.withTenantTransaction(context, () =>
      files.create(context.kind === 'org' ? context.orgId : ORG, {
        fileName: 'invoice.pdf',
        declaredType: declared,
        uploadedBy: USER,
      }),
    );

  const statusOf = async (id: string): Promise<string | undefined> =>
    (
      await owner.query<{ status: string }>(
        'SELECT status FROM stored_files WHERE id = $1::uuid',
        [id],
      )
    ).rows[0]?.status;

  beforeAll(async () => {
    postgres = await startPostgres();
    process.env['WORKER_DATABASE_URL'] = postgres.workerUri;

    owner = new Client({ connectionString: postgres.migrationUri });
    await owner.connect();

    asApp = new PrismaService('DATABASE_URL', 'DATABASE_POOL_MAX');
    asWorker = new PrismaService(
      'WORKER_DATABASE_URL',
      'WORKER_DATABASE_POOL_MAX',
    );
    await Promise.all([asApp.$connect(), asWorker.$connect()]);

    appDb = new Database(asApp);
    workerDb = new Database(asWorker);
    files = new FileRepository();
  }, POSTGRES_START_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.all([asApp?.$disconnect(), asWorker?.$disconnect()]);
    await owner?.end();
    await postgres?.stop();
  });

  beforeEach(async () => {
    await owner.query('DELETE FROM stored_files');
  });

  describe('creating one', () => {
    it('starts in PENDING with a key nobody chose', async () => {
      const file = await create();

      expect(file.status).toBe('PENDING');
      // Derived from the organization and a fresh uuid, never from the name:
      // two people uploading `invoice.pdf` must not collide, and a name is a
      // caller's string.
      expect(file.objectKey).toMatch(new RegExp(`^${ORG}/[0-9a-f-]{36}$`));
      expect(file.objectKey).not.toContain('invoice');
    });

    it('gives two uploads of the same name different keys', async () => {
      const [first, second] = [await create(), await create()];

      expect(first.objectKey).not.toBe(second.objectKey);
    });

    it('shows one organization nothing of another’s', async () => {
      await create();

      expect(
        await appDb.withTenantTransaction(OTHER_CONTEXT, () =>
          files.list(OTHER_ORG, 100),
        ),
      ).toEqual([]);
    });
  });

  describe('what a request may do to the state', () => {
    it('moves PENDING to UPLOADED and nothing further', async () => {
      const file = await create();

      expect(
        await appDb.withTenantTransaction(CONTEXT, () =>
          files.markUploaded(ORG, file.id),
        ),
      ).toBe(true);
      expect(await statusOf(file.id)).toBe('UPLOADED');

      // Twice is a no-op rather than a second transition: the `WHERE` names
      // the state it is leaving.
      expect(
        await appDb.withTenantTransaction(CONTEXT, () =>
          files.markUploaded(ORG, file.id),
        ),
      ).toBe(false);
    });

    it('cannot mark its own file READY', async () => {
      const file = await create();

      // The whole point of the scan is that the bytes are checked before
      // anybody may read them. A request that could write `READY` would skip
      // it — so the grant is column-level and the statement names its source
      // state, and this proves the first half.
      await expect(
        appDb.withTenantTransaction(CONTEXT, () =>
          appDb
            .tenant()
            .$executeRawUnsafe(
              `UPDATE stored_files SET detected_type = 'image/png' WHERE id = $1::uuid`,
              file.id,
            ),
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it('cannot touch another organization’s file', async () => {
      const file = await create();

      const moved = await appDb.withTenantTransaction(OTHER_CONTEXT, () =>
        files.markUploaded(OTHER_ORG, file.id),
      );

      expect(moved).toBe(false);
      expect(await statusOf(file.id)).toBe('PENDING');
    });
  });

  describe('scanning', () => {
    const uploaded = async () => {
      const file = await create();
      await appDb.withTenantTransaction(CONTEXT, () =>
        files.markUploaded(ORG, file.id),
      );
      return file;
    };

    it('claims an uploaded file and leaves a pending one alone', async () => {
      await create();
      const ready = await uploaded();

      const claimed = await workerDb.withSystemTransaction(() =>
        files.claimForScan(10),
      );

      expect(claimed.map((file) => file.id)).toEqual([ready.id]);
      expect(await statusOf(ready.id)).toBe('SCANNING');
    });

    it('lets two scanners take different files', async () => {
      await uploaded();
      await uploaded();

      const [first, second] = await Promise.all([
        workerDb.withSystemTransaction(() => files.claimForScan(1)),
        workerDb.withSystemTransaction(() => files.claimForScan(1)),
      ]);

      // `FOR UPDATE SKIP LOCKED`. Without it the second scanner waits on the
      // first's lock and then finds nothing, so two replicas do one replica's
      // work.
      const ids = [...first, ...second].map((file) => file.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('records a verdict and the type it actually found', async () => {
      const file = await uploaded();
      await workerDb.withSystemTransaction(() => files.claimForScan(10));

      const settled = await workerDb.withSystemTransaction(() =>
        files.settle(file.id, {
          status: 'READY',
          detectedType: 'image/png',
          sizeBytes: 1_234,
          reason: null,
        }),
      );

      expect(settled).toBe(true);
      expect(await statusOf(file.id)).toBe('READY');
    });

    it('refuses a verdict for a file it does not hold', async () => {
      const file = await uploaded();

      // Never claimed, so this verdict comes from a scan whose claim expired.
      // Letting it land would overwrite whatever the replica that does hold
      // the file is about to write.
      expect(
        await workerDb.withSystemTransaction(() =>
          files.settle(file.id, {
            status: 'READY',
            detectedType: 'image/png',
            sizeBytes: 1,
            reason: null,
          }),
        ),
      ).toBe(false);
    });

    it('demands a reason for a terminal state', async () => {
      const file = await uploaded();
      await workerDb.withSystemTransaction(() => files.claimForScan(10));

      // A rejection with no explanation is a support ticket nobody can answer,
      // so the constraint refuses one.
      await expect(
        workerDb.withSystemTransaction(() =>
          files.settle(file.id, {
            status: 'REJECTED',
            detectedType: 'application/pdf',
            sizeBytes: 1,
            reason: null,
          }),
        ),
      ).rejects.toThrow(/reason_when_terminal/);
    });

    it('returns a failed scan to the queue while attempts remain', async () => {
      const file = await uploaded();
      await workerDb.withSystemTransaction(() => files.claimForScan(10));

      const after = await workerDb.withSystemTransaction(() =>
        files.failScan(file.id, MAX_SCAN_ATTEMPTS, 'the scanner timed out'),
      );

      expect(after).toBe('UPLOADED');
    });

    it('quarantines a file whose scan keeps failing', async () => {
      const file = await uploaded();

      let last = '';

      for (let attempt = 0; attempt < MAX_SCAN_ATTEMPTS; attempt += 1) {
        await workerDb.withSystemTransaction(() => files.claimForScan(10));
        last = await workerDb.withSystemTransaction(() =>
          files.failScan(file.id, MAX_SCAN_ATTEMPTS, 'the scanner timed out'),
        );
      }

      // Quarantined rather than ready. The failure mode of guessing is the one
      // that matters: a file nobody could check is not one anybody should
      // download.
      expect(last).toBe('QUARANTINED');
      expect(await statusOf(file.id)).toBe('QUARANTINED');
    });
  });

  describe('sweeping what never arrived', () => {
    it('removes a PENDING record past its window', async () => {
      const file = await create();
      await owner.query(
        `UPDATE stored_files SET created_at = now() - interval '2 hours' WHERE id = $1::uuid`,
        [file.id],
      );

      const swept = await workerDb.withSystemTransaction(() =>
        files.sweepAbandoned(60, 100),
      );

      // The key comes back so the caller can delete the object too — an object
      // whose record is gone is rubbish nothing else would ever find.
      expect(swept.map((row) => row.id)).toEqual([file.id]);
      expect(swept[0]?.objectKey).toBe(file.objectKey);
    });

    it('leaves a recent PENDING record alone', async () => {
      await create();

      // A signed URL is good for fifteen minutes, so a young record is an
      // upload still in flight rather than one that never happened.
      expect(
        await workerDb.withSystemTransaction(() => files.sweepAbandoned(60, 100)),
      ).toEqual([]);
    });

    it('never sweeps a file that is ready', async () => {
      const file = await create();
      await owner.query(
        `UPDATE stored_files SET status = 'READY',
                created_at = now() - interval '2 years' WHERE id = $1::uuid`,
        [file.id],
      );

      expect(
        await workerDb.withSystemTransaction(() => files.sweepAbandoned(60, 100)),
      ).toEqual([]);
    });
  });

  describe('who may touch what', () => {
    it('gives each role exactly the rights it needs', async () => {
      const rows = await asWorker.$queryRawUnsafe<
        { role: string; privs: string | null }[]
      >(`
        WITH r(role) AS (VALUES ('app_user'),('worker_user'),('cross_tenant_admin_role')),
             p(priv) AS (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'))
        SELECT role, string_agg(priv, ',' ORDER BY priv)
                 FILTER (WHERE has_table_privilege(role, 'stored_files', priv)) AS privs
          FROM r, p GROUP BY role ORDER BY role`);

      expect(
        Object.fromEntries(rows.map((row) => [row.role, row.privs])),
      ).toEqual({
        // No table-level UPDATE for app_user: it holds `status` and
        // `uploaded_at` only, which is what stops a request writing READY.
        app_user: 'DELETE,INSERT,SELECT',
        worker_user: 'DELETE,SELECT,UPDATE',
        cross_tenant_admin_role: null,
      });
    });

    it('lets a request write the status column and no other', async () => {
      const rows = await asWorker.$queryRawUnsafe<
        { col: string; allowed: boolean }[]
      >(`
        SELECT col, has_column_privilege('app_user', 'stored_files', col, 'UPDATE') AS allowed
          FROM (VALUES ('status'),('uploaded_at'),('detected_type'),('reason'),('org_id'))
               AS c(col)`);

      expect(Object.fromEntries(rows.map((row) => [row.col, row.allowed]))).toEqual(
        {
          status: true,
          uploaded_at: true,
          // The three that would let a request declare its own file safe, or
          // move it into somebody else's organization.
          detected_type: false,
          reason: false,
          org_id: false,
        },
      );
    });
  });
});
