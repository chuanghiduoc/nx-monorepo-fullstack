import {
  SpanKind,
  context,
  propagation,
  trace,
  type TextMapGetter,
  type TextMapSetter,
} from '@opentelemetry/api';

/** A trace id is sixteen bytes, written as thirty-two hex characters. */
const TRACE_ID_LENGTH = 32;
const SPAN_ID_LENGTH = 16;

/** The `traceparent` header's own version, and the only one it has ever had. */
const TRACEPARENT_VERSION = '00';

/** Bit 0 of the flags: this trace was sampled and should be recorded. */
const SAMPLED_FLAG = '01';

/**
 * The trace id a request id stands for.
 *
 * A request id is a UUID, which is sixteen bytes — exactly what a trace id is.
 * Stripping the dashes gives one from the other, so the id in a log line, the
 * `traceId` in a problem document, the `x-request-id` on the response and the
 * trace itself are all **the same sixteen bytes**, in the two spellings each
 * of those systems uses.
 *
 * The alternative was carrying the request id as a span attribute and letting
 * the trace have an id of its own. That works, and it makes "find the trace for
 * this error" a search rather than a lookup — which is the difference between
 * a minute and ten during an incident.
 */
export function traceIdFrom(requestId: string): string | undefined {
  const stripped = requestId.replace(/-/g, '').toLowerCase();

  // A caller's `x-request-id` is honoured by the adapter, so this can be any
  // string somebody sent. Anything that is not a valid trace id gets a random
  // one instead, rather than a trace nothing can look up.
  return /^[0-9a-f]{32}$/.test(stripped) && stripped !== '0'.repeat(32)
    ? stripped
    : undefined;
}

/** Header names, lower-cased, because that is how Node presents them. */
const TRACEPARENT = 'traceparent';
const TRACESTATE = 'tracestate';

export interface Carrier {
  [key: string]: string | string[] | undefined;
}

const getter: TextMapGetter<Carrier> = {
  keys: (carrier) => Object.keys(carrier),
  get: (carrier, key) => {
    const value = carrier[key];
    return Array.isArray(value) ? value[0] : value;
  },
};

const setter: TextMapSetter<Carrier> = {
  set: (carrier, key, value) => {
    carrier[key] = value;
  },
};

/**
 * The trace a caller sent us, if it sent one.
 *
 * An inbound `traceparent` wins over the request id: the caller is already
 * inside a trace, and starting a new one would break the very join this whole
 * mechanism exists to make.
 */
export function parentContextFrom(carrier: Carrier) {
  return carrier[TRACEPARENT] === undefined
    ? undefined
    : propagation.extract(context.active(), carrier, getter);
}

/**
 * Puts the active trace into a carrier, for a job or an outbound request.
 *
 * A plain object rather than headers, because the queue's envelope is JSON and
 * the same two fields travel either way.
 */
export function injectTraceContext(): Record<string, string> {
  const carrier: Carrier = {};
  propagation.inject(context.active(), carrier, setter);

  const traceparent = carrier[TRACEPARENT];
  const tracestate = carrier[TRACESTATE];

  return {
    ...(typeof traceparent === 'string' ? { traceparent } : {}),
    ...(typeof tracestate === 'string' ? { tracestate } : {}),
  };
}

/** The `traceparent` a trace id and span id spell out. */
export function traceparentFor(traceId: string, spanId: string): string {
  return `${TRACEPARENT_VERSION}-${traceId}-${spanId}-${SAMPLED_FLAG}`;
}

/** Whether a string is a span id: eight bytes, sixteen hex characters. */
export function isSpanId(value: string): boolean {
  return value.length === SPAN_ID_LENGTH && /^[0-9a-f]+$/.test(value);
}

/** Whether a string is a trace id: sixteen bytes, thirty-two hex characters. */
export function isTraceId(value: string): boolean {
  return value.length === TRACE_ID_LENGTH && /^[0-9a-f]+$/.test(value);
}

/** The trace the current code is running inside, for a log line to quote. */
export function currentTraceId(): string | undefined {
  const active = trace.getSpan(context.active())?.spanContext().traceId;

  return active === undefined || active === '0'.repeat(TRACE_ID_LENGTH)
    ? undefined
    : active;
}

export { SpanKind };
