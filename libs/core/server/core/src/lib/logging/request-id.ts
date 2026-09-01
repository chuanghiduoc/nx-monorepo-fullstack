import { randomUUID } from 'node:crypto';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Fastify assigns `request.id` before any logger sees the request, so the id
 * has to be configured on the adapter — a `genReqId` passed to pino-http would
 * never be called.
 *
 * An inbound `x-request-id` is honoured so a trace started by the edge proxy or
 * by a calling service continues here instead of restarting.
 */
export const requestIdOptions = {
  requestIdHeader: REQUEST_ID_HEADER,
  genReqId: () => randomUUID(),
} as const;
