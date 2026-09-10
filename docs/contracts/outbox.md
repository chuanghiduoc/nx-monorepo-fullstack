# Contract: the outbox

An event is written in the same transaction as the thing it describes. That is
the whole mechanism, and everything else here follows from it.

## What it promises

**At-least-once, unordered, and consumers must be idempotent.**

Not "exactly once", and not "in order". The claim is FIFO and the delivery is
not: a batch is enqueued in order and handed to as many concurrent workers as
`WORKER_CONCURRENCY` allows, so two events for one aggregate arriving the wrong
way round is ordinary rather than exceptional. A consumer must never infer
order from either end.

## Why there is no "did the event get sent" failure

`append()` runs inside the caller's transaction. The aggregate and the event
commit together or neither does, so the pair cannot disagree — there is no
window in which the note exists and the event does not, and no compensating
action to write.

That is why `append()` **refuses to open a transaction of its own**, which is
the opposite of what every other repository here does. One that opened its own
would commit the event separately, which is the single failure this exists to
remove. Called outside a transaction it throws and says what to do.

It also refuses a transaction that knows a user but no organization. Such an
event would carry a null tenant, indistinguishable from one the system raised
for itself, and a consumer reading that opens a system transaction and handles
a tenant's event with no tenant scoping.

## The states

```
PENDING ──claim──> PROCESSING ──delivered──> ENQUEUED ──retention──> gone
   ^                    │
   └──failed, attempts left──┘
                        │
                        └──attempts spent──> DEAD
```

- **PENDING** — due at `available_at`, waiting for a relay.
- **PROCESSING** — claimed. `locked_at` is both the lease clock and the fencing
  token.
- **ENQUEUED** — on the queue. Not terminal: a row inside the retention window
  can be replayed.
- **DEAD** — the attempts are spent. Never swept, because a dead event is
  evidence.

A `DEAD` row means **undelivered or unconfirmed**. A relay that keeps dying
between the enqueue and the mark walks a successfully delivered event to the
ceiling. Confirming which it is means looking in `processed_events`.

## Delivering once

**`jobId` deduplication is an optimisation, not the guarantee.** The relay
enqueues under the event's own id, so a reclaimed re-enqueue is a no-op — while
the completed job is still there. Measured on BullMQ 6.3.4 with this queue's
options: a job id stops deduplicating once the completed job is cleaned up,
which is `removeOnComplete: { age: 3600, count: 1000 }` — an hour, or a
thousand completed jobs on that queue, whichever comes first. Past either, the
same event was handled twice.

**The guarantee is `processed_events`**, written by the consumer inside its own
transaction alongside whatever the event causes. A second delivery finds the
row and does nothing.

That has a hard edge: it is correct **only** for a consumer whose whole effect
is a write to this database. One that sends an email or calls a webhook cannot
put its effect in the same transaction as the record of having done it, and
gets at-least-once with no deduplication. Webhooks are exactly that case and
will need their own answer.

`OUTBOX_LEASE_MS` is bounded at both ends and neither bound is fully checkable
at boot:

- **above** the worst enqueue round trip, or two relays claim the same row;
- **below** the deduplication window, or every reclaim is a real second
  delivery.

The relay asserts both bounds at boot: the upper against
`QueueService.dedupWindowMs`, and the lower against
`OUTBOX_ENQUEUE_TIMEOUT_MS`, because a lease shorter than the time an enqueue
is allowed to take expires while that enqueue is still in flight.

The bound that usually binds is not a duration at all — at a hundred events a
second, a thousand completed jobs pass in ten — and no boot check can see it.
So the relay's reclaim warning carries both numbers, because a reclaim is when
a second delivery becomes possible and that line is what somebody reads when a
consumer has seen something twice. Whether a particular re-enqueue *was* a
second delivery is not observable from here; the consumer's own record is what
makes it not matter.

## What a payload carries

Metadata, never content.

A payload sits in `outbox_events` for the retention window and a consumer
copies what it derived into records kept longer still, while erasure is a
separate mechanism that knows about neither. Putting a note's text in an event
means that for a week after somebody deletes that note its full text survives
in a table no erasure procedure covers — and forever in a `DEAD` row. A
consumer that needs the record reads the aggregate, which is also the only
version of it that is still true.

There is a 64 KB ceiling, enforced in `append()` and again as a check
constraint. It is a backstop rather than a working limit: a metadata payload
cannot approach it, and a payload that does is carrying something it should not.

Both measure `octet_length(payload::text)`, and that took a second migration to
get right. The first constraint used `pg_column_size`, which is the *stored*
size of the jsonb — binary headers for a many-keyed object, and the compressed
length once the value is large enough to compress. Measured on PostgreSQL 18, a
value whose text is 33 786 bytes stores as 15 112, so the two disagreed in both
directions. The direction that mattered was a payload the application accepted
and the database refused: a bare constraint violation inside the caller's
transaction, rolling back the user's write — precisely what the application-side
check exists to turn into a message naming the aggregate.

