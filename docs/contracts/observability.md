# Contract: observability

One id, a handful of deliberate spans, and a metric list short enough that
every entry answers a question somebody asks out loud.

## One id, four places

A request id is a UUID — sixteen bytes. A trace id is sixteen bytes. They are
**the same sixteen bytes**, in the two spellings each system uses:

| Where | Spelling |
| --- | --- |
| `x-request-id` response header | `0199a1b2-0000-7000-8000-00000000000a` |
| `traceId` in a problem document | the same |
| `reqId` in every log line | the same |
| the trace | `0199a1b200007000800000000000000a` |

So "find the trace for this error" is a lookup rather than a search. Strip the
dashes.

Two exceptions, both deliberate:

- **An inbound `traceparent` wins.** The caller is already inside a trace, and
  starting another would break the join this exists to make. The request id is
  still on the span as `request.id`.
- **A request id that is not a UUID gets a random trace.** `x-request-id` is
  honoured from the caller, so it can be any string; building a trace id from
  one of those makes a trace nothing can look up.

## The spans that exist, and the ones that do not

**Instrumented by hand.** `@opentelemetry/auto-instrumentations-node` works by
patching `Module._load` through `require-in-the-middle`, and both applications
are bundled into one file with `externalDependencies: 'none'` — there are no
module boundaries left to patch. It would produce a working SDK and no spans,
and an empty dashboard because nothing is instrumented looks exactly like an
empty dashboard because nothing is happening.

Measured, against the artifact that ships: the SDK itself works fine in the
bundle. A `GET /api/v1/notes` span reached a collector from
`apps/core/api/dist/main.js`. So the constraint was never "tracing or the
single-file image" — only which spans exist.

These do:

| Span | Kind | Where |
| --- | --- | --- |
| `GET /api/v1/notes` | server | every HTTP request, named by route template |
| `enqueue <queue>/<job>` | producer | `QueueService.enqueue` |
| `consume <queue>/<job>` | consumer | every job a worker runs |
| better-auth's own | various | it speaks `@opentelemetry/api` and picks up our provider |

These do not, and looking for them is a waste of an afternoon: outbound HTTP
calls, Redis round trips, individual SQL statements. If following a real problem
needs one, the answer is another explicit span at that boundary — not a return
to patching a bundle that cannot be patched.

### Across the queue, and across the outbox

`enqueue` puts the active trace's `traceparent` into the job envelope, which has
carried that field since version 1. `consume` restores it.

That alone was not enough, and finding out took running it: a write does not
enqueue anything. It appends to the **outbox**, and the relay picks that row up
in a different process minutes later. The queue link joined the relay's own pass
to the consumer, and the request that caused all of it was a separate picture.

So `outbox_events` carries a `trace_parent` column. The request writes it, the
relay restores it before fanning out, and one trace now holds all of this —
measured against the production stack with a collector:

```
POST /api/v1/notes                    core-api
  GET /get-session, db findOne user…  core-api   (better-auth's own)
  enqueue events/deliver              core-worker
  enqueue webhook-dispatch/deliver    core-worker
  consume events/deliver              core-worker
  consume webhook-dispatch/deliver    core-worker
```

The column is nullable and has to be: every row written before it existed has no
trace, and neither does an event a schedule caused. A `NOT NULL` with a default
would be a default that lies — a `traceparent` pointing at a trace that never
existed is worse than none, because a reader follows it.

A scheduled job has no request behind it and starts a trace of its own.

## `/metrics`

`GET /api/metrics`, Prometheus text, **404 at the edge**.

404 rather than 403: a 403 confirms the route exists, which is half of what
somebody asking for it wanted. Inside the network it is open, because a scraper
is a machine with no session and giving it a credential to manage is a
credential to leak. The numbers are not the secret — the shape is. An
unauthenticated endpoint enumerating every route and every queue is a map of the
service.

### The cardinality budget is the contract

A label is a dimension, and a dimension with unbounded values is one time series
per value. A user id as a label is one series per user, forever.

