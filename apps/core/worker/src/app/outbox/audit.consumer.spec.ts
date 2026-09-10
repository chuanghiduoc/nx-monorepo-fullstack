import { Client } from 'pg';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DatabaseModule } from '@workspace/core-server-data-access-db';
import type { EnvelopedJob } from '@workspace/core-server-queue';
import { startPostgres, type TestPostgres } from '@workspace/core-server-testing';

import { AUDIT_CONSUMER, AuditConsumer } from './audit.consumer.js';
import type { OutboxDelivery } from './outbox.job.js';

const SUITE_TIMEOUT_MS = 300_000;

const ORG = '0199a1b2-0000-7000-8000-00000000000a';
const USER = '0199a1b2-0000-7000-8000-0000000000aa';
const NOTE = '0199a1b2-0000-7000-8000-0000000000cc';

const HAPPENED_AT = '2026-09-02T10:00:00.000Z';
const ENQUEUED_AT = '2026-09-02T11:00:00.000Z';

interface AuditRow {
  event_id: string;
  event_type: string;
  tenant_id: string | null;
  actor_id: string | null;
  occurred_at: Date;
  detail: Record<string, unknown>;
}

/**
 * The audit consumer, against the real database and the real grants.
 *
 * The job is built here rather than pulled off a queue: what this file is
 * about is what one delivery does to two tables, and the queue's own behaviour
 * — the envelope, the retry classification, the deduplication window — is
 * proven where it lives.
 */