## The relay

A poll loop in the worker, not a scheduled job. A schedule exists to make
recurring work happen **once** across replicas; this wants the opposite — every
replica polling, taking disjoint rows under `FOR UPDATE SKIP LOCKED`, so
throughput grows with the number of workers.

One pass does four things, in this order:

1. **Give up** on rows whose relay died and whose attempts are spent. First,
   so exhausted rows stop being a filtered prefix the reclaim scans past.
2. **Reclaim** rows whose relay died with attempts to spare.
3. **Sweep** delivered rows past the retention window, on its own slower
   cadence.
4. **Claim** a batch, enqueue it, and record what happened.

The claim, the enqueue and the mark are **three transactions**. The transaction
contract forbids a network call inside one, and holding row locks across a
Redis round trip is why. The window that opens between the second and the third
is exactly what step 2 closes.

### The fencing token

`locked_at` is returned by the claim and repeated in the `WHERE` of both the
mark and the failure statement. Without it: relay A claims, its lease expires,
relay B reclaims and delivers and marks the row `ENQUEUED` — and then A's
enqueue finally times out and drags the row back to `PENDING` with
`enqueued_at` still set, a state the sweep can never clean and a delivery that
happens twice.

When the mark comes back short, the relay says so at warning level. It is
harmless — the other relay delivers them and the consumer's record absorbs it —
but a stream of it means the lease is shorter than the enqueue round trip.

### Failure has its own statement

A failed enqueue returns the batch to `PENDING` with an exponential
`available_at`, or to `DEAD` when the attempts are spent. Both in one statement,
because leaving an exhausted row at `PENDING` strands it: the claim's
`attempts < max` excludes it, the ceiling transition only looks at
`PROCESSING`, and the sweep only at `ENQUEUED` — so it sits at the head of the
claim's own ordering forever, filtered out on every tick, while nothing ever
reports that the work did not happen.

**The pacing signal is delivery, not the size of the claim.** A full batch that
failed to enqueue backs the loop off. Reading a full claim as a reason to run
again immediately is what turns a Redis outage into every event in the system
being taken to `PROCESSING` as fast as the database can answer.

Each enqueue carries a deadline. The queue's connection sets
`maxRetriesPerRequest: null` — BullMQ requires it — and ioredis then queues a
command against an unreachable server rather than rejecting it, so without a
deadline the failure path is unreachable code and the relay simply stops.

### Why the claim is ordered, when the retention sweep is not

Task 2 measured that an ordering no index can supply forces a sort under the
`LIMIT`, so the batch stops bounding the work. That premise does not hold here:
each branch of the claim has an index that already carries its ordering, and
measured at 200 000 rows the ordered claim is an index scan with no sort node,
stopping at the batch.

The ordering is also what makes starvation impossible. Unordered, rows come
back in physical order, so a row that keeps failing can be passed over on every
tick while lower blocks keep supplying a full batch.

`event_id` is the tiebreak because `now()` is transaction-stable: two events
appended in one business transaction share an `available_at` exactly, and that
is the case this table most exists for.

## Replay

`ENQUEUED` is not terminal, and neither is `DEAD`. A row inside the retention
window can be put back.

**Use `OutboxRepository.replay()`, not an `UPDATE`.** Resetting the status alone
leaves a `DEAD` row at the attempt ceiling, where the claim excludes it — never
delivered, while the operator sees the status change and believes it worked.
`replay()` resets the attempts, the lock and the error together, and refuses a
row outside the window.

The window is checked on `occurred_at`, not `enqueued_at`: a row that died on
the ceiling never enqueued successfully, so a guard on `enqueued_at` would
refuse every row replay exists to rescue.

It returns what it **refused** as well as what it took, with a reason. The
operator's ids come from the queue's failed set, which keeps a job for a
fortnight — twice as long as an event stays replayable — so reporting only
successes means pasting fourteen days of ids and being told nothing at all.

`replay()` runs as `worker_user`. `app_user` has no `SELECT` or `UPDATE` on the
table, so exposing it through an API route would fail on permissions — that is
a decision, not an oversight.

## Retention

`OUTBOX_RETENTION_HOURS` (168) for `ENQUEUED` rows, and **twice that** for
`processed_events`. A record of having processed an event must outlive the
event, or a replay at the edge of the window is processed a second time.

