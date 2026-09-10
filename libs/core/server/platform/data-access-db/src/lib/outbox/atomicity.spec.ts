import { withRequestContext } from '@workspace/core-server-core';
import {
  POSTGRES_START_TIMEOUT_MS,
  startPostgres,
  type TestPostgres,
} from '@workspace/core-server-testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { NoteRepository } from '../notes/note.repository.js';
import { PrismaService } from '../prisma.service.js';
import { Database } from '../transaction/database.js';
import { OutboxRepository } from './outbox.repository.js';

const ORG = '0199a1b2-0000-7000-8000-00000000000a';
const USER = '0199a1b2-0000-7000-8000-0000000000aa';
const CONTEXT = { kind: 'org', orgId: ORG, userId: USER } as const;

/**
 * A request, because the repository opens its transaction with
 * `withRequestTransaction` and that reads the request's own context rather
 * than the transaction's. Outside one it refuses — correctly, and loudly — so
 * a test that skipped this would be testing the refusal.
 */
const REQUEST = {
  principal: { type: 'user', id: USER, orgId: ORG, roles: ['member'] },
  tenant: CONTEXT,
} as unknown as Parameters<typeof withRequestContext>[0];

const inRequest = <T>(work: () => Promise<T>): Promise<T> =>
  withRequestContext(REQUEST, work);

const anEvent = (noteId: string, version: number) => ({
  aggregateType: 'note',
  aggregateId: noteId,
  aggregateVersion: version,
  eventType: 'note.created',
  payload: { noteId, orgId: ORG },
});

/**
 * The one property the outbox exists for.
 *
 * Not "an event is written" — that is the easy half. The point is that the
 * aggregate and the event cannot disagree: no arrangement of failures leaves
 * one without the other, because there is only one commit.
 *
 * Against a real PostgreSQL, because a doubled transaction commits whenever
 * the double says it does.
 */
describe('a note and its event commit together', () => {
  let postgres: TestPostgres;
  let asApp: PrismaService;
  let asOwner: PrismaService;
  let asWorker: PrismaService;
  let db: Database;
  let workerDb: Database;
  let notes: NoteRepository;
  let outbox: OutboxRepository;

  const eventCount = async () => {
    const [row] = await asOwner.$queryRawUnsafe<{ n: bigint }[]>(
      'SELECT count(*) AS n FROM outbox_events',
    );
    return Number(row?.n ?? 0);
  };

  beforeAll(async () => {
    postgres = await startPostgres();
    // `app_user` may insert into the outbox and read nothing back — that is
    // the grant — so counting and cleaning are the owner's job here.
    process.env['OWNER_DATABASE_URL'] = postgres.migrationUri;
    process.env['WORKER_DATABASE_URL'] = postgres.workerUri;

    asApp = new PrismaService('DATABASE_URL', 'DATABASE_POOL_MAX');
    asOwner = new PrismaService('OWNER_DATABASE_URL', 'DATABASE_POOL_MAX');
    // The relay claims as the role it really runs as, so a grant that is
    // missing fails here rather than in production.
    asWorker = new PrismaService(
      'WORKER_DATABASE_URL',
      'WORKER_DATABASE_POOL_MAX',
    );
    await Promise.all([
      asApp.$connect(),
      asOwner.$connect(),
      asWorker.$connect(),
    ]);

    db = new Database(asApp);
    workerDb = new Database(asWorker);
    notes = new NoteRepository(db);
    outbox = new OutboxRepository();
  }, POSTGRES_START_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.all([
      asApp?.$disconnect(),
      asOwner?.$disconnect(),
      asWorker?.$disconnect(),
    ]);
    await postgres?.stop();
  });

  beforeEach(async () => {
    await asOwner.$executeRawUnsafe('DELETE FROM outbox_events');
    await asOwner.$executeRawUnsafe('DELETE FROM notes');
  });

  it('writes both when the transaction commits', async () => {
    const note = await inRequest(() =>
      db.withTenantTransaction(CONTEXT, async () => {
        const created = await notes.create(ORG, { title: 'kept', body: 'yes' });
        await outbox.append(anEvent(created.id, created.version));
        return created;
      }),
    );

    expect(note.title).toBe('kept');
    expect(await eventCount()).toBe(1);
  });

  it('writes neither when it does not', async () => {
    await expect(
      inRequest(() =>
        db.withTenantTransaction(CONTEXT, async () => {
          const created = await notes.create(ORG, { title: 'lost', body: 'no' });
          await outbox.append(anEvent(created.id, created.version));

          // Whatever the business decides after the write — a quota refusal,
          // a rule the repository could not check — takes the event with it.
          throw new Error('refused after the write');
        }),
      ),
    ).rejects.toThrow('refused after the write');

    expect(await eventCount()).toBe(0);

    const kept = await inRequest(() =>
      db.withTenantTransaction(CONTEXT, () =>
        db.tenant().note.findMany({ where: { title: 'lost' } }),
      ),
    );
    expect(kept).toEqual([]);
  });

  it('delivers an event whose writer committed after the relay had polled past it', async () => {
    const BATCH = 10;
    const MAX_ATTEMPTS = 3;

    // A slow writer: it appends, and holds the transaction open. The event
    // exists, uncommitted, so no relay can see it yet.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const slowWrite = inRequest(() =>
      db.withTenantTransaction(CONTEXT, async () => {
        const created = await notes.create(ORG, { title: 'slow', body: '' });
        await outbox.append(anEvent(created.id, created.version));
        await held;
        return created;
      }),
    );

    // Give the write time to reach `append` and stop there, then poll. The
    // relay finds nothing — which is the state that matters, because the
    // event's `available_at` is *already in the past* by the time it becomes
    // visible.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const emptyPass = await workerDb.withSystemTransaction(() =>
      outbox.claimPending(BATCH, MAX_ATTEMPTS),
    );
    expect(emptyPass).toEqual([]);

    release();
    await slowWrite;

    // The next pass takes it. This is what a high-water mark on `available_at`
    // would break: the relay would have moved its cursor past a timestamp this
    // event was later stamped with, and the event would sit PENDING forever
    // with nothing reporting it. The claim filters on `status` instead, so a
    // late commit is an ordinary row.
    const afterCommit = await workerDb.withSystemTransaction(() =>
      outbox.claimPending(BATCH, MAX_ATTEMPTS),
    );

    expect(afterCommit).toHaveLength(1);
    expect(afterCommit[0]?.eventType).toBe('note.created');
  });

  it('joins the transaction the caller opened rather than starting another', async () => {
    // `NoteRepository.create` opens its own transaction when none is active.
    // If it opened a second one *inside* this, the note would commit before
    // the event and the atomicity above would be a comment. This is what makes
    // the wrapper in `NotesService` work at all.
    await expect(
      inRequest(() =>
        db.withTenantTransaction(CONTEXT, async () => {
          const created = await notes.create(ORG, { title: 'nested', body: '' });
          await outbox.append(anEvent(created.id, created.version));
          throw new Error('rolled back');
        }),
      ),
    ).rejects.toThrow('rolled back');

    const [row] = await asOwner.$queryRawUnsafe<{ n: bigint }[]>(
      "SELECT count(*) AS n FROM notes WHERE title = 'nested'",
    );

    expect(Number(row?.n ?? 0)).toBe(0);
    expect(await eventCount()).toBe(0);
  });
});