describe('recording what happened', () => {
  let postgres: TestPostgres;
  let owner: Client;
  let moduleRef: TestingModule;
  let consumer: AuditConsumer;

  const delivery = (
    overrides: Partial<OutboxDelivery> = {},
    envelope: Partial<EnvelopedJob<OutboxDelivery>['envelope']> = {},
  ): EnvelopedJob<OutboxDelivery> => ({
    payload: {
      eventId: '0199a1b2-0000-7000-8000-0000000000e1',
      eventType: 'note.created',
      aggregateType: 'note',
      aggregateId: NOTE,
      aggregateVersion: 1,
      payload: { noteId: NOTE, orgId: ORG, titleLength: 5, bodyLength: 9 },
      occurredAt: HAPPENED_AT,
      ...overrides,
    },
    envelope: {
      schemaVersion: 1,
      attempt: 1,
      requestedAt: ENQUEUED_AT,
      tenantId: ORG,
      actorId: USER,
      ...envelope,
    },
  });

  const records = async (): Promise<AuditRow[]> =>
    (await owner.query<AuditRow>('SELECT * FROM audit_records')).rows;

  const claims = async (): Promise<number> =>
    Number(
      (
        await owner.query<{ n: string }>(
          'SELECT count(*) AS n FROM processed_events',
        )
      ).rows[0]?.n ?? 0,
    );

  beforeAll(async () => {
    postgres = await startPostgres();
    process.env['WORKER_DATABASE_URL'] = postgres.workerUri;

    owner = new Client({ connectionString: postgres.migrationUri });
    await owner.connect();

    moduleRef = await Test.createTestingModule({
      imports: [
        DatabaseModule.forRoot(
          'WORKER_DATABASE_URL',
          'WORKER_DATABASE_POOL_MAX',
        ),
      ],
      providers: [AuditConsumer],
    }).compile();
    await moduleRef.init();

    consumer = moduleRef.get(AuditConsumer);
  }, SUITE_TIMEOUT_MS);

  afterAll(async () => {
    await moduleRef?.close();
    await owner?.end();
    await postgres?.stop();
  });

  beforeEach(async () => {
    await owner.query('DELETE FROM audit_records');
    await owner.query('DELETE FROM processed_events');
  });

  it('records an event, as the role that will actually run it', async () => {
    await consumer.handle(delivery());

    const [row] = await records();
    expect(row?.event_type).toBe('note.created');
    expect(row?.tenant_id).toBe(ORG);
    expect(row?.actor_id).toBe(USER);
    expect(await claims()).toBe(1);
  });

  it('records when the thing happened, not when it was enqueued', async () => {
    await consumer.handle(delivery());

    const [row] = await records();

    // The envelope's timestamp is the moment the relay called `add`, which is
    // an hour later here and is not even stable per event: a reclaimed
    // re-enqueue produces a new one. A trail built on it reports the wrong
    // time for everything.
    expect(row?.occurred_at.toISOString()).toBe(HAPPENED_AT);
  });

  it('leaves one record when the same event arrives twice', async () => {
    const job = delivery();

    await consumer.handle(job);
    await consumer.handle(job);

    // At-least-once is what actually arrives — the queue's own deduplication
    // expires with the completed job — so this is the half that makes it once.
    expect(await records()).toHaveLength(1);
    expect(await claims()).toBe(1);
  });

  it('records an event type nobody has taught it about', async () => {
    await consumer.handle(
      delivery({
        eventType: 'something.nobody.knows',
        aggregateType: 'mystery',
        payload: { whatever: true },
      }),
    );

    // Refusing what it cannot interpret would lose exactly the events that
    // most need recording: the new ones, during the deploy that added them.
    const [row] = await records();
    expect(row?.event_type).toBe('something.nobody.knows');
    expect(row?.detail).toEqual({ whatever: true });
  });

  it('says so in the record when it had to guess the time', async () => {
    await consumer.handle(delivery({ occurredAt: undefined }));

    const [row] = await records();

    // A job written before the field existed. The log says so too, but logs
    // have a retention and this table deliberately does not — a year later
    // nothing else would distinguish this row from one whose time was real.
    expect(row?.occurred_at.toISOString()).toBe(ENQUEUED_AT);
    expect(row?.detail['occurredAtInferred']).toBe(true);
  });

  it('claims the event under a name that is part of a primary key', async () => {
    await consumer.handle(delivery());

    const [row] = (
      await owner.query<{ consumer: string }>(
        'SELECT consumer FROM processed_events',
      )
    ).rows;

    // Renaming this does not rename the rows already written, so every event
    // this consumer has ever handled would look unhandled and the whole
    // history would be processed again. It is a constant for that reason, and
    // this is what would notice it changing.
    expect(row?.consumer).toBe(AUDIT_CONSUMER);
  });

  it('cannot insert at all once SELECT is taken away', async () => {
    // The grant's reason, pinned. `INSERT ... ON CONFLICT (event_id) DO NOTHING`
    // names an inference specification, and inferring an index reads the
    // table — so SELECT here is not headroom for a future read API. An audit
    // of the grants that removed it as unused would break every audit insert,
    // inside the consumer's transaction, only where the grants are real, and
    // never in a test that runs as the owner.
    await owner.query('REVOKE SELECT ON audit_records FROM worker_user');

    try {
      await expect(consumer.handle(delivery())).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await owner.query('GRANT SELECT ON audit_records TO worker_user');
    }

    expect(await records()).toHaveLength(0);

    // The half that matters: the claim and the record are in one transaction,
    // so a failed insert must leave no claim behind either. A claim without a
    // record is the state that makes the event unrecoverable — the next
    // delivery finds it handled and does nothing, and the trail is short one
    // event with nothing anywhere saying so.
    expect(await claims()).toBe(0);
  });

  it('records a system event, which has no tenant', async () => {
    await consumer.handle(
      delivery({}, { tenantId: undefined, actorId: undefined }),
    );

    const [row] = await records();
    expect(row?.tenant_id).toBeNull();
    expect(row?.actor_id).toBeNull();
  });

  it('keeps one record when the dedup row and the trail disagree', async () => {
    const job = delivery();
    await consumer.handle(job);

    // The state that should be impossible: the trail holds the event, the
    // consumer's claim on it does not. Reachable when two replicas disagree
    // about the retention window and one sweeps a dedup row the other still
    // considers replayable.
    await owner.query('DELETE FROM processed_events');

    await consumer.handle(job);

    // Committing is right — the end state is one record and one claim — and
    // the constraint is what noticed. Rolling back would redeliver forever.
    expect(await records()).toHaveLength(1);
    expect(await claims()).toBe(1);
  });
});