The two stamps are within milliseconds of each other and either may come first:
the job is on the queue as soon as `add` returns, and `enqueued_at` is written
by a later transaction, so a fast consumer can stamp `processed_at` before the
relay marks the row. The factor of two is what makes that irrelevant — a replay
can reach at most `enqueued_at + 168 h`, and the record it needs lives until
`processed_at + 336 h`.

The outbox sweeps on the relay's cadence rather than the retention job's,
because the arithmetic has to work:

```
OUTBOX_SWEEP_BATCHES × 1 000 / OUTBOX_SWEEP_EVERY_MS  >  OUTBOX_BATCH / OUTBOX_POLL_MS
          10         × 1 000 /       60 000 ms         >      100     /    1 000 ms
                    167 rows a second                  >   100 rows a second
```

Every delivered row becomes a row the sweep has to remove, so anything below
the delivery rate lets the outbox grow without bound inside its own retention
window — and adding replicas does not help, because it raises both sides
equally.

`processed_events` is swept on the same cadence, by the same pass, with **its
own budget rather than a share of the outbox's**. Splitting one budget between
the two tables would clear 83 rows a second against 100 written, which is the
same unbounded growth one step smaller. It moved off the hourly retention job
for the arithmetic above: its volume is the delivery rate one window later, so
a once-an-hour sweep loses to the relay for exactly the same reason.

That move is what forced a grant. The statement ran unlocked while one replica
swept per tick; on the relay it runs on every replica, and unlocked they
contend — measured, three concurrent sweepers removed exactly what one removes,
because the two that lose see an empty batch and stop for the whole tick. So it
takes `FOR UPDATE SKIP LOCKED`, and locking a row for update needs `UPDATE`,
which `DELETE` does not imply.

### Every bounded statement is a materialised CTE

Not `IN (SELECT ... LIMIT n)`. Measured on PostgreSQL 18: written that way, the
planner produced a `Nested Loop Semi Join` and re-executed the subquery once
per candidate row — and because each row it took stopped matching the
subquery's own predicate, every re-execution returned the *next* rows. A claim
asked for two took all five, and on a real table would take everything pending:
the unbounded claim this design spends its whole failure section avoiding.

`WITH ... AS MATERIALIZED` is an optimisation fence. It runs once, and the
`LIMIT` means what it says. The same shape applies to the retention sweeps,
which had the same hazard.

## Who may touch what

```
app_user                 outbox_events     INSERT
app_user                 processed_events  —
worker_user              outbox_events     SELECT, UPDATE, DELETE
worker_user              processed_events  INSERT, SELECT, DELETE, UPDATE (processed_at)
cross_tenant_admin_role  both              —
```

Both tables are SYSTEM class: no tenant policy, reached through grants. That
matters more than it sounds, because row-level security does nothing for a
table without a policy — measured, an `app_user` session inside a tenant
transaction read and wrote such a table freely. Without the revoke, an
injection through the API would read every tenant's payloads, delete an event
before the relay saw it, or mark one `ENQUEUED` to swallow it.

`app_user` gets **nothing** on `processed_events`, because that table *is* the
exactly-once guarantee: the ability to plant a row there is the ability to make
a consumer skip a real event. It is granted again when there is an in-request
consumer that needs it.

Two consequences worth knowing:

- **`append()` cannot use Prisma's `create()`.** It emits `RETURNING`, and
  `RETURNING` needs `SELECT`, which `app_user` deliberately lacks. Measured: it
  fails with `permission denied` inside the caller's transaction, so the
  business write rolls back — on the first request, in every environment where
  the grants are real, and never in a test that runs as the owner.
- **The `processed_events` sweep's `SKIP LOCKED` cost a column-level grant.**
  `UPDATE (processed_at)` and nothing wider. Table-level would also allow
  `SET event_id`, which forges a dedup row for an event nobody processed: the
  consumer finds a claim, does nothing, and the event vanishes from the audit
  trail with no error anywhere. `DELETE` — which `worker_user` already has —
  fails the opposite way and loudly, causing reprocessing that the unique index
  on `audit_records.event_id` catches and logs. So "it already deletes, so
  update adds nothing" is not true: the two point in opposite directions.

`worker_user` deliberately has no `INSERT` on `outbox_events`: nothing on the
worker side publishes today, and a producer that appears later should have to
ask for the grant rather than find it lying there.

## `aggregate_version`

Nullable, and only `Note` and `OrgSetting` carry a version at all.

It is **not** a way to detect out-of-order delivery — there is no watermark, no
buffer, no reordering, so a consumer that noticed a gap could only log it. It
earns its place as the natural idempotency key for a last-write-wins
projection, and as diagnostic data.

That pattern is valid **only** for aggregates that declare a version. A
projection written as `WHERE version < $incoming` against one that does not
matches nothing, silently, because the comparison is against NULL — so such a
projection must assert the value is present rather than filter on it.
