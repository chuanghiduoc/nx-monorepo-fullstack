import { Logger } from '@nestjs/common';
import {
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Span,
  type SpanOptions,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

export interface TracingOptions {
  /** What this process is called in a trace. */
  readonly serviceName: string;
  readonly serviceVersion: string;
  /**
   * Where spans go. Unset means tracing is off, and that is a supported
   * state — the same shape the assistant and the erasure role use.
   */
  readonly endpoint?: string;
  /**
   * An exporter to use instead of OTLP. For the suites, which assert on what
   * was produced rather than on what was sent somewhere.
   */
  readonly exporter?: SpanExporter;
}

export interface Tracing {
  /** Ends the batch processor, flushing whatever it is holding. */
  shutdown(): Promise<void>;
}

/**
 * Turns tracing on, or says clearly that it is off.
 *
 * **Instrumented by hand, deliberately.** `@opentelemetry/auto-instrumentations-node`
 * works by patching `Module._load` through `require-in-the-middle`, and these
 * applications are bundled with `externalDependencies: 'none'` — one file, no
 * module boundaries left to patch. Registering the auto-instrumentations here
 * would produce a working SDK and no spans at all, which is worse than no
 * tracing: an empty dashboard because nothing is instrumented looks exactly
 * like an empty dashboard because nothing is happening.
 *
 * So the spans are the ones this code creates, at the boundaries that matter:
 * an HTTP request, a job enqueued, a job consumed, a transaction. Those are
 * where a request crosses a process or waits on something, which is the whole
 * of what a trace is for. `docs/contracts/observability.md` lists them, so
 * nobody goes looking for a span that was never going to be there.
 */
export function startTracing(options: TracingOptions): Tracing {
  const logger = new Logger('Tracing');

  const processor = spanProcessorFor(options);

  if (processor === undefined) {
    logger.log(
      'OTEL_EXPORTER_OTLP_ENDPOINT is not set, so nothing is traced. Requests still carry an id, and it is in every log line.',
    );

    return { shutdown: () => Promise.resolve() };
  }

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion,
    }),
    spanProcessors: [processor],
  });

  provider.register();

  // W3C `traceparent`, spelled out rather than left to the default: a
  // propagator that changed under us would silently stop joining traces across
  // the edge, and nothing would fail.
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  logger.log(
    options.endpoint === undefined
      ? `Tracing ${options.serviceName} into the exporter it was given.`
      : `Tracing ${options.serviceName} to ${options.endpoint}.`,
  );

  return {
    shutdown: async () => {
      await provider.shutdown();
    },
  };
}

function spanProcessorFor(options: TracingOptions): SpanProcessor | undefined {
  if (options.exporter !== undefined) {
    // Simple, not batched: a test that had to wait for a batch would either be
    // slow or flaky, and there is no network here to be kind to.
    return new SimpleSpanProcessor(options.exporter);
  }

  if (options.endpoint === undefined) {
    return undefined;
  }

  return new BatchSpanProcessor(
    new OTLPTraceExporter({ url: `${options.endpoint}/v1/traces` }),
  );
}

/** The tracer everything in this workspace creates spans from. */
export function tracer() {
  return trace.getTracer('@workspace/core-server-observability');
}

/**
 * Runs work inside a span, and records what happened to it.
 *
 * The `catch` is the point: a span that ended without its error looks like a
 * successful operation that happened to be followed by a failure somewhere
 * else, which is the hardest kind of trace to read.
 */
export async function withSpan<T>(
  name: string,
  options: SpanOptions,
  work: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, options, async (span) => {
    try {
      const result = await work(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (failure) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: failure instanceof Error ? failure.message : String(failure),
      });

      if (failure instanceof Error) {
        span.recordException(failure);
      }

      throw failure;
    } finally {
      span.end();
    }
  });
}

/** Runs work inside an already-extracted parent context. */
export function withContext<T>(
  parent: ReturnType<typeof context.active> | undefined,
  work: () => T,
): T {
  return parent === undefined ? work() : context.with(parent, work);
}
