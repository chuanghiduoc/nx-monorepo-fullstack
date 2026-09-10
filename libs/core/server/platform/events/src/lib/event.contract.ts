import { z } from 'zod';

/**
 * One kind of thing that happened.
 *
 * A name and a schema, and deliberately nothing else — no publish, no handler,
 * no transport. This library is `type:util`, which bans both the ORM and the
 * queue driver, so a definition cannot grow a way to send itself. The producer
 * writes it to the outbox and the consumer reads it from a job, and the only
 * thing they share is this.
 *
 * The name is what is stored, so it outlives the code on both sides: a
 * consumer built from a different deploy matches on the string, not on the
 * identity of an object.
 */
export interface EventDefinition<Payload> {
  /** `<aggregate>.<past tense>`, stored verbatim in `outbox_events.event_type`. */
  readonly type: string;
  /** What the aggregate is called, stored in `aggregate_type`. */
  readonly aggregate: string;
  readonly payload: z.ZodType<Payload>;
}

/** The payload of an event, for a consumer that has the definition. */
export type PayloadOf<Definition> =
  Definition extends EventDefinition<infer Payload> ? Payload : never;

/**
 * Declares an event.
 *
 * A function rather than an object literal so the type parameter is inferred
 * from the schema: written by hand, `payload` and `Payload` drift apart the
 * first time somebody edits one of them.
 */
export function defineEvent<Payload>(
  definition: EventDefinition<Payload>,
): EventDefinition<Payload> {
  return definition;
}
