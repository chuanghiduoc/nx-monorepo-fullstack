import { Client } from 'pg';
import {
  POSTGRES_START_TIMEOUT_MS,
  startPostgres,
  type TestPostgres,
} from '@workspace/core-server-testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../prisma.service.js';
import { Database } from '../transaction/database.js';
import { ErasureRepository } from './erasure.repository.js';

const USER = '0199a1b2-0000-7000-8000-0000000000aa';
const OTHER_USER = '0199a1b2-0000-7000-8000-0000000000ab';
const ORG = '0199a1b2-0000-7000-8000-00000000000a';

/** The window every test here reads and erases under. */
const GRACE_DAYS = 30;

/**
 * Erasing a person, under the role that is allowed to and the ones that are
 * not.
 *
 * The whole design rests on one property: `erasure_role` is the only role that
 * may delete an identity row or edit an audit record. If `worker_user` could,
 * then every consumer of the outbox could, and the trail's immutability would
 * be a convention rather than a permission — so the tests that matter most
 * here are the ones that run as the wrong role and are refused.
 */
describe('erasing a person', () => {
  let postgres: TestPostgres;
  let owner: Client;
  let asErasure: PrismaService;
  let erasureDb: Database;
  let asWorker: PrismaService;
  let erasure: ErasureRepository;

  const seedUser = async (id: string, deletedDaysAgo?: number) => {
    await owner.query(
      `INSERT INTO "user" (id, name, email, created_at, updated_at, deleted_at)
       VALUES ($1::uuid, 'A Person', $2, now(), now(),
               CASE WHEN $3::int IS NULL THEN NULL
                    ELSE now() - make_interval(days => $3::int) END)`,
      [id, `${id}@example.test`, deletedDaysAgo ?? null],
    );
  };

  const seedAudit = async (actorId: string | null) => {
    await owner.query(
      `INSERT INTO audit_records
         (event_id, event_type, aggregate_type, aggregate_id, tenant_id,
          actor_id, occurred_at, detail)
       VALUES (gen_random_uuid(), 'note.created', 'note', gen_random_uuid(),
               $1::uuid, $2::uuid, now(),
               '{"noteId":"x","titleLength":5}'::jsonb)`,
      [ORG, actorId],
    );
  };

  const auditRows = async () =>
    (
      await owner.query<{ actor_id: string | null; detail: Record<string, unknown> }>(
        'SELECT actor_id, detail FROM audit_records ORDER BY recorded_at',
      )
    ).rows;

  const userCount = async () =>
    Number(
      (await owner.query<{ n: string }>('SELECT count(*) AS n FROM "user"'))
        .rows[0]?.n ?? 0,
    );

  beforeAll(async () => {
    postgres = await startPostgres();
    process.env['ERASURE_DATABASE_URL'] = postgres.erasureUri;
    process.env['WORKER_DATABASE_URL'] = postgres.workerUri;

    owner = new Client({ connectionString: postgres.migrationUri });
    await owner.connect();

    asErasure = new PrismaService(
      'ERASURE_DATABASE_URL',
      'ERASURE_DATABASE_POOL_MAX',
    );
    asWorker = new PrismaService(
      'WORKER_DATABASE_URL',
      'WORKER_DATABASE_POOL_MAX',
    );
    await Promise.all([asErasure.$connect(), asWorker.$connect()]);

    erasureDb = new Database(asErasure);
    erasure = new ErasureRepository();
  }, POSTGRES_START_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.all([asErasure?.$disconnect(), asWorker?.$disconnect()]);
    await owner?.end();
    await postgres?.stop();
  });

  beforeEach(async () => {
    await owner.query('DELETE FROM audit_records');
    await owner.query('DELETE FROM "user"');
  });

  describe('the grace window', () => {
    it('leaves somebody who asked yesterday alone', async () => {
      await seedUser(USER, 1);

      expect(
        await erasureDb.withSystemTransaction(() =>
          erasure.dueForErasure(30, 100),
        ),
      ).toEqual([]);
    });

    it('takes somebody whose window has passed', async () => {
      await seedUser(USER, 31);

      expect(
        await erasureDb.withSystemTransaction(() =>
          erasure.dueForErasure(30, 100),
        ),
      ).toEqual([USER]);
    });

    it('never takes somebody who did not ask', async () => {
      await seedUser(USER);

      // `deleted_at IS NULL` is every ordinary account. An erasure that read
      // this predicate the other way round would delete the entire user table.
      expect(
        await erasureDb.withSystemTransaction(() =>
          erasure.dueForErasure(0, 100),
        ),
      ).toEqual([]);
    });

    it('takes no more than the batch it was asked for', async () => {
      await seedUser(USER, 31);
      await seedUser(OTHER_USER, 31);

      expect(
        await erasureDb.withSystemTransaction(() =>
          erasure.dueForErasure(30, 1),
        ),
      ).toHaveLength(1);
    });
  });

  describe('what erasing does', () => {
    it('removes the person and their sessions with them', async () => {
      await seedUser(USER, 31);
      await owner.query(
        `INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id)
         VALUES (gen_random_uuid(), now() + interval '1 day', 'tok', now(), now(), $1::uuid)`,
        [USER],
      );

      await erasureDb.withSystemTransaction(() => erasure.erase(USER, GRACE_DAYS));

      expect(await userCount()).toBe(0);
      // `ON DELETE CASCADE`, and a cascade runs with the deleting statement's
      // rights rather than needing a grant of its own.
      const sessions = await owner.query('SELECT 1 FROM session');
      expect(sessions.rowCount).toBe(0);
    });

    it('keeps the audit record and takes the person out of it', async () => {
      await seedUser(USER, 31);
      await seedAudit(USER);

      const outcome = await erasureDb.withSystemTransaction(() =>
        erasure.erase(USER, GRACE_DAYS),
      );

      const [row] = await auditRows();

      // A trail with holes in it is not a trail; a trail naming somebody who
      // exercised their right to be forgotten is not lawful. Keeping the row
      // and removing the person is the shape that satisfies both.
      expect(outcome.auditRecordsAnonymised).toBe(1);
      expect(row?.actor_id).toBeNull();
      expect(row?.detail).toEqual({
        erased: true,
        erasedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as unknown,
      });
    });

    it('leaves somebody else’s audit records untouched', async () => {
      await seedUser(USER, 31);
      await seedUser(OTHER_USER);
      await seedAudit(USER);
      await seedAudit(OTHER_USER);

      await erasureDb.withSystemTransaction(() => erasure.erase(USER, GRACE_DAYS));

      const rows = await auditRows();
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.actor_id === OTHER_USER)).toHaveLength(1);
    });

    it('anonymises and deletes together, or neither', async () => {
      await seedUser(USER, 31);
      await seedAudit(USER);

      await expect(
        erasureDb.withSystemTransaction(async () => {
          await erasure.erase(USER, GRACE_DAYS);
          throw new Error('something after the erasure failed');
        }),
      ).rejects.toThrow('something after the erasure failed');

      // The two halves are one transaction on one connection, which is the
      // correction this design is built around: split across two roles they
      // would be two transactions, and a crash between them leaves a deleted
      // user whose audit rows still name them — unrecoverably, because the
      // list of ids is gone with the user.
      expect(await userCount()).toBe(1);
      expect((await auditRows())[0]?.actor_id).toBe(USER);
    });

    it('refuses to erase somebody who is already gone', async () => {
      await expect(
        erasureDb.withSystemTransaction(() => erasure.erase(USER, GRACE_DAYS)),
      ).rejects.toThrow(/before this erasure/);
    });

    it('refuses to erase somebody who cancelled after the batch was read', async () => {
      await seedUser(USER, 31);
      await seedAudit(USER);

      // The sweep reads the batch in one transaction and erases each person in
      // another, so this is not a contrived interleaving — it is the ordinary
      // gap, and the cancellation route is one anybody can call for
      // themselves.
      expect(
        await erasureDb.withSystemTransaction(() =>
          erasure.dueForErasure(GRACE_DAYS, 100),
        ),
      ).toEqual([USER]);

      await owner.query(
        `UPDATE "user" SET deleted_at = NULL WHERE id = $1::uuid`,
        [USER],
      );

      // Deleting by id alone honoured the stale list: the account went, the
      // cancellation had already reported success, and nothing can be undone.
      await expect(
        erasureDb.withSystemTransaction(() => erasure.erase(USER, GRACE_DAYS)),
      ).rejects.toThrow(/no longer due for erasure/);

      expect(await userCount()).toBe(1);
      // And the anonymisation rolled back with it, so the trail still names
      // somebody who is still here.
      expect((await auditRows())[0]?.actor_id).toBe(USER);
    });

    it('refuses to erase somebody whose window has not passed', async () => {
      await seedUser(USER, 1);

      await expect(
        erasureDb.withSystemTransaction(() => erasure.erase(USER, GRACE_DAYS)),
      ).rejects.toThrow(/no longer due for erasure/);

      expect(await userCount()).toBe(1);
    });

    it('refuses to erase somebody who never asked', async () => {
      await seedUser(USER);

      // The read has always refused this. So does the write now, which is what
      // stops a caller that passes an id from somewhere else — a fixture, a
      // console, a future admin route — from deleting an ordinary account.
      await expect(
        erasureDb.withSystemTransaction(() => erasure.erase(USER, GRACE_DAYS)),
      ).rejects.toThrow(/no longer due for erasure/);

      expect(await userCount()).toBe(1);
    });
  });

  describe('what the other roles may not do', () => {
    it('does not let the worker edit an audit record', async () => {
      await seedAudit(USER);

      // The property the whole design rests on. `worker_user` writes the trail
      // and reads it; if it could update it, every consumer of the outbox
      // could, and immutability would be a convention.
      await expect(
        asWorker.$executeRawUnsafe(
          'UPDATE audit_records SET actor_id = NULL',
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it('does not let the worker delete a person', async () => {
      await seedUser(USER, 31);

      await expect(
        asWorker.$executeRawUnsafe('DELETE FROM "user"'),
      ).rejects.toThrow(/permission denied/i);
    });

    it('does not let the erasure role rewrite the rest of a record', async () => {
      await seedAudit(USER);

      // Column-level, and this is what that buys: it may remove the person and
      // nothing else. Rewriting `event_type` would let an erasure quietly
      // change what the trail says happened.
      await expect(
        asErasure.$executeRawUnsafe(
          `UPDATE audit_records SET event_type = 'something.else'`,
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it('does not let the erasure role delete an audit record', async () => {
      await seedAudit(USER);

      await expect(
        asErasure.$executeRawUnsafe('DELETE FROM audit_records'),
      ).rejects.toThrow(/permission denied/i);
    });
  });
});
