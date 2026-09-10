import { Controller, Get, Header, Inject } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SignedRequest } from '@workspace/core-server-core';
import { METRICS, type Metrics } from '@workspace/core-server-observability';

import { MetricsCollector } from './metrics.collector';

/** What a Prometheus scraper expects to be handed. */
const PROMETHEUS_TEXT = 'text/plain; version=0.0.4; charset=utf-8';

/**
 * The scrape.
 *
 * **Closed at the edge, not here.** The Caddyfile answers 404 for this path
 * from outside, and 404 rather than 403 because a 403 confirms the route
 * exists. Inside the network it is open, because a scraper is a machine with no
 * session and giving it a credential to manage is a credential to leak.
 *
 * The numbers are not secret in themselves; the shape is. An unauthenticated
 * endpoint that enumerates every route and every queue is a map of the service
 * handed to whoever asks for it.
 *
 * **Excluded from the OpenAPI document**, because it is not part of the API's
 * contract: no client calls it, and publishing it would invite one to.
 */
@ApiExcludeController()
// Nothing here reads a session, so there is no ambient authority for a
// cross-site page to borrow — and the origin check would otherwise refuse a
// scraper, which sends no `Origin` at all.
@SignedRequest()
@Controller({ path: 'metrics' })
export class MetricsController {
  private readonly metrics: Metrics;
  private readonly collector: MetricsCollector;

  constructor(
    @Inject(METRICS) metrics: Metrics,
    @Inject(MetricsCollector) collector: MetricsCollector,
  ) {
    this.metrics = metrics;
    this.collector = collector;
  }

  @Get()
  @Header('content-type', PROMETHEUS_TEXT)
  async scrape(): Promise<string> {
    // The numbers that live in the database or in Redis are read here rather
    // than on a timer: a timer is a second thing to tune and a query nobody is
    // reading, and a scrape is every fifteen seconds anyway.
    await this.collector.collect();

    return this.metrics.registry.metrics();
  }
}
