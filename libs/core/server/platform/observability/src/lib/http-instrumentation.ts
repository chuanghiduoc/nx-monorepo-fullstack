import { SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { Metrics } from './metrics.js';
import {
  parentContextFrom,
  traceIdFrom,
  traceparentFor,
} from './trace-context.js';
import { tracer } from './tracing.js';

/** Where the span and its timer are kept between the two hooks. */
const STATE = Symbol('observability');

interface Instrumented {
  [STATE]?: {
    readonly end: () => void;
  };
}

/** What a request that matched no route is labelled, so URLs never become labels. */
const UNMATCHED_ROUTE = 'unmatched';

export interface HttpInstrumentationOptions {
  readonly metrics: Metrics;
  /** Paths that are measured but never traced: the scrape, and the probe. */
  readonly untraced?: readonly string[];
}

/**
 * A span and a timer around every request.
 *
 * Two hooks rather than one wrapper: `onRequest` is the earliest point at which
 * the request exists, and `onResponse` is the only one that runs for *every*
 * ending — a handler that threw, a connection the client dropped, a route that
 * matched nothing. A span ended in `onSend` would miss the last two, which are
 * exactly the ones somebody is looking for.
 *
 * **The route label is Fastify's route template**, never the URL. `/api/v1/notes/:id`
 * is one time series; the URL is one per note, forever, and that is how a
 * metrics backend is destroyed by an application that meant well.
 */
export function mountHttpInstrumentation(
  fastify: FastifyInstance,
  options: HttpInstrumentationOptions,
): void {
  const { metrics } = options;
  const untraced = new Set(options.untraced ?? []);

  fastify.addHook('onRequest', (request, _reply, done) => {
    metrics.requestsInFlight.inc();

    if (untraced.has(request.url.split('?')[0] ?? '')) {
      // Measured but not traced. A scrape every fifteen seconds is a trace
      // every fifteen seconds that says nothing and costs storage forever.
      markStarted(request, () => undefined);
      done();
      return;
    }

    const parent = parentContextFrom(request.headers) ?? contextFor(request);

    const span = tracer().startSpan(
      `${request.method} ${routeOf(request)}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          'http.request.method': request.method,
          'http.route': routeOf(request),
          'request.id': String(request.id),
        },
      },
      parent,
    );

    const active = trace.setSpan(parent, span);

    markStarted(request, () => {
      span.end();
    });

    // The handler runs *inside* the context, which is what makes a span created
    // deeper down a child of this one rather than a root of its own.
    context.with(active, done);
  });

  fastify.addHook('onResponse', (request, reply, done) => {
    metrics.requestsInFlight.dec();

    const route = routeOf(request);
    const status = String(reply.statusCode);

    metrics.requestDuration.observe(
      { route, method: request.method, status },
      reply.elapsedTime / 1_000,
    );

    const span = trace.getSpan(context.active());

    if (span !== undefined) {
      span.setAttribute('http.response.status_code', reply.statusCode);

      if (reply.statusCode >= 500) {
        // Only 5xx. A 404 or a 422 is the service working: marking those as
        // errors makes every trace red and the colour stops meaning anything.
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
    }

    (request as unknown as Instrumented)[STATE]?.end();
    done();
  });
}

function markStarted(request: FastifyRequest, end: () => void): void {
  (request as unknown as Instrumented)[STATE] = { end };
}

/**
 * The trace this request belongs to when nobody sent us one.
 *
 * Built from the request id, so the trace, the log lines, the problem document
 * and `x-request-id` are the same sixteen bytes. A request id that is not a
 * UUID — a caller may send any string — gets an ordinary random trace instead
 * of one nothing can look up.
 */
function contextFor(request: FastifyRequest) {
  const traceId = traceIdFrom(String(request.id));

  if (traceId === undefined) {
    return context.active();
  }

  return parentContextFrom({
    traceparent: traceparentFor(traceId, spanIdFrom(traceId)),
  }) ?? context.active();
}

/**
 * A span id for the root span, derived from the trace id.
 *
 * Half of the trace id: it has to be eight bytes, it has to be stable for the
 * request, and it must not be all zeroes — which the trace id already cannot
 * be, because `traceIdFrom` refuses that one.
 */
function spanIdFrom(traceId: string): string {
  const half = traceId.slice(0, 16);

  return half === '0'.repeat(16) ? '00000000000000ff' : half;
}

function routeOf(request: FastifyRequest): string {
  return request.routeOptions.url ?? UNMATCHED_ROUTE;
}
