import { Global, Module, type DynamicModule } from '@nestjs/common';
import { BaseConfig } from '@workspace/core-server-core';

import { createMetrics, type Metrics } from './metrics.js';
import { startTracing, type Tracing } from './tracing.js';

export const METRICS = Symbol('METRICS');
export const TRACING = Symbol('TRACING');

export interface ObservabilityOptions {
  /** What this process is called in a trace and on every metric. */
  readonly serviceName: string;
  readonly serviceVersion?: string;
}

/**
 * The registry and the tracer, built once, owned by one module.
 *
 * Global because both are infrastructure: a feature that wanted to count
 * something would otherwise import this library, and the dependency graph would
 * say the feature depends on observability rather than on the one counter it
 * uses.
 *
 * `forRoot` rather than a plain module, for the reason the queue and the bus
 * give: the tracer is registered when the application is assembled, not when
 * this file is imported, and a decorator argument is evaluated at import time.
 *
 * The two are together because they are the same decision — this process, its
 * name, and whether anything is collecting from it — and separating them would
 * mean naming the service twice.
 */
@Global()
@Module({})
export class ObservabilityModule {
  static forRoot(options: ObservabilityOptions): DynamicModule {
    return {
      module: ObservabilityModule,
      providers: [
        {
          provide: TRACING,
          inject: [BaseConfig],
          useFactory: (config: BaseConfig): Tracing => {
            const endpoint = config.get('OTEL_EXPORTER_OTLP_ENDPOINT');

            return startTracing({
              serviceName: options.serviceName,
              serviceVersion: options.serviceVersion ?? '0.0.0',
              ...(endpoint === undefined ? {} : { endpoint }),
            });
          },
        },
        {
          provide: METRICS,
          useFactory: (): Metrics => createMetrics(options.serviceName),
        },
      ],
      exports: [METRICS, TRACING],
    };
  }
}
