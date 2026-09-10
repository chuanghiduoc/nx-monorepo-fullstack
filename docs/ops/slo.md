# Service objectives, and the drill that measured two of them

An objective nobody has tested is a number somebody made up. Two of the four
below were measured by running them; the other two are targets, and this
document says which is which.

## Availability

**Target: 99.9% of requests to `/api/*` answer without a 5xx, over 30 days.**

That is 43 minutes of error budget a month. It is a target rather than a
measurement: this workspace has not run long enough anywhere to have a number.

The budget is what makes it a decision rather than a slogan. Spend it and the
next change is a fix, not a feature.

Measured from `http_request_duration_seconds`, which carries `status` — the
ratio of `status=~"5.."` to all of them, by route template. Not from the edge's
logs: a request the API never saw is the edge's problem and needs a different
fix.

## Latency

**Target: the 95th percentile of `/api/*` under 300 ms, excluding the streams.**

Excluding the streams because they are supposed to stay open: `/api/v1/realtime/stream`
and `/api/v1/ai/ask` last as long as somebody is watching, and including them
would make the percentile meaningless in the direction that hides real
regressions.

Measured from the same histogram, whose buckets go to ten seconds — a request
that takes longer than that is a timeout somewhere and belongs in the top
bucket, not in a percentile.

## Recovery — measured

Both numbers come from a drill run against `docker-compose.prod.yml`, not from
an estimate. It was run twice: once on an empty database and once on one with
volume.

### What the drill did

1. Brought up the full stack — seven containers, behind the edge.
   For the second run, seeded 200,000 notes, 100,000 outbox rows and forty
   256 KB uploads first — 172 MB of database and 10.2 MB of objects.
2. Created an account, an organization, a note and an uploaded file; the file
   was scanned to `READY` by the worker.
3. Ran `tools/scripts/backup.sh`.
4. Wrote **one more note, after the backup**, to have something the restore is
   supposed to lose.
5. Ran `tools/scripts/restore.sh` with only the two files the backup produced.
6. Checked the application.

### What came back

| | |
| --- | --- |
| The note written **before** the backup | present |
| The note written **after** the backup | **gone** — this is the RPO, demonstrated |
| The uploaded file's record | present, `READY` |
| The uploaded file's **bytes** | downloaded through a signed URL; PNG magic number intact |
| The session cookie from before the drill | still valid |

### The numbers

The drill was run twice: once on an empty database to prove the procedure, and
again on one with volume, because a number from an empty database is not a
number.

| | Empty | **With volume** |
| --- | --- | --- |
| Database | ~1 MB | **172 MB** — 200,014 notes, 100,014 outbox rows |
| Object store | 387 bytes | **10.2 MB** across 40 uploads |
| Dump produced | 88 KB | **8.1 MB** |
| **Backup** | 2 seconds | **2 seconds** |
| **RTO** | 17 seconds | **28 seconds** — answering 200 the moment the script returned |
| **RPO** | the age of the last backup | the same, demonstrated again |

Everything came back: all 200,014 rows, the whole object store, and a 262,177-byte
upload downloaded through a signed URL with its PNG header intact. The note
written *after* the backup was gone from both runs — which is the RPO, shown
rather than asserted.

**These are still this machine's numbers, on one host, with a local disk.**
What scales badly is not the dump — 172 MB compressed to 8 MB in two seconds —
but the restore, which grew from 17 to 28 seconds for a hundred-and-seventy-fold
increase in data. Extrapolating from two points is how people get RTOs wrong;
re-run it on the volume you actually have.

What the drill proves regardless of the numbers is that the procedure is
**complete**: the two files the backup produced were sufficient, nothing else
was needed, and the application worked afterwards.

### What the drill did not cover

- **Point-in-time recovery.** There is none. The RPO is the backup interval, and
  narrowing it means WAL archiving and a different restore procedure.
- **A host that is gone.** The drill restored onto the same machine. Restoring
  onto a new one adds provisioning time to the RTO — usually more than the
  restore itself.
- **A restore of an S3-backed deployment.** The object half of the backup is the
  local driver's volume. A managed bucket is backed up where it lives, and its
  restore is that provider's procedure.

`docs/ops/dashboards.md` has the panels these numbers are read from, as the
queries that produce them. `docs/ops/capacity.md` has what the stack costs to
run at a measured load, and the command that measures it again.

## What to alert on

In the order somebody should be woken for them:

| Signal | Why |
| --- | --- |
| `backup_age_seconds` above two intervals | the thing that makes all of the above possible has stopped |
| `outbox_rows{state="PENDING"}` rising and not falling | delivery has stopped; events are piling up |
| `outbox_rows{state="DEAD"}` above zero | something was given up on, and nothing else will say so |
| `queue_depth{state="failed"}` rising | jobs are failing faster than they are retried |
| 5xx ratio above the budget's burn rate | the availability objective is being spent |
| `webhook_deliveries_recent{outcome="unreachable"}` dominating | a customer's endpoint is down, or ours cannot reach it |

`quota_rejections_total` and `idempotency_conflicts_total` are not alerts. They
are the numbers to look at when a customer says something is broken and nothing
else explains it.
