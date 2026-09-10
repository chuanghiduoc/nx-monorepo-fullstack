import {
  POSTGRES_START_TIMEOUT_MS,
  startPostgres,
  type TestPostgres,
} from '@workspace/core-server-testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../prisma.service.js';
import { Database } from '../transaction/database.js';
import { OutboxRepository, MAX_PAYLOAD_BYTES } from './outbox.repository.js';
import { ProcessedEventRepository } from './processed-event.repository.js';

const ORG = '0199a1b2-0000-7000-8000-00000000000a';
const USER = '0199a1b2-0000-7000-8000-0000000000aa';
const NOTE = '0199a1b2-0000-7000-8000-0000000000cc';

const ORG_CONTEXT = { kind: 'org', orgId: ORG, userId: USER } as const;

const BATCH = 10;
const MAX_ATTEMPTS = 3;
const LEASE_MS = 1_000;
const RETENTION_HOURS = 168;

const anEvent = {
  aggregateType: 'note',
  aggregateId: NOTE,
  aggregateVersion: 1,
  eventType: 'note.created',
  payload: { noteId: NOTE, orgId: ORG, titleLength: 5, bodyLength: 9 },
};

/**
 * The outbox, against a real PostgreSQL and under the real grants.
 *
 * Two clients, because the two halves run as different roles and the whole
 * least-privilege argument rests on that: the API appends as `app_user`, which
 * may insert and nothing else, and the relay claims as `worker_user`, which
 * may do everything except insert. A suite that ran both as the owner would
 * pass while the first request in production failed on a permission.
 */
