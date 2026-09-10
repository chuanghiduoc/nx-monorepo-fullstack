import { z } from 'zod';

/**
 * The version of the envelope itself, not of any job's payload.
 *
 * It changes when the fields below change. A consumer that meets a version it
 * does not know refuses the message rather than guessing at it.
 *
 * Reading an older envelope keeps working only if every field added after this
 * version is optional. That is a rule about how the schema may change, not
 * something the parser can check: with one version in existence there is no
 * older shape to test against, and a required field added in version 2 would
 * make every version-1 message unreadable while the version check still said
 * the message was fine.
 */
export const ENVELOPE_SCHEMA_VERSION = 1;

/** W3C trace context: `00-<32 hex trace>-<16 hex span>-<2 hex flags>`. */
const TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/** The first attempt is attempt one; there is no attempt zero. */
export const FIRST_ATTEMPT = 1;

/**
 * What every job carries besides its payload.
 *
 * A job outlives the deploy that enqueued it. Whatever is in here has to still
 * mean something when a worker built from different code picks it up, which is
 * why it is data — no class instances, no object graphs, nothing whose meaning
 * depends on code that may have moved.
 */
export const jobEnvelopeSchema = z.object({
  /** Refused rather than defaulted: see `parseEnvelope`. */
  schemaVersion: z.number().int().positive(),

  /**
   * The trace this job belongs to, so a job's logs join the request that
   * caused it. Optional because a scheduled job has no request behind it.
   */
  traceparent: z.string().regex(TRACEPARENT).optional(),

  /**
   * The organization the work happens in. The worker opens its transaction
   * with this, so a job whose tenant is wrong reads nothing rather than
   * reading somebody else's rows.
   */
  tenantId: z.uuidv7().optional(),

  /** Who asked. Absent for work the system started on its own. */
  actorId: z.uuidv7().optional(),

  /**
   * Which attempt this is, counting from one. A handler that branches on it —
   * "log at warning until the last try" — reads a number a person would
   * recognise, and the queue's own zero-based count is converted once, where
   * it is read, rather than at every call site that compares against it.
   */
  attempt: z.number().int().positive(),

  /** When it was asked for — not when it ran. */
  requestedAt: z.iso.datetime(),
});

export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;

/**
 * A job the consumer must not retry.
 *
 * Thrown when a message cannot be read at all. `fatal` is what the retry
 * classifier reads: a message whose shape is wrong is wrong on every attempt,
 * so retrying it is an infinite loop with a delay in it.
 */
export class EnvelopeError extends Error {
  readonly fatal = true;

  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeError';
  }
}

export interface EnvelopedJob<Payload> {
  readonly envelope: JobEnvelope;
  readonly payload: Payload;
}

/** Builds the envelope for a job about to be enqueued. */
export function createEnvelope(
  context: Omit<JobEnvelope, 'schemaVersion' | 'attempt' | 'requestedAt'> & {
    readonly requestedAt?: Date;
  },
): JobEnvelope {
  const { requestedAt, ...rest } = context;

  return jobEnvelopeSchema.parse({
    ...rest,
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    attempt: FIRST_ATTEMPT,
    requestedAt: (requestedAt ?? new Date()).toISOString(),
  });
}

/**
 * Reads the version off an envelope before anything else looks at it.
 *
 * Validating first would report a newer envelope as a malformed one: every
 * field version 2 renamed or added comes back as its own schema error, and the
 * message a person reads says the payload is broken when the truth is that
 * this consumer is behind. The version is therefore read off the raw object,
 * with only enough checking to decide whether it can be compared.
 */
function readSchemaVersion(envelope: unknown): number {
  if (typeof envelope !== 'object' || envelope === null) {
    throw new EnvelopeError('A job must carry an envelope object.');
  }

  const { schemaVersion } = envelope as { schemaVersion?: unknown };

  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    throw new EnvelopeError(
      'The job envelope has no readable schemaVersion, so there is no way to ' +
        'tell whether this consumer understands it.',
    );
  }

  return schemaVersion;
}

/**
 * Reads an envelope off a job, or refuses the job.
 *
 * The version check is strict in one direction only: a consumer can read an
 * envelope older than itself, because every field added since is optional. It
 * cannot read a newer one — the fields it would need are ones nobody has
 * written yet — and pretending otherwise means acting on a message it has
 * misunderstood.
 */
export function parseEnvelope<Payload>(
  value: unknown,
  payloadSchema: z.ZodType<Payload>,
): EnvelopedJob<Payload> {
  if (typeof value !== 'object' || value === null) {
    throw new EnvelopeError('A job must be an object with an envelope.');
  }

  const { envelope, payload } = value as {
    envelope?: unknown;
    payload?: unknown;
  };

  const schemaVersion = readSchemaVersion(envelope);

  if (schemaVersion > ENVELOPE_SCHEMA_VERSION) {
    throw new EnvelopeError(
      `The job envelope is version ${schemaVersion}, and this consumer reads up to ${ENVELOPE_SCHEMA_VERSION}.`,
    );
  }

  const parsedEnvelope = jobEnvelopeSchema.safeParse(envelope);

  if (!parsedEnvelope.success) {
    throw new EnvelopeError(
      `The job envelope is not readable: ${parsedEnvelope.error.message}`,
    );
  }

  const parsedPayload = payloadSchema.safeParse(payload);

  if (!parsedPayload.success) {
    throw new EnvelopeError(
      `The job payload is not what this consumer expects: ${parsedPayload.error.message}`,
    );
  }

  return { envelope: parsedEnvelope.data, payload: parsedPayload.data };
}
