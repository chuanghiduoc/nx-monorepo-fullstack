import { z } from 'zod';

import type { JobDefinition } from '@workspace/core-server-queue';

/**
 * One delivery to one endpoint.
 *
 * The dispatcher fans an event out into these, so a receiver that is down
 * delays nobody else's endpoint and a retry is a retry of one delivery rather
 * than of the event.
 *
 * The endpoint's **id** rather than its url and secret: a job sits on a queue
 * for as long as its retries take, and an endpoint that was deleted or pointed
 * somewhere else in the meantime must not be delivered to from a copy the
 * queue happened to keep. The secret especially — a rotated one would keep
 * signing with the old key for a fortnight.
 */
const webhookDeliverySchema = z.object({
  endpointId: z.uuidv7(),
  orgId: z.uuid(),
  eventId: z.uuidv7(),
  eventType: z.string().min(1),
  /** The body, already serialised, so every attempt signs the same bytes. */
  body: z.string().min(1),
});

export type WebhookDeliveryJob = z.infer<typeof webhookDeliverySchema>;

/**
 * The queue one endpoint's deliveries go onto.
 *
 * Separate from `webhook-dispatch`, which carries events: fanning out is cheap
 * and always succeeds, while delivering is slow and often does not. One queue
 * for both would let a receiver that times out for an hour block the fan-out
 * of every other event.
 */
export const webhookDelivery: JobDefinition<WebhookDeliveryJob> = {
  queue: 'webhook-deliveries',
  name: 'send',
  payload: webhookDeliverySchema,
};