**Allowed:** `route`, `method`, `status`, `queue`, `job`, `state`, `outcome`,
`entitlement`, `service`. Plus what the Node runtime's own metrics carry:
`space`, `type`, `version`, `major`, `minor`, `patch`, `quantile`, `le`.

**`route` is the route template**, `/api/v1/notes/:id`, never the URL. A request
that matched nothing is labelled `unmatched`. Both are asserted end to end, and
both fail if the label becomes the URL — proven with a negative control.

### What is measured

| Metric | The question it answers |
| --- | --- |
| `http_request_duration_seconds` | is it slow, and where |
| `http_requests_in_flight` | is it stuck |
| `queue_depth{queue,state}` | is work arriving faster than it is done |
| `outbox_rows{state}` | has delivery stopped and are events piling up |
| `webhook_deliveries_recent{outcome}` | is an endpoint down |
| `idempotency_conflicts_total{route}` | is a client retrying something that is not idempotent |
| `quota_rejections_total{entitlement}` | is a tenant at a ceiling it does not know about |
| `backup_age_seconds` | has the thing that makes a restore possible stopped |

`backup_age_seconds` is **absent** until a backup has run, never zero — a gauge
at zero reads as "a backup finished just now". `tools/scripts/backup.sh` writes
`app:backup:last-completed` to the queue's Redis, which is the instance checked
at boot for `noeviction`, so the key cannot be evicted out from under the alert.

`webhook_deliveries_recent` is a **gauge over the last hour**, not a counter.
The table records every attempt ever made, so "how many have ever failed" only
goes up and answers nothing; "how many failed in the last hour" is the question
somebody asks at three in the morning.

### Collected on the scrape, through two views

Queue depth, outbox state and delivery outcomes live in Redis and in the
database, and are read when somebody scrapes rather than on a timer — a timer is
a second thing to tune and a query nobody is reading.

The two database aggregates go through **views**, and that is not a style
choice. Measured: the application role cannot read `outbox_events` at all
(`permission denied`, and rightly — the outbox is the worker's), and
`webhook_deliveries` is behind row-level security that a system transaction with
no tenant reads as **empty** — which is worse than a refusal, because a gauge
reading zero looks exactly like a gauge with nothing to report.

`outbox_state_counts` and `webhook_delivery_outcomes` expose counts and nothing
else: no row, no payload, no organization id, and no `WHERE` a caller can
influence. Granting `SELECT` on the tables would have been one line and would
have handed the API every tenant's event payloads.

**Every state is published, including the empty ones.** A gauge that disappears
when its state empties is indistinguishable on a dashboard from one that stopped
being collected, and the two need opposite responses.

### The worker serves no metrics

Deliberately: a worker that can serve a request is an API with a confusing name,
and the two would then have to be deployed, scaled and secured as one thing. So
everything scrapable is readable from the database or from Redis — and all of it
is. The worker does trace, because a trace that stopped at the queue would be
half a picture.

## Configuration

| Variable | Meaning |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | the collector's base address; unset means nothing is traced |

`pnpm dev:obs` starts Grafana, Loki, Tempo and Prometheus in one container, with
OTLP on 4318. `docs/ops/dashboards.md` has the panels worth building, written as
the queries that produce them.

A deployment with no collector is a supported state, not a broken one: every
request still carries an id and that id is still in every log line. What it
loses is the join across processes.

## How it is proven

- **Against the artifact that ships** — the bundled `dist/main.js`, run with a
  collector on loopback: a route span arrived, and the route label was the
  template.
- **The trace id derivation**, both ways, including a request id that is not a
  UUID and the all-zero id that means "no trace".
- **Continuation** — a `traceparent` from a caller is honoured; a job carries the
  trace and the consumer restores it.
- **Errors** — a span that threw is marked, carries the exception, and still
  ends; a 404 is *not* marked, because marking every refusal red makes the
  colour stop meaning anything.
- **Tracing switched off** runs the work and produces nothing, without throwing.
- **The budget**, twice: against the registry in a unit test, and against the
  text the running service publishes in the e2e suite. The negative control —
  labelling by URL instead of template — turns both red.
