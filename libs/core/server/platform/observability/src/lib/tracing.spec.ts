import { SpanStatusCode, context, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ALLOWED_LABELS,
  RUNTIME_LABELS,
  createMetrics,
  labelsIn,
} from './metrics.js';
import {
  currentTraceId,
  injectTraceContext,
  parentContextFrom,
  traceIdFrom,
  traceparentFor,
} from './trace-context.js';
import { startTracing, withContext, withSpan, type Tracing } from './tracing.js';

const REQUEST_ID = '0199a1b2-0000-7000-8000-00000000000a';
const AS_TRACE_ID = '0199a1b200007000800000000000000a';

describe('the trace id and the request id are the same sixteen bytes', () => {
  it('turns a request id into a trace id by dropping the dashes', () => {
    // One id in a log line, in a problem document, on the response header and
    // on the trace. The alternative — the request id as a span attribute —
    // makes "find the trace for this error" a search rather than a lookup,
    // which is the difference between a minute and ten during an incident.
    expect(traceIdFrom(REQUEST_ID)).toBe(AS_TRACE_ID);
  });

  it('refuses a request id that is not sixteen bytes', () => {
    // `x-request-id` is honoured from the caller, so it can be any string
    // somebody sent. A trace id built from one of those is a trace nothing can
    // look up.
    expect(traceIdFrom('not-a-uuid')).toBeUndefined();
    expect(traceIdFrom('')).toBeUndefined();
  });

  it('refuses the all-zero id, which means "no trace"', () => {
    expect(traceIdFrom('00000000-0000-0000-0000-000000000000')).toBeUndefined();
  });
});

describe('tracing', () => {
  let exporter: InMemorySpanExporter;
  let tracing: Tracing;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    tracing = startTracing({
      serviceName: 'test-service',
      serviceVersion: '0.0.0',
      exporter,
    });
  });

  afterEach(async () => {
    await tracing.shutdown();
    exporter.reset();
    trace.disable();
    context.disable();
  });

  const finished = (): ReadableSpan[] => exporter.getFinishedSpans();

  it('produces a span from inside the process that ships', async () => {
    // The measurement the whole design rests on: manual instrumentation works
    // where auto-instrumentation cannot, because the applications are bundled
    // into one file and there are no module boundaries left to patch.
    await withSpan('probe', {}, async () => undefined);

    expect(finished().map((span) => span.name)).toEqual(['probe']);
  });

  it('marks a span that threw as an error, and re-raises', async () => {
    await expect(
      withSpan('failing', {}, async () => {
        throw new Error('it broke');
      }),
    ).rejects.toThrow('it broke');

    const [span] = finished();

    // A span that ended without its error looks like a successful operation
    // followed by a failure somewhere else, which is the hardest kind of trace
    // to read.
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.status.message).toBe('it broke');
    expect(span?.events.map((event) => event.name)).toContain('exception');
  });

  it('ends the span whichever way the work went', async () => {
    await withSpan('ok', {}, async () => undefined);
    await expect(
      withSpan('bad', {}, async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow();

    expect(finished()).toHaveLength(2);
  });

  it('nests a child span inside its parent', async () => {
    await withSpan('outer', {}, async () => {
      await withSpan('inner', {}, async () => undefined);
    });

    const [inner, outer] = finished();

    expect(inner?.name).toBe('inner');
    expect(inner?.parentSpanContext?.spanId).toBe(outer?.spanContext().spanId);
    expect(inner?.spanContext().traceId).toBe(outer?.spanContext().traceId);
  });

  it('continues a trace a caller sent rather than starting a new one', async () => {
    const parent = parentContextFrom({
      traceparent: traceparentFor(AS_TRACE_ID, '00f067aa0ba902b7'),
    });

    await withContext(parent, async () => {
      await withSpan('continued', {}, async () => undefined);
    });

    // The caller is already inside a trace; starting another would break the
    // join this whole mechanism exists to make.
    expect(finished()[0]?.spanContext().traceId).toBe(AS_TRACE_ID);
  });

  it('carries the trace into a carrier a job can hold', async () => {
    let carried: Record<string, string> = {};

    await withSpan('enqueue', {}, async () => {
      carried = injectTraceContext();
    });

    const traceId = finished()[0]?.spanContext().traceId;

    // `api → queue → worker` is one trace rather than two unrelated ones, and
    // this string is the whole of how.
    expect(carried['traceparent']).toContain(traceId ?? 'no-trace');
  });

  it('restores that trace on the other side of the queue', async () => {
    let carried: Record<string, string> = {};

    await withSpan('enqueue', {}, async () => {
      carried = injectTraceContext();
    });

    const enqueued = finished()[0]?.spanContext().traceId;
    exporter.reset();

    await withContext(parentContextFrom(carried), async () => {
      await withSpan('consume', {}, async () => undefined);
    });

    expect(finished()[0]?.spanContext().traceId).toBe(enqueued);
  });

  it('tells the caller which trace it is in', async () => {
    let seen: string | undefined;

    await withSpan('outer', {}, async () => {
      seen = currentTraceId();
    });

    expect(seen).toBe(finished()[0]?.spanContext().traceId);
  });
});

describe('tracing that is switched off', () => {
  it('runs the work and produces nothing, without throwing', async () => {
    const tracing = startTracing({
      serviceName: 'test-service',
      serviceVersion: '0.0.0',
    });

    // A deployment with no collector is a supported state, not a broken one:
    // requests still carry an id and it is still in every log line.
    await expect(withSpan('probe', {}, async () => 'a value')).resolves.toBe(
      'a value',
    );

    await tracing.shutdown();
  });
});

describe('the cardinality budget', () => {
  it('registers no label outside the budget', async () => {
    const metrics = createMetrics('test-service');

    metrics.requestDuration.observe(
      { route: '/api/v1/notes/:id', method: 'GET', status: '200' },
      0.01,
    );
    metrics.queueDepth.set({ queue: 'events', state: 'waiting' }, 3);
    metrics.outboxRows.set({ state: 'PENDING' }, 7);
    metrics.idempotencyConflicts.inc({ route: '/api/v1/notes' });
    metrics.quotaRejections.inc({ entitlement: 'ai.tokens' });
    metrics.webhookDeliveries.set({ outcome: 'delivered' }, 4);
    metrics.backupAgeSeconds.set(60);

    const used = await labelsIn(metrics.registry);

    // A user id as a label is one time series per user, forever. This is the
    // rule that gets broken by accident rather than on purpose, which is why
    // it is a test and not a comment.
    expect(
      [...used].filter(
        (label) => !ALLOWED_LABELS.has(label) && !RUNTIME_LABELS.has(label),
      ),
    ).toEqual([]);
  });

  it('names no identifier among the labels it allows', () => {
    const forbidden = [...ALLOWED_LABELS, ...RUNTIME_LABELS].filter((label) =>
      /(^|_)(id|user|org|organisation|organization|email|file|path|url)($|_)/i.test(
        label,
      ),
    );

    expect(forbidden).toEqual([]);
  });

  it('answers in the format a scraper reads', async () => {
    const metrics = createMetrics('test-service');
    metrics.requestsInFlight.set({ service: 'test-service' }, 2);

    const text = await metrics.registry.metrics();

    expect(text).toContain('# TYPE http_requests_in_flight gauge');
    expect(text).toContain('service="test-service"');
  });

  it('labels every series with the process it came from', async () => {
    const metrics = createMetrics('core-api');
    metrics.outboxRows.set({ state: 'PENDING' }, 1);

    // Two replicas are two series rather than one that flickers between them.
    expect(await metrics.registry.metrics()).toContain('service="core-api"');
  });
});
