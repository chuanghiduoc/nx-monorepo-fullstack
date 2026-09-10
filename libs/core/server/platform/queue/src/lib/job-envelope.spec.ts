import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { classifyFailure } from './retry-policy.js';
import {
  ENVELOPE_SCHEMA_VERSION,
  EnvelopeError,
  FIRST_ATTEMPT,
  createEnvelope,
  parseEnvelope,
} from './job-envelope.js';

const ORG = '0199a1b2-0000-7000-8000-00000000000a';
const USER = '0199a1b2-0000-7000-8000-0000000000aa';

const payloadSchema = z.object({ noteId: z.uuidv7() });
const NOTE = '0199a1b2-0000-7000-8000-0000000000cc';

const envelope = () => createEnvelope({ tenantId: ORG, actorId: USER });

describe('the job envelope', () => {
  it('stamps the version and the attempt so nothing has to default them', () => {
    const made = envelope();

    expect(made.schemaVersion).toBe(ENVELOPE_SCHEMA_VERSION);
    expect(made.attempt).toBe(FIRST_ATTEMPT);
    expect(made.tenantId).toBe(ORG);
    expect(made.actorId).toBe(USER);
  });

  it('records when the work was asked for, as an instant', () => {
    const made = createEnvelope({ requestedAt: new Date('2026-09-02T10:00:00Z') });

    // Not when it ran: the gap between the two is the queue's latency, and it
    // is only measurable if the earlier of the two is recorded.
    expect(made.requestedAt).toBe('2026-09-02T10:00:00.000Z');
  });

  it('accepts work the system started on its own', () => {
    const made = createEnvelope({});

    expect(made.tenantId).toBeUndefined();
    expect(made.actorId).toBeUndefined();
  });

  it('refuses a trace that is not a trace', () => {
    expect(() => createEnvelope({ traceparent: 'not-a-traceparent' })).toThrow();
  });

  it('reads back what it wrote', () => {
    const job = { envelope: envelope(), payload: { noteId: NOTE } };

    expect(parseEnvelope(job, payloadSchema).payload.noteId).toBe(NOTE);
  });

  it('refuses a job with no envelope at all', () => {
    expect(() => parseEnvelope({ payload: { noteId: NOTE } }, payloadSchema)).toThrow(
      EnvelopeError,
    );
    expect(() => parseEnvelope('a string', payloadSchema)).toThrow(EnvelopeError);
  });

  it('refuses an envelope with no version rather than assuming one', () => {
    const withoutVersion: Record<string, unknown> = { ...envelope() };
    delete withoutVersion['schemaVersion'];

    // Defaulting it would mean reading a message under rules it was never
    // written to, which is worse than refusing to read it.
    expect(() =>
      parseEnvelope(
        { envelope: withoutVersion, payload: { noteId: NOTE } },
        payloadSchema,
      ),
    ).toThrow(/no readable schemaVersion/);
  });

  it('refuses a version from the future and says both numbers', () => {
    const ahead = { ...envelope(), schemaVersion: ENVELOPE_SCHEMA_VERSION + 1 };

    expect(() =>
      parseEnvelope({ envelope: ahead, payload: { noteId: NOTE } }, payloadSchema),
    ).toThrow(
      new RegExp(
        `version ${ENVELOPE_SCHEMA_VERSION + 1}.*reads up to ${ENVELOPE_SCHEMA_VERSION}`,
      ),
    );
  });

  it('names the version, not the fields, when a newer envelope is unreadable', () => {
    // The case this exists for: version 2 renames a field. Validating before
    // checking the version reports every renamed field as a broken payload,
    // and the person reading it goes looking for a producer bug that is not
    // there — the truth is that this consumer is the one that is behind.
    const renamedInVersionTwo = {
      schemaVersion: ENVELOPE_SCHEMA_VERSION + 1,
      attemptNumber: FIRST_ATTEMPT,
      askedAt: new Date().toISOString(),
    };

    expect(() =>
      parseEnvelope(
        { envelope: renamedInVersionTwo, payload: { noteId: NOTE } },
        payloadSchema,
      ),
    ).toThrow(/reads up to/);
  });

  it('reads an envelope written before a field this consumer knows was added', () => {
    // The other direction of the same rule. Simulated by adding a field the
    // current schema does not know: an older producer is exactly a producer
    // that writes fewer fields than the newest one, and an unknown extra is
    // what a newer consumer's optional field looks like from here.
    const fromAnotherDeploy = { ...envelope(), somethingAddedLater: 'ignored' };

    expect(
      parseEnvelope(
        { envelope: fromAnotherDeploy, payload: { noteId: NOTE } },
        payloadSchema,
      ).envelope.attempt,
    ).toBe(FIRST_ATTEMPT);
  });

  it('refuses a payload that is not what the consumer expects', () => {
    expect(() =>
      parseEnvelope(
        { envelope: envelope(), payload: { noteId: 'not-an-id' } },
        payloadSchema,
      ),
    ).toThrow(EnvelopeError);
  });

  it('makes an unreadable job fatal, not something to retry', () => {
    // The two halves have to agree, or a message nobody can parse comes back
    // every backoff interval until the attempt ceiling — a loop with a delay
    // in it, and a queue that looks busy while achieving nothing.
    let thrown: unknown;

    try {
      parseEnvelope({ envelope: {} }, payloadSchema);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EnvelopeError);
    expect(classifyFailure(thrown)).toBe('fatal');
  });
});
