import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Every label any metric here is allowed to carry.
 *
 * **The budget is the contract.** A label is a dimension, and a dimension with
 * unbounded values is one time series per value — a user id as a label is one
 * series per user, forever, and it is the ordinary way a metrics backend is
 * destroyed by an application that meant well.
 *
 * So: no user id, no organization id, no file name, no path with an id in it.
 * Route labels are the route *template* Fastify already knows
 * (`/api/v1/notes/:id`), never the URL that was requested. A test asserts every
 * registered metric's labels against this list, because it is a rule that is
 * broken by accident rather than on purpose.
 */
export const ALLOWED_LABELS: ReadonlySet<string> = new Set([
  // The route template, never the URL.
  'route',
  'method',
  'status',
  // A queue's name, a job's name, an outbox row's state, a delivery's outcome:
  // each is a value from a list the code itself decides.
  'queue',
  'job',
  'state',
  'outcome',
  'entitlement',
  // Which process the number came from, so two replicas are two series and not
  // one that flickers.
  'service',
]);

/**
 * Labels the Node runtime's own metrics carry, which are not ours to budget.
 *
 * `collectDefaultMetrics` brings event loop lag, heap and handle counts — the
 * first things anybody asks for when a service is slow and nothing in its own
 * numbers explains it. Their labels are the V8 heap space names and the Node
 * version, both from short fixed lists.
 *
 * Named separately rather than folded into the budget above, so the budget
 * keeps saying what *this* code is allowed to do.
 */
export const RUNTIME_LABELS: ReadonlySet<string> = new Set([
  'space',
  'type',
  'version',
  'major',
  'minor',
  'patch',
  'quantile',
  'le',
]);

/** Buckets in seconds, from a fast route to one that should have timed out. */
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export interface Metrics {
  readonly registry: Registry;
  readonly requestDuration: Histogram<'route' | 'method' | 'status'>;
  readonly requestsInFlight: Gauge<'service'>;
  readonly queueDepth: Gauge<'queue' | 'state'>;
  readonly outboxRows: Gauge<'state'>;
  readonly idempotencyConflicts: Counter<'route'>;
  readonly quotaRejections: Counter<'entitlement'>;
  readonly webhookDeliveries: Gauge<'outcome'>;
  readonly backupAgeSeconds: Gauge<never>;
}

/**
 * The numbers somebody is woken up for, and nothing invented beside them.
 *
 * Each one answers a question an operator actually asks: is work arriving
 * faster than it is done, has delivery stopped, is a client retrying something
 * that is not idempotent, is a tenant at a ceiling it does not know about, is
 * an endpoint dead-lettering, and is the thing that makes a restore possible
 * still happening.
 *
 * A registry per call rather than the global one: two of these in one process
 * would throw on the second registration, and a test that had to reach into
 * global state would leak into the next one.
 */
export function createMetrics(service: string): Metrics {
  const registry = new Registry();

  registry.setDefaultLabels({ service });

  // Event loop lag, heap, handles. Cheap, and the first thing anybody asks for
  // when a service is slow and nothing in its own numbers explains it.
  collectDefaultMetrics({ register: registry });

  return {
    registry,
    requestDuration: new Histogram({
      name: 'http_request_duration_seconds',
      help: 'How long a request took, by route template and status.',
      labelNames: ['route', 'method', 'status'],
      buckets: DURATION_BUCKETS,
      registers: [registry],
    }),
    requestsInFlight: new Gauge({
      name: 'http_requests_in_flight',
      help: 'Requests this instance is currently handling.',
      labelNames: ['service'],
      registers: [registry],
    }),
    queueDepth: new Gauge({
      name: 'queue_depth',
      help: 'Jobs in a queue, by state.',
      labelNames: ['queue', 'state'],
      registers: [registry],
    }),
    outboxRows: new Gauge({
      name: 'outbox_rows',
      help: 'Outbox records by state. A rising PENDING means delivery stopped.',
      labelNames: ['state'],
      registers: [registry],
    }),
    idempotencyConflicts: new Counter({
      name: 'idempotency_conflicts_total',
      help: 'Requests that reused a key with a different body.',
      labelNames: ['route'],
      registers: [registry],
    }),
    quotaRejections: new Counter({
      name: 'quota_rejections_total',
      help: 'Requests refused because an organization was at its ceiling.',
      labelNames: ['entitlement'],
      registers: [registry],
    }),
    webhookDeliveries: new Gauge({
      name: 'webhook_deliveries_recent',
      help: 'Delivery attempts in the last hour, by outcome. A gauge and not a counter: the table records every attempt ever made, and "how many have ever failed" answers nothing.',
      labelNames: ['outcome'],
      registers: [registry],
    }),
    backupAgeSeconds: new Gauge({
      name: 'backup_age_seconds',
      help: 'How long ago the last backup completed. Rising means it stopped.',
      registers: [registry],
    }),
  };
}

/**
 * Every label name the registry's metrics declare.
 *
 * Read from the registry rather than from the definitions above, so a metric
 * registered somewhere else — by a library, or by a future feature — is still
 * checked against the budget.
 */
export async function labelsIn(registry: Registry): Promise<Set<string>> {
  const names = new Set<string>();

  for (const metric of await registry.getMetricsAsJSON()) {
    for (const label of metric.values.flatMap((value) =>
      Object.keys(value.labels),
    )) {
      names.add(label);
    }
  }

  return names;
}
