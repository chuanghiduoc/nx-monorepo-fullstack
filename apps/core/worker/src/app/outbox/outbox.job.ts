import { z } from 'zod';

import type { JobDefinition } from '@workspace/core-server-queue';

/**
 * What the relay hands the queue.
 *
 * One shape for every event, with the payload left unparsed: a consumer
 * switches on `eventType` and parses `payload` with that event's own schema.
 * A per-event job definition would mean a queue per event type, and a worker
 * consumes a whole queue — so adding an event would mean adding a consumer.
 *
 * The envelope beside this carries the tenant and the actor. They are not
 * repeated here: two copies of the same fact drift, and the envelope's is the
 * one the queue library already validates.
 */
const outboxDeliverySchema = z.object({
  eventId: z.uuidv7(),
  eventType: z.string().min(1),
  aggregateType: z.string().min(1),
  aggregateId: z.uuidv7(),
  aggregateVersion: z.number().int().nonnegative().nullable(),
  payload: z.unknown(),

  /**
   * When the thing happened, as opposed to when it was enqueued.
   *
   * **Optional, and it has to stay optional until every job written without it
   * has drained.** A required field added to the payload of a live queue is a
   * breaking change of the worst kind: a job from the previous deploy fails to
   * parse, `parseEnvelope` raises an error that declares itself fatal, BullMQ
   * does not retry it even once, and its outbox row is already `ENQUEUED`
   * where neither the claim nor the reclaim will look again. Every event in
   * the deploy window, lost. The envelope already states this rule for itself;
   * the payload had simply never had it applied.
   *
   * A consumer that finds it absent falls back to the envelope's timestamp and
   * says so, in its log and in what it writes.
   */
  occurredAt: z.iso.datetime().optional(),
});

export type OutboxDelivery = z.infer<typeof outboxDeliverySchema>;

/**
 * The audit trail's queue.
 *
 * One queue per consumer, because a BullMQ worker takes every job on the queue
 * it watches — two consumers sharing one would take each other's work. The
 * relay fans out across `OUTBOX_CONSUMERS` below.
 */
export const outboxDelivery: JobDefinition<OutboxDelivery> = {
  queue: 'events',
  name: 'deliver',
  payload: outboxDeliverySchema,
};

/**
 * The webhook dispatcher's queue.
 *
 * The same payload, a different queue. Its failures are its own: a receiver
 * that times out for an hour delays nothing in the audit trail, and a retry
 * here is a retry of one delivery rather than of the event.
 */
export const webhookDispatch: JobDefinition<OutboxDelivery> = {
  queue: 'webhook-dispatch',
  name: 'deliver',
  payload: outboxDeliverySchema,
};

/**
 * Every queue a relayed event is copied onto.
 *
 * The relay enqueues once per entry, under the event's own id — which
 * deduplicates *within* each queue and deliberately not across them.
 *
 * **A row reaches `ENQUEUED` only when every one of these accepted it.** A
 * partial failure fails the whole event and the batch is retried, so the
 * consumers that did accept see it a second time. That is correct and already
 * handled: the audit consumer's claim absorbs a repeat, and the webhook
 * contract says at-least-once because no transaction can span this database
 * and somebody else's server. The alternative is per-consumer state on the
 * outbox row — a status column each, and a claim that reasons about partial
 * delivery — which is a great deal of machinery to avoid a duplicate neither
 * consumer minds.
 *
 * Every event now costs one enqueue per entry. At the shipped hundred events a
 * second that is two hundred Redis round trips a second on a connection that
 * does nothing else. Nothing measured says that is a problem; it is written
 * down so the next person adding a consumer knows what they are adding.
 */
export const OUTBOX_CONSUMERS: readonly JobDefinition<OutboxDelivery>[] = [
  outboxDelivery,
  webhookDispatch,
];

/**
 * A queue enters this list when something consumes it, and not before.
 *
 * The relay refuses to deliver anything while any listed queue has no
 * consumer — correctly, because an unconsumed queue on a Redis that never
 * evicts fills until it refuses writes. So adding a definition here before its
 * consumer exists does not prepare for the consumer; it stops delivery
 * entirely, including to the consumers that were working.
 */
