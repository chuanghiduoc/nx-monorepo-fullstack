# Contract: the worker

A second process beside the API. It serves no requests, opens no port, and
mounts no controller — a worker that can answer a request is an API with a
confusing name, and the two would then have to be deployed, scaled and secured
as one thing.

## It has its own environment

There are three schemas, not one:

- **base** — what any backend process needs: `NODE_ENV`, `LOG_LEVEL`,
  `REDIS_CRITICAL_URL`.
- **api** — the base plus ports, CORS, sessions, throttling, docs, the cache
  Redis.
- **worker** — the base plus `WORKER_DATABASE_URL`,
  `WORKER_DATABASE_POOL_MAX`, `WORKER_CONCURRENCY`,
  `RETENTION_SWEEP_INTERVAL_MINUTES`, `IDEMPOTENCY_RETENTION_HOURS`,
  `WORKER_HEARTBEAT_FILE`, `WORKER_HEARTBEAT_INTERVAL_MS`, and the relay's own
  `OUTBOX_*` settings.

A worker validated against the API's schema could not boot without a session
signing key, an allowed-origin list and a port. The compose file would then
have to hand it the signing key, which widens the blast radius of that key for
nothing.

The three are three **classes**, not one class with a type parameter. The class
is the injection token, a type parameter is erased, and both processes would
then share one token whose default type promised the API's keys everywhere: a
worker asking for the signing key would have typechecked and returned
`undefined`. Shared modules — logging — inject `BaseConfig` and see only the
keys both processes validate, so moving a key out of the base breaks the
compile rather than returning nothing in whichever process was not thought
about.

## It connects as a different role

`WORKER_DATABASE_URL`, not `DATABASE_URL`, and it is required.

Both processes read the environment of the same shell in development. With one
variable name, whichever role it held would be the role both connect as — and
the one that is wrong is the one with **more** rights than it needs. Nothing
would report it: `app_user` boots exactly as happily as `worker_user`, and the
guard that refuses a superuser or a `BYPASSRLS` role passes either way.

The variables are named at the module —
`DatabaseModule.forRoot('DATABASE_URL', 'DATABASE_POOL_MAX')` in the API,
`DatabaseModule.forRoot('WORKER_DATABASE_URL', 'WORKER_DATABASE_POOL_MAX')` in
the worker. The name rather than the value, because the name is what belongs in
the failure message: a process that will not start says which variable it was
looking at.

**The pool size is split for the same reason the role is.** One variable would
be read by both processes, and a number chosen to clear a worker's backlog
would arrive at the API multiplied by its own replicas. It is stated rather
than inherited because `pg` defaults to ten and says so nowhere, while
`WORKER_CONCURRENCY` permits a hundred — and running out of connections does
not arrive as anything naming a pool. It arrives as a transaction timeout,
which classifies as retryable and then, five attempts later, as a dead letter.

So the worker refuses to boot when the arithmetic does not work: the audit
consumer's concurrency, plus one for the retention sweep, plus one for the
relay, must fit inside `WORKER_DATABASE_POOL_MAX`. The failure names both
numbers and both remedies. The heartbeat is not counted — it pings Redis and
touches a file, and never opens a database connection.

A test asserts the connected role against `pg_stat_activity`, because that is
the one fact the whole least-privilege argument rests on and nothing else in
the system would notice if it were wrong.

## Stopping it

On `SIGTERM` the process, not Nest, decides what happens:

1. `OutboxRelay.stop()` — no new claim, and the pass in flight finishes. First,
   because the relay is a *producer*: draining the queue while it is still
   claiming would leave it filling a queue that had just been emptied.
2. `QueueService.drain()` — every job in flight finishes, no new one starts.
3. `app.close()` — Nest's own teardown: the database client, the pool, timers.

The second happens in a `finally`: a drain that failed leaves *more* to close,
not less. The drain itself waits for every worker rather than stopping at the
first that fails, so one bad close cannot abandon the job another was still
finishing. A second signal during the drain is logged and ignored — acting on
it would abandon exactly the job the first one is waiting for — and the
handlers are registered before the application context is built, so a signal
during startup is not met by the default disposition.

That order cannot be expressed as Nest lifecycle hooks. Nest runs every
`onModuleDestroy` before any `onApplicationShutdown`, the database client
disconnects in the first of those, and a drain written as an
`onApplicationShutdown` hook would therefore wait — faithfully and uselessly —
for a job whose transaction had already lost its connection. That ordering is
pinned by a test, so if a future Nest changes it the workaround can go.

There is deliberately no timeout on the drain. The only way to impose one is to
abandon a transaction half-done, which is the failure the drain exists to
prevent. The deadline belongs to whatever sent the signal, and it is spelled
`stop_grace_period`: sixty seconds for the worker, where what is in flight is a
job, against thirty for the API, where it is a request.

## Liveness without a port

The worker touches a file every `WORKER_HEARTBEAT_INTERVAL_MS` — ten seconds
by default — and only after its queue has answered a `PING`. The image's
`HEALTHCHECK` reads that file's modification time with a bare `node -e` — no
dependency, nothing to install — and reads the same variable to decide how
stale is too stale, at three and a half intervals: one missed write is a busy
machine, three in a row is a process that has stopped doing anything. Docker
then wants three consecutive failures before it calls the container unhealthy,
so the worst case from "stopped writing" to "reported unhealthy" is about a
minute.

The default path carries the process id, so two workers on one machine do not
share a liveness file and each report the other as alive.

The `PING` is the part that matters. A heartbeat proving only that the event
loop was turning would report a worker whose Redis had gone as healthy for as
long as it sat there doing nothing.

It is per replica, deliberately. A scheduled job would run on one replica for
the whole deployment, which is the opposite of what liveness needs.

## What it actually does today

