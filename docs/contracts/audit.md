# Contract: the audit trail

Every domain event that reaches the outbox becomes a row in `audit_records`.
The trail is written by a consumer, never by a request, and that is the whole
of its integrity story.

## What it promises

**One row per event, forever, written by the process that delivered it.**

Not "every action a user took" — an action that raises no event leaves no
trace here. The trail's coverage is exactly the set of events the domain
appends, so widening it means appending an event, not calling a logger.

## Why a consumer and not the API

The obvious design writes the audit row in the request that caused it. It is
wrong for two reasons, and both are load-bearing:

- **The row would be optional.** A request that writes its own audit row can
  fail between the business write and the audit write, or skip the call in a
  code path nobody remembered. Deriving the trail from the outbox makes it
  structural: the event committed with the aggregate, so the record follows or
  the whole write did not happen.
- **The writer would be reachable from the API.** `app_user` holds no
  privilege at all on `audit_records` — not `INSERT`, not `SELECT`. An
  injection through a request cannot read another tenant's trail, cannot forge
  a record, and cannot delete one. That is only true because no request path
  needs the grant.

## The record

| Column | What it is |
| --- | --- |
| `event_id` | the outbox event's id, `UNIQUE` |
| `event_type`, `aggregate_type`, `aggregate_id`, `aggregate_version` | copied from the event |
| `tenant_id`, `actor_id` | from the **envelope**, nullable for a system event |
| `occurred_at` | when the thing happened |
| `recorded_at` | when this row was written |
| `detail` | the event's payload, as it arrived |

`occurred_at` and `recorded_at` are separate on purpose and routinely differ.
The second is the relay's clock plus the queue's delay plus however long a
retry took; a trail that reported only that would say a note was created an
hour after it was, and a reclaimed re-enqueue would move the number again. Only
`occurred_at` is stable per event.

`tenant_id` comes from the envelope rather than the payload because the
envelope is what the queue guarantees is present. It is **data** in this table,
not a scope: `audit_records` carries no row-level security policy, and the
consumer opens a *system* transaction. Reading the trail per tenant is a
filter a future route writes, and that route has to bring its own grant.

### An unknown event type is still recorded

`detail` is stored as it arrived and nothing validates `event_type` against a
list. Refusing what this code cannot interpret would lose precisely the events
that most need recording — the new ones, during the deploy that introduced
them. An audit trail's job is to record, not to interpret.

### What must never be in `detail`

The outbox contract's rule applies here and harder: **metadata, never content**.
A payload lives in `outbox_events` for a week; a copy of it lives in
`audit_records` with no retention at all. Putting a note's body in an event
means its text outlives every erasure mechanism that knows about notes, in a
table nothing sweeps.

## Delivering exactly once

The claim and the record are written in **one system transaction**:

```
withSystemTransaction:
  processed_events.claim('audit', eventId)   ── false? return, do nothing
  audit_records.record(...)                  ── ON CONFLICT (event_id) DO NOTHING
```

The claim is what makes at-least-once delivery arrive as one row. It has to be
in the same transaction as the record — not before it and not after it — or a
crash between the two leaves an event claimed and unrecorded, which no retry
ever fixes.

The unique index on `event_id` is a **backstop, not the mechanism**. When the
consumer claims an event and then finds the trail already holding it, the two
are out of step in a way that should be impossible, and it logs at error level
and **commits anyway**: the end state is one record and one claim, while
rolling back would redeliver the same event forever.

That state is reachable — two replicas disagreeing about the retention window,
one sweeping a dedup row the other still considers replayable — which is why
the log line exists rather than an assertion.

`ON CONFLICT (event_id) DO NOTHING` rather than a bare insert for the same
reason: an exception thrown from inside a queue handler is retried five times
and dead-lettered, so the constraint firing would be reported as a delivery
failure instead of as the thing it actually is.

## Raw SQL, and why

`AuditRepository.record` is `$executeRaw`, like the outbox and the dedup
repositories. Three separate reasons, each of which alone would be enough:

- Prisma's `create()` has no `ON CONFLICT` API.
- `create()` always emits `RETURNING`, which needs `SELECT` on the returned
  columns — a distinction that has already cost this workspace one bug, in a
  grant that looked satisfied because the test ran as the owner.
- The signature carries no Prisma type. `type:app` bans `@prisma/*`, so a
  `Prisma.InputJsonValue` in `AuditEntry` would fail lint in the worker that
  calls it, and the natural way to make that error go away is to widen the
  boundary.

`worker_user` needs `SELECT` as well as `INSERT`, and it is not headroom:
measured on PostgreSQL 18, `INSERT ... ON CONFLICT (event_id) DO NOTHING`
fails with `permission denied` without it, because a conflict target is an
inference specification that reads the table. An audit of the grants that
removed `SELECT` as unused would break every insert — inside the consumer's
transaction, only where the grants are real, and never in a test.

## Who may touch what

```
app_user                 audit_records  —
worker_user              audit_records  INSERT, SELECT
erasure_role             audit_records  SELECT, UPDATE (actor_id, detail)
cross_tenant_admin_role  audit_records  —
```

`cross_tenant_admin_role` getting nothing is the entry that will look wrong. A
support role reading the trail is a reasonable thing to want; it is not
reasonable for it to happen because nobody revoked a default privilege. It is
granted when there is a route that uses it and a decision about which tenants
it may read.

**Nothing holds `DELETE`,** and the one `UPDATE` is column-level and belongs to
a role no application connects as. A trail whose writer can rewrite it is not a
trail: `worker_user` writes it and cannot edit it, which means no consumer of
the outbox can.

## Retention

There is none. `audit_records` is the one table here that grows without bound,
deliberately: it is evidence, and the events it records are metadata-sized.

Two consequences to be honest about:

- **It will need partitioning.** Not yet — at the volumes this workspace is
  built for, a single table with a unique index on `event_id` is correct and
  anything else is speculation. When it does, the partition key is
  `occurred_at`, because that is the column every query filters on and the one
  a drop-a-partition retention policy would use.
- **Erasure reaches it, and only erasure does.** `erasure_role` holds
  `UPDATE (actor_id, detail)` and nothing else on this table — no other role
  may edit a record at all, so the trail's immutability is a permission rather
  than a convention. An erasure clears the actor and replaces the detail while
  keeping the row; a delete is not the answer, because a trail with holes in it
  is not a trail. See `erasure.md`.

## The consumer's name is a primary key

`AUDIT_CONSUMER = 'audit'` is half of the primary key in `processed_events`.
Renaming it does not rename the rows already there, so every event this
consumer has ever handled would look unhandled and the entire history would be
processed again. It is a constant for that reason, and a test asserts the
value that reaches the database.

## Covered by

- `apps/core/worker/src/app/outbox/audit.consumer.spec.ts`
- `libs/core/server/platform/data-access-db/src/lib/outbox/outbox.repository.spec.ts` (the grant matrix)
