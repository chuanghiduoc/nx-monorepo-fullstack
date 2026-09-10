# Capacity, measured

The design estimated **1–2 GB** for the whole stack at idle to light load, and
called that "an estimate, not a commitment". This is the measurement.

```sh
pnpm prod:up
pnpm prod:smoke                       # 30s at 20 concurrent, 2,000-note dataset
node tools/scripts/smoke.mjs --seconds 60 --concurrency 50
```

## What the run does

It creates its own account and organization, seeds a dataset **through the API**
rather than with SQL — the write path is half of what the memory belongs to —
then reads at a fixed concurrency for a fixed time. Memory and CPU come from
`docker stats` before and after; the latency comes from the service's own
histogram, **differenced** against a snapshot taken before the load, so a stack
that has been up for a week does not report the week's latency.

It reads `/api/metrics` from inside the container. The edge answers 404 for that
path on purpose, so going through the edge would measure the 404.

## Measured: 20 concurrent readers, 20 seconds, 2,000 notes

| | |
| --- | --- |
| Requests | 2,774 |
| Throughput | **138 requests/second** |
| Outcomes | 2,774 × 200 |
| Error rate | **0.00%** |
| p95 (`GET /api/v1/notes`) | **≤ 250 ms** — the bucket the 95th percentile falls in |
| Seed | 2,000 notes through the API in 15.9 s (≈126 writes/second) |

### Memory, before → after

| Container | Before | After |
| --- | --- | --- |
| api | 459.5 MiB | **598.9 MiB** |
| worker | 206.2 MiB | 205.5 MiB |
| web | 55.0 MiB | 55.1 MiB |
| edge (Caddy) | 37.7 MiB | 52.0 MiB |
| postgres | 125.3 MiB | 101.9 MiB |
| redis-critical | 12.3 MiB | 13.1 MiB |
| redis-cache | 10.2 MiB | 10.6 MiB |
| **Total** | ~907 MiB | **~1,037 MiB** |

**About 1.0 GB under this load**, which puts the design's 1–2 GB estimate at the
bottom of its own range. CPU stayed under 3% per container throughout, so the
limit reached here was neither memory nor processor — it was one client on one
machine driving twenty connections.

## What these numbers are not

- **Not a capacity limit.** Nothing was saturated. The run says "this is what it
  costs to do this", not "this is all it can do". Finding the ceiling needs the
  load generator on a different machine from the stack.
- **Not a latency SLO.** `docs/ops/slo.md` targets a p95 under 300 ms and this
  run sits inside that, but on a dataset of 2,000 rows and with no other tenant
  competing.
- **Not comparable across machines.** This was a developer laptop running the
  stack, the database, the load generator and everything else at once.
- **Not the memory ceiling.** `docker-compose.prod.yml` sets no limits
  deliberately — see `docs/ops/production.md`. These numbers are what to size
  them from, with headroom for the peak a build or a large upload adds.

## Re-running it honestly

Change one thing at a time and record all of it:

```sh
node tools/scripts/smoke.mjs --seconds 60 --concurrency 50   # more load
SMOKE_SEED=50000 node tools/scripts/smoke.mjs                # more data
```

`SMOKE_SEED` seeds through the API, so a large number takes minutes. That is the
honest cost of not seeding with SQL, and the reason the default is 2,000.

The number worth watching as the dataset grows is not throughput — it is the
**api** container's memory, which is where a query that stopped using an index
shows up first.