Three things: the outbox relay, the audit consumer it feeds, and a recurring
retention sweep — which now settles quota reservations as well as deleting
expired rows.

The relay is not a scheduled job, and that is deliberate — a schedule exists to
make recurring work happen *once* across replicas, and the relay wants the
opposite. It is described in its own contract; what matters here is that it
runs as a poll loop in this process, it stops before the queue drains, and its
`OUTBOX_*` settings are part of this process's environment.

The audit consumer is what drains the queue the relay fills, and until it
existed the relay refused to deliver at all: a queue nobody drains, on a Redis
configured never to evict, is a slow way to stop the whole system. It runs at
`WORKER_CONCURRENCY`; the sweep runs at one, because a schedule that produces
one job an hour has nothing for a second worker to do and every extra one would
hold a database connection to do it.

Registration order matters and is not incidental. `queue.consume` for the
outbox is called **before any `await`** in the registry's bootstrap, so a slow
Redis while the schedule is being written cannot leave the queue undrained.

### The retention sweep

It deletes rows the system wrote for itself — a session past its expiry, a
verification token past its expiry, and an idempotency record nobody can replay
any more — and settles one thing that is not a delete: a quota reservation
nobody committed or released, whose units go back to the counter they were
taken from.

None of the deleted rows belongs to a tenant, so that work runs in a system
transaction and reaches the tables through grants. The reservations do belong
to tenants, and the sweep still sees all of them — through a policy that names
`worker_user`, not through the absence of one. The quota contract has the
measurements.

**Neither outbox table is here.** The relay removes its own delivered rows and
the consumers' processed-event rows on its own cadence, because it produces
both far faster than an hourly job can take them away — 100 rows a second
against 5.6. Moving them was not free: on the relay the statement runs on every
replica rather than one, so it needed `FOR UPDATE SKIP LOCKED`, and that needed
a column-level `GRANT UPDATE`. The outbox contract has the numbers.

**Sessions and verification tokens** are safe to delete because the row's own
`expires_at` is the whole truth: better-auth writes a new one on every sliding
refresh, and a request presenting a session the database does not have gets the
same answer as one presenting an expired session — the cookie is cleared and
the response is null. The same holds for verification tokens with the plugins
this service enables; a plugin that distinguishes "expired" from "not found" in
what the user sees would change that, and enabling one is a decision to revisit
this paragraph.

**Idempotency records** need two rules, not one:

- A record that finished is deletable once the retention window has passed.
  Both `complete()` and `fail()` stamp `completed_at`, so a non-null stamp
  means "finished", not "succeeded".
- A record that never finished has `completed_at` NULL **forever** — a process
  that died mid-claim leaves the row for the next attempt to reclaim rather
  than to close. Sweeping only on `completed_at` would leak exactly the rows
  nobody is coming back for, so the sweep also takes rows whose lease expired
  longer ago than the window.

The window must stay far above the claim lease. Deleting a record resets its
fence token, and a writer from a long-abandoned attempt could then come back,
find a fresh row at the same token, and overwrite a response a later caller had
already been given. Hours against seconds is the margin; a retention measured
in seconds would reintroduce the race the token exists to close.

### How the deletes are written

Every one has the same shape:

```sql
DELETE FROM t WHERE id IN (
  SELECT id FROM t WHERE <expired> LIMIT n FOR UPDATE SKIP LOCKED
) AND <expired>
```

There is deliberately no `ORDER BY` **here**. Oldest-first reads as a harmless
nicety and is the thing that can stop the batch bounding any work: an ordering
no index can supply has to be sorted, and a sort sees every qualifying row
before it yields the first. Which rows a sweep takes first does not matter,
because the next batch takes the rest.

The outbox claim *is* ordered, and that is not an inconsistency: its premise is
different. Each branch of that claim has an index carrying its ordering, so the
scan stops at the batch — and there the ordering is load-bearing, because an
unordered scan returns rows in physical order and a row that keeps failing can
be passed over forever.

`SKIP LOCKED` so two replicas sweeping on the same schedule take disjoint rows
instead of one waiting on the other's locks and then finding nothing left. The
predicate is repeated in the outer `WHERE` against a row that changes between
being selected and being deleted — a session a request renewed while the sweep
was running, whose owner would otherwise be signed out with nothing in any log
to say why.

Measured on PostgreSQL 18: **either mechanism alone is enough**, because READ
COMMITTED re-evaluates the qual of whichever node holds the lock, and only with
both removed is the renewed session deleted. They are kept together because
they guard the two halves of the statement and a later edit is far more likely
to touch one than both.

Each batch is its own transaction, and each of the four — sessions,
verification tokens, idempotency records and expired quota reservations — gets
at most twenty batches per run. Consumers' processed-event rows are **not** swept here: their volume is
the outbox's delivery rate one window later, which a once-an-hour job loses to,
so the relay sweeps them on its own cadence (see the outbox contract). One transaction around the whole sweep would hold locks
on the busiest tables in the schema for as long as the backlog took to clear;
an unbounded run would do the same after any long outage.

Each bounded statement is a materialised CTE rather than
`IN (SELECT ... LIMIT n)`: measured on PostgreSQL 18, the inline form let the
planner re-execute the subquery per candidate row, and a statement asked for
two rows took all five.

Raw SQL because `FOR UPDATE SKIP LOCKED` has no Prisma Client API. Row-level
security still applies to raw statements — none of these tables carries a
tenant policy.

## Where it runs

`pnpm dev` starts it beside the API: its `serve` target is picked up by
`nx run-many -t serve dev`, and it reads the same `.env`.

In the production-shaped compose it waits for the migration job to finish, the
same way the API does. That is the answer to "what if the schema is behind":
nothing that touches the database starts until the migration has succeeded.