describe('the outbox', () => {
  let postgres: TestPostgres;
  let asApp: PrismaService;
  let asWorker: PrismaService;
  let appDb: Database;
  let workerDb: Database;
  let outbox: OutboxRepository;

  /** Appends the way a request does: as `app_user`, in a tenant transaction. */
  const append = (event = anEvent) =>
    appDb.withTenantTransaction(ORG_CONTEXT, () => outbox.append(event));

  /** Everything the relay does runs as `worker_user`, in a system transaction. */
  const asRelay = <T>(work: () => Promise<T>) => workerDb.withSystemTransaction(work);

  const countBy = async (status: string) => {
    const [row] = await asWorker.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM outbox_events WHERE status = $1`,
      status,
    );
    return Number(row?.n ?? 0);
  };

  beforeAll(async () => {
    postgres = await startPostgres();
    process.env['WORKER_DATABASE_URL'] = postgres.workerUri;

    asApp = new PrismaService('DATABASE_URL', 'DATABASE_POOL_MAX');
    asWorker = new PrismaService('WORKER_DATABASE_URL', 'WORKER_DATABASE_POOL_MAX');
    await Promise.all([asApp.$connect(), asWorker.$connect()]);

    appDb = new Database(asApp);
    workerDb = new Database(asWorker);
    outbox = new OutboxRepository();
  }, POSTGRES_START_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.all([asApp?.$disconnect(), asWorker?.$disconnect()]);
    await postgres?.stop();
  });

  beforeEach(async () => {
    await asWorker.$executeRawUnsafe('DELETE FROM outbox_events');
    await asWorker.$executeRawUnsafe('DELETE FROM processed_events');
  });

  it('gives each role exactly the rights it needs and no others', async () => {
    const rows = await asWorker.$queryRawUnsafe<
      { role: string; tbl: string; privs: string | null }[]
    >(`
      WITH r(role) AS (VALUES ('app_user'),('worker_user'),('cross_tenant_admin_role')),
           t(tbl)  AS (VALUES ('outbox_events'),('processed_events'),('audit_records')),
           p(priv) AS (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'))
      SELECT role, tbl,
             string_agg(priv, ',' ORDER BY priv)
               FILTER (WHERE has_table_privilege(role, tbl, priv)) AS privs
        FROM r, t, p GROUP BY role, tbl ORDER BY role, tbl`);

    // The API may write an event and never read one back — it cannot see
    // another tenant's payloads, delete an event before the relay sees it, or
    // mark one delivered to swallow it. A support role that could read every
    // tenant's payloads is the thing this whole revoke is about.
    expect(
      Object.fromEntries(rows.map((row) => [`${row.role}:${row.tbl}`, row.privs])),
    ).toEqual({
      'app_user:outbox_events': 'INSERT',
      'app_user:processed_events': null,
      'app_user:audit_records': null,
      'cross_tenant_admin_role:outbox_events': null,
      'cross_tenant_admin_role:processed_events': null,
      'cross_tenant_admin_role:audit_records': null,
      'worker_user:outbox_events': 'DELETE,SELECT,UPDATE',
      'worker_user:processed_events': 'DELETE,INSERT,SELECT',
      // SELECT is not headroom: `ON CONFLICT (event_id) DO NOTHING` names an
      // inference specification, which reads the table. No UPDATE and no
      // DELETE anywhere — a trail whose writer can rewrite it is not a trail.
      'worker_user:audit_records': 'INSERT,SELECT',
    });
  });

  it('lets the sweep lock a dedup row without letting it forge one', async () => {
    const rows = await asWorker.$queryRawUnsafe<{ col: string; allowed: boolean }[]>(`
      SELECT col, has_column_privilege('worker_user', 'processed_events', col, 'UPDATE') AS allowed
        FROM (VALUES ('processed_at'),('event_id'),('consumer')) AS c(col)`);

    // `FOR UPDATE SKIP LOCKED` needs the UPDATE privilege — DELETE does not
    // imply it — and the sweep needs the lock hint or concurrent replicas
    // contend for the same rows and two of three clear nothing.
    //
    // Column-level is the whole point rather than tidiness. Table-level would
    // also allow `SET event_id`, which forges a dedup row for an event nobody
    // processed: the consumer finds a claim, does nothing, and the event
    // disappears from the audit trail with no error anywhere. DELETE fails the
    // opposite way and loudly — reprocessing, which the unique index catches.
    expect(Object.fromEntries(rows.map((row) => [row.col, row.allowed]))).toEqual({
      processed_at: true,
      event_id: false,
      consumer: false,
    });
  });

  it('appends as the role the API actually connects with', async () => {
    // The check the privilege matrix above cannot make: Prisma's `create()`
    // emits RETURNING, RETURNING needs SELECT, and app_user has none — so a
    // repository written the obvious way fails here and only here.
    await append();

    expect(await countBy('PENDING')).toBe(1);
  });

  it('leaves no event when the transaction that wrote it rolls back', async () => {
    // The whole mechanism in one assertion: there is no "did the event get
    // sent" failure mode, because the event and the aggregate commit together.
    await expect(
      appDb.withTenantTransaction(ORG_CONTEXT, async () => {
        await outbox.append(anEvent);
        throw new Error('the business rejected it');
      }),
    ).rejects.toThrow('the business rejected it');

    expect(await countBy('PENDING')).toBe(0);
  });

  it('refuses to run outside a transaction, and says what to do', async () => {
    await expect(outbox.append(anEvent)).rejects.toThrow(
      /must run inside the transaction that writes the aggregate/,
    );
  });

  it('refuses a transaction that knows a user but no organization', async () => {
    // The event would land with a null tenant, indistinguishable from one the
    // system raised for itself — and a consumer reading that opens a system
    // transaction and handles a tenant's event with no tenant scoping.
    await expect(
      appDb.withTenantTransaction({ kind: 'user', userId: USER }, () =>
        outbox.append(anEvent),
      ),
    ).rejects.toThrow(/knows a user but no organization/);
  });

  it('refuses a payload that is carrying a record rather than describing one', async () => {
    const huge = { text: 'x'.repeat(MAX_PAYLOAD_BYTES) };

    await expect(
      appDb.withTenantTransaction(ORG_CONTEXT, () =>
        outbox.append({ ...anEvent, payload: huge }),
      ),
    ).rejects.toThrow(/note.created on note .* bytes, over the/);
  });

  it('carries the tenant and the actor from the transaction, not from the caller', async () => {
    await append();

    const [row] = await asWorker.$queryRawUnsafe<
      { tenant_id: string; actor_id: string }[]
    >('SELECT tenant_id, actor_id FROM outbox_events');

    // The caller passing these is the place to get them wrong, and a job whose
    // tenant is wrong reads nothing rather than failing.
    expect(row).toEqual({ tenant_id: ORG, actor_id: USER });
  });

  it('lets two relays claim disjoint rows', async () => {
    for (let index = 0; index < 6; index += 1) {
      await append();
    }

    const [first, second] = await Promise.all([
      asRelay(() => outbox.claimPending(3, MAX_ATTEMPTS)),
      asRelay(() => outbox.claimPending(3, MAX_ATTEMPTS)),
    ]);

    const ids = [...first, ...second].map((event) => event.eventId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(await countBy('PROCESSING')).toBe(ids.length);
  });

  it('will not let a stale relay undo work another one finished', async () => {
    await append();

    const [claimed] = await asRelay(() => outbox.claimPending(BATCH, MAX_ATTEMPTS));
    if (!claimed) throw new Error('expected a claim');

    // The lease expires and another relay takes the row, delivers it and marks
    // it. Only then does the first relay's enqueue time out.
    await asWorker.$executeRawUnsafe(
      `UPDATE outbox_events SET status='ENQUEUED', enqueued_at=now(), locked_at=now()`,
    );

    const failed = await asRelay(() =>
      outbox.markFailed([claimed.eventId], claimed.lockedAt, 'late timeout', MAX_ATTEMPTS),
    );

    // Without the fence this drags a delivered row back to PENDING with
    // enqueued_at set — a state the sweep can never clean, delivered twice.
    expect(failed).toEqual([]);
    expect(await countBy('ENQUEUED')).toBe(1);
  });

  it('refuses a mark from a claim that no longer holds the row', async () => {
    await append();
    const [claimed] = await asRelay(() => outbox.claimPending(BATCH, MAX_ATTEMPTS));
    if (!claimed) throw new Error('expected a claim');

    // Another relay reclaims it: same status, *different* `locked_at`. This is
    // the case the fencing token exists for, and the status predicate alone
    // cannot see it — a test that moved the row to ENQUEUED first would pass
    // with the fence deleted.
    await asWorker.$executeRawUnsafe(
      `UPDATE outbox_events SET locked_at = now() + interval '1 second'`,
    );

    const marked = await asRelay(() =>
      outbox.markEnqueued([claimed.eventId], claimed.lockedAt),
    );
    const failed = await asRelay(() =>
      outbox.markFailed([claimed.eventId], claimed.lockedAt, 'late', MAX_ATTEMPTS),
    );

    expect(marked).toEqual([]);
    expect(failed).toEqual([]);
    expect(await countBy('PROCESSING')).toBe(1);
  });

  it('takes back only rows whose lease has actually expired', async () => {
    await append();
    await asRelay(() => outbox.claimPending(BATCH, MAX_ATTEMPTS));

    // Claimed a moment ago by a relay that is alive and working. Reclaiming it
    // would be two relays delivering the same event while the first is still
    // in flight.
    const reclaimed = await asRelay(() =>
      outbox.reclaimStale(BATCH, 60_000, MAX_ATTEMPTS),
    );
    const killed = await asRelay(() =>
      outbox.killExhausted(BATCH, 60_000, MAX_ATTEMPTS),
    );

    expect(reclaimed).toEqual([]);
    expect(killed).toEqual([]);
  });

  it('refuses to replay an event older than the window, or one already pending', async () => {
    await append();
    await append();

    const ids = (
      await asWorker.$queryRawUnsafe<{ event_id: string }[]>(
        'SELECT event_id FROM outbox_events ORDER BY event_id',
      )
    ).map((row) => row.event_id);

    await asWorker.$executeRawUnsafe(`
      UPDATE outbox_events SET status='DEAD', attempts=${MAX_ATTEMPTS},
             occurred_at = now() - interval '400 hours'`);

    // Past the window the event is gone from every downstream too, so putting
    // it back would deliver something nothing else can corroborate — and it
    // says which ids it refused, because an operator reading the queue's
    // failed set (kept twice as long) would otherwise be told nothing at all.
    const tooOld = await asRelay(() => outbox.replay(ids, RETENTION_HOURS));
    expect(tooOld.replayed).toEqual([]);
    expect(tooOld.refused.map((one) => one.eventId).sort()).toEqual([...ids].sort());
    expect(tooOld.refused[0]?.reason).toMatch(/replay window/);

    // And a row already waiting needs no replay; saying it was replayed would
    // report work that did not happen.
    await asWorker.$executeRawUnsafe(
      `UPDATE outbox_events SET status='PENDING', occurred_at = now()`,
    );
    expect((await asRelay(() => outbox.replay(ids, RETENTION_HOURS))).replayed).toEqual([]);
  });

  it('records an event for an aggregate that has no version', async () => {
    // Most aggregates in this schema carry no version column, so NULL is the
    // ordinary case rather than the exceptional one — and a NOT NULL column or
    // a zero default would each lie about it.
    await appDb.withTenantTransaction(ORG_CONTEXT, () =>
      outbox.append({ ...anEvent, aggregateVersion: undefined }),
    );

    const [claimed] = await asRelay(() => outbox.claimPending(BATCH, MAX_ATTEMPTS));
    expect(claimed?.aggregateVersion).toBeNull();
  });

  it('takes no more than the batch it was asked for', async () => {
    for (let index = 0; index < 5; index += 1) {
      await append();
    }

    const claimed = await asRelay(() => outbox.claimPending(2, MAX_ATTEMPTS));

    expect(claimed).toHaveLength(2);
    expect(await countBy('PENDING')).toBe(3);
  });

  it('backs a failed delivery off instead of retrying it at once', async () => {
    await append();
    const [claimed] = await asRelay(() => outbox.claimPending(BATCH, MAX_ATTEMPTS));
    if (!claimed) throw new Error('expected a claim');

    const [failed] = await asRelay(() =>
      outbox.markFailed([claimed.eventId], claimed.lockedAt, 'redis timeout', MAX_ATTEMPTS),
    );

    expect(failed?.status).toBe('PENDING');

    // Due in the future, so the next tick does not pick it straight back up.
    const claimedAgain = await asRelay(() => outbox.claimPending(BATCH, MAX_ATTEMPTS));
    expect(claimedAgain).toEqual([]);
  });

  it('gives up on a delivery that has used its attempts, on the failing path', async () => {
    await append();

    let status = 'PENDING';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      // Undo the backoff so the next attempt is due, the way time would.
      await asWorker.$executeRawUnsafe(
        `UPDATE outbox_events SET available_at = now() - interval '1 second'`,
      );

      const [claimed] = await asRelay(() => outbox.claimPending(BATCH, MAX_ATTEMPTS));
      if (!claimed) throw new Error(`expected a claim on attempt ${attempt + 1}`);

      const [failed] = await asRelay(() =>
        outbox.markFailed([claimed.eventId], claimed.lockedAt, 'still down', MAX_ATTEMPTS),
      );
      status = failed?.status ?? 'missing';
    }

    // Left at PENDING it would be stranded: unclaimable, unreachable by the
    // ceiling transition, unswept — and sitting at the head of the claim's own
    // ordering, filtered out on every tick, while nothing reported that the
    // work never happened.
    expect(status).toBe('DEAD');
    expect(await countBy('DEAD')).toBe(1);
  });

  it('gives up on a delivery whose relay died holding it', async () => {
    await append();
    const [claimed] = await asRelay(() => outbox.claimPending(BATCH, MAX_ATTEMPTS));
    if (!claimed) throw new Error('expected a claim');

    // The relay's process is gone, so its catch never ran. Spend the attempts
    // and age the lease.
    await asWorker.$executeRawUnsafe(
      `UPDATE outbox_events SET attempts = ${MAX_ATTEMPTS}, locked_at = now() - interval '1 hour'`,
    );

    const killed = await asRelay(() =>
      outbox.killExhausted(BATCH, LEASE_MS, MAX_ATTEMPTS),
    );

    expect(killed.map((event) => event.eventId)).toEqual([claimed.eventId]);
    expect(killed[0]?.tenantId).toBe(ORG);
  });

  it('reclaims a row whose relay died with attempts to spare', async () => {
    await append();
    await asRelay(() => outbox.claimPending(BATCH, MAX_ATTEMPTS));
    await asWorker.$executeRawUnsafe(
      `UPDATE outbox_events SET locked_at = now() - interval '1 hour'`,
    );

    const reclaimed = await asRelay(() =>
      outbox.reclaimStale(BATCH, LEASE_MS, MAX_ATTEMPTS),
    );

    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.eventId).toBeDefined();
  });

  it('carries the trace onto a reclaimed row, the way a claim does', async () => {
    await append();

    // A row appended inside a request that was being traced. Set here rather
    // than by starting a tracer, because nothing in this suite is tracing and
    // the column is what the relay reads either way.
    const traceParent =
      '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    await asWorker.$executeRawUnsafe(
      'UPDATE outbox_events SET trace_parent = $1',
      traceParent,
    );

    await asRelay(() => outbox.claimPending(BATCH, MAX_ATTEMPTS));
    await asWorker.$executeRawUnsafe(
      `UPDATE outbox_events SET locked_at = now() - interval '1 hour'`,
    );

    const reclaimed = await asRelay(() =>
      outbox.reclaimStale(BATCH, LEASE_MS, MAX_ATTEMPTS),
    );

    // The claim returned this column and the reclaim did not, so a re-enqueued
    // job hung off the relay's own pass instead of the request that caused the
    // event — and a reclaim is precisely when somebody is following a trace to
    // find out what happened. Nothing failed; the picture was simply wrong.
    expect(reclaimed[0]?.traceParent).toBe(traceParent);
  });

  it('makes a dead event deliverable again, attempts and all', async () => {
    await append();
    await asWorker.$executeRawUnsafe(
      `UPDATE outbox_events SET status='DEAD', attempts=${MAX_ATTEMPTS}`,
    );

    const stored = await asWorker.$queryRawUnsafe<{ event_id: string }[]>(
      'SELECT event_id FROM outbox_events',
    );
    const replayed = await asRelay(() =>
      outbox.replay(
        stored.map((row) => row.event_id),
        RETENTION_HOURS,
      ),
    );

    expect(replayed.replayed).toHaveLength(1);
    expect(replayed.refused).toEqual([]);

    // Resetting the status alone would leave it at the attempt ceiling, where
    // the claim excludes it — replayed, never delivered, and nothing says so.
    const claimed = await asRelay(() => outbox.claimPending(BATCH, MAX_ATTEMPTS));
    expect(claimed).toHaveLength(1);
  });

  it('sweeps delivered events and keeps dead ones', async () => {
    await append();
    await append();
    await asWorker.$executeRawUnsafe(`
      UPDATE outbox_events SET status='ENQUEUED',
             enqueued_at = now() - interval '400 hours'`);
    await asWorker.$executeRawUnsafe(`
      UPDATE outbox_events SET status='DEAD' WHERE event_id IN
        (SELECT event_id FROM outbox_events LIMIT 1)`);

    const swept = await asRelay(() =>
      outbox.sweepEnqueued(RETENTION_HOURS, BATCH),
    );

    // A dead event is evidence; disposing of one is a decision somebody makes.
    expect(swept).toBe(1);
    expect(await countBy('DEAD')).toBe(1);
  });

  it('marks only the rows the claim still owns', async () => {
    await append();
    const [claimed] = await asRelay(() => outbox.claimPending(BATCH, MAX_ATTEMPTS));
    if (!claimed) throw new Error('expected a claim');

    const marked = await asRelay(() =>
      outbox.markEnqueued([claimed.eventId], claimed.lockedAt),
    );
    expect(marked).toEqual([claimed.eventId]);

    // A second mark under the same token finds nothing: the row has moved on.
    const again = await asRelay(() =>
      outbox.markEnqueued([claimed.eventId], claimed.lockedAt),
    );
    expect(again).toEqual([]);
  });
});

describe('what a consumer has already done', () => {
  let postgres: TestPostgres;
  let asWorker: PrismaService;
  let db: Database;
  let processed: ProcessedEventRepository;

  const CONSUMER = 'audit';

  beforeAll(async () => {
    postgres = await startPostgres();
    process.env['WORKER_DATABASE_URL'] = postgres.workerUri;
    asWorker = new PrismaService('WORKER_DATABASE_URL', 'WORKER_DATABASE_POOL_MAX');
    await asWorker.$connect();
    db = new Database(asWorker);
    processed = new ProcessedEventRepository();
  }, POSTGRES_START_TIMEOUT_MS);

  afterAll(async () => {
    await asWorker?.$disconnect();
    await postgres?.stop();
  });

  beforeEach(async () => {
    await asWorker.$executeRawUnsafe('DELETE FROM processed_events');
  });

  it('says yes once and no afterwards', async () => {
    const eventId = '0199a1b2-0000-7000-8000-0000000000f1';

    const first = await db.withSystemTransaction(() =>
      processed.claim(CONSUMER, eventId),
    );
    const second = await db.withSystemTransaction(() =>
      processed.claim(CONSUMER, eventId),
    );

    // This, not the queue's job id, is the exactly-once guarantee: the job id
    // stops deduplicating once the completed job is cleaned up.
    expect([first, second]).toEqual([true, false]);
  });

  it('lets two consumers each handle the same event', async () => {
    const eventId = '0199a1b2-0000-7000-8000-0000000000f2';

    const audit = await db.withSystemTransaction(() =>
      processed.claim('audit', eventId),
    );
    const search = await db.withSystemTransaction(() =>
      processed.claim('search', eventId),
    );

    // Two consumers of one event are two deliveries, not one, which is why the
    // consumer is part of the key.
    expect([audit, search]).toEqual([true, true]);
  });

  it('removes rows past their window', async () => {
    // Written old rather than aged with an UPDATE: `worker_user`'s UPDATE here
    // is column-level on `processed_at` alone, granted for the sweep's
    // `FOR UPDATE SKIP LOCKED` and nothing else. An earlier version of this
    // test used a table-level UPDATE and was refused, which is the grant
    // working — a consumer records that it did something, it never edits the
    // record afterwards.
    await asWorker.$executeRawUnsafe(`
      INSERT INTO processed_events (consumer, event_id, processed_at)
      VALUES ('${CONSUMER}', '0199a1b2-0000-7000-8000-0000000000f3'::uuid,
              now() - interval '400 hours')`);

    expect(
      await db.withSystemTransaction(() => processed.sweep(336, 100)),
    ).toBe(1);
  });

  it('lets three sweepers clear three times what one clears', async () => {
    const rows = Array.from({ length: 30 }, (_unused, index) =>
      `('${CONSUMER}', '0199a1b2-0000-7000-8000-0000000${(index + 100).toString().padStart(5, '0')}'::uuid, now() - interval '400 hours')`,
    ).join(',');
    await asWorker.$executeRawUnsafe(
      `INSERT INTO processed_events (consumer, event_id, processed_at) VALUES ${rows}`,
    );

    // The whole reason this statement carries `FOR UPDATE SKIP LOCKED`, and
    // the reason that lock hint needed a grant. It moved off the hourly
    // retention job, where one replica swept per tick, onto the relay, where
    // every replica does — and unlocked they contend for the same rows, so the
    // two that lose see an empty batch and stop for the whole tick. Measured
    // before the hint: three concurrent sweepers removed exactly what one does.
    const removed = await Promise.all(
      Array.from({ length: 3 }, () =>
        db.withSystemTransaction(() => processed.sweep(336, 10)),
      ),
    );

    expect(removed.reduce((total, n) => total + n, 0)).toBe(30);
  });

  it('keeps a row that is still inside its window', async () => {
    await db.withSystemTransaction(() =>
      processed.claim(CONSUMER, '0199a1b2-0000-7000-8000-0000000000f4'),
    );

    // The window is deliberately longer than the outbox's own: a dedup row
    // that expired first would let a replayed event be processed twice.
    expect(
      await db.withSystemTransaction(() => processed.sweep(336, 100)),
    ).toBe(0);
  });
});
