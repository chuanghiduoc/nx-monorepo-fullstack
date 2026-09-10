# Dashboards

Panels worth having, written as the queries that produce them. **Queries rather
than a dashboard JSON export**, deliberately: an export is a thousand lines of
Grafana's own schema that nobody reviews and that rots the first time a metric is
renamed. Every query below names a metric this service actually publishes — the
list is in `docs/contracts/observability.md` — so a rename breaks the query
visibly rather than leaving a panel that quietly shows nothing.

`pnpm dev:obs` starts Grafana, Prometheus, Loki and Tempo in one container.
Prometheus scrapes `http://api:3000/api/metrics`; the route is 404 at the edge
and open inside the network.

## Is it up, and is it healthy

**Request rate, by outcome.** The shape of normal traffic, and the first place a
deploy shows up.

```promql
sum by (status) (rate(http_request_duration_seconds_count[5m]))
```

**Error ratio.** This is the availability objective in `docs/ops/slo.md`; put the
0.1% line on it.

```promql
sum(rate(http_request_duration_seconds_count{status=~"5.."}[5m]))
  / sum(rate(http_request_duration_seconds_count[5m]))
```

**Latency, 95th percentile, by route.** Excluding the streams, which are
supposed to stay open — including them makes the percentile meaningless in the
direction that hides real regressions.

```promql
histogram_quantile(0.95, sum by (le, route) (
  rate(http_request_duration_seconds_bucket{route!~"/api/v1/realtime/.*|/api/v1/ai/ask"}[5m])
))
```

**In flight.** A number that climbs and does not come back down is a service
that is stuck rather than slow, and the two need opposite responses.

```promql
sum by (service) (http_requests_in_flight)
```

## Is the work getting done

**Queue depth.** The single most useful panel here: waiting climbing while
active is flat means work is arriving faster than it is done.

```promql
sum by (queue, state) (queue_depth)
```

**The outbox.** `PENDING` rising and not falling means delivery has stopped.
`DEAD` above zero means something was given up on, and nothing else will say so.

```promql
sum by (state) (outbox_rows)
```

**Webhook outcomes, last hour.** A gauge rather than a counter, because the
table records every attempt ever made — see the contract for why.

```promql
sum by (outcome) (webhook_deliveries_recent)
```

## Is anybody being refused

Neither of these is an alert. They are what to look at when a customer says
something is broken and nothing else explains it.

```promql
sum by (entitlement) (rate(quota_rejections_total[15m]))
sum by (route) (rate(idempotency_conflicts_total[15m]))
```

## Is the safety net still there

**Backup age.** The most important panel on this page and the least interesting
to look at. The common failure is not a corrupt backup — it is a backup that
quietly stopped running three weeks ago.

```promql
backup_age_seconds
```

`tools/scripts/backup.sh` writes the timestamp to the queue's Redis on its way
out, and the collector reads it on every scrape.

**Alert on the series being absent, not on it being large.** With no key the
series does not exist, deliberately: a gauge at zero reads as "a backup finished
just now", which is the one direction this must never be wrong in.

```promql
absent(backup_age_seconds)
```

## The runtime, when nothing else explains it

```promql
nodejs_eventloop_lag_p99_seconds
process_resident_memory_bytes
nodejs_active_handles_total
```

Event loop lag is the one that explains "the service is slow and every query is
fast".

## Alerts

`docs/ops/slo.md` has the list, in the order somebody should be woken for them.
Two rules about turning these panels into alerts:

- **Alert on symptoms, not causes.** "The error ratio is above the burn rate" is
  a symptom. "Queue depth is above 100" is a cause, and it is only worth waking
  somebody for when it is still climbing an hour later.
- **Every alert names the panel that explains it.** An alert nobody can act on
  in the first minute trains people to silence the next one.

## Why there is no dashboard JSON in this repository

A Grafana export pins panel ids, datasource uids and a schema version, none of
which mean anything in another installation — so it is either edited by hand,
which nobody reviews, or re-exported from a running Grafana, which makes the
repository a copy of somebody's local state.

The queries above are the part that carries the knowledge. Paste them into
whatever Grafana you have; if one returns nothing, the metric was renamed and
the query is doing its job by failing where you can see it.
