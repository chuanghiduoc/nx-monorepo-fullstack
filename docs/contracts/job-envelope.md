# Contract: the job envelope

Every job carries an envelope beside its payload. This is what is in it, why,
and what happens when it cannot be read.

## The fields

| Field | Required | What it is for |
|---|---|---|
| `schemaVersion` | yes | The version of the envelope, not of the payload |
| `attempt` | yes | Which attempt this is, counting from one |
| `requestedAt` | yes | When the work was asked for — not when it ran |
| `tenantId` | no | The organization the work happens in |
| `actorId` | no | Who asked |
| `traceparent` | no | The trace the job belongs to |

The three optional fields are optional because scheduled work has no request
behind it: no tenant chose it, no person asked for it, and there is no trace to
join.

`tenantId` is what a tenant-scoped job is meant to open its transaction with.
A job whose tenant is wrong does not fail — it reads nothing, and looks exactly
like a bug in the query. That is why it belongs in the envelope rather than in
each payload. Nothing consumes it yet: the only recurring job today sweeps
system tables and runs without a tenant at all.

`attempt` **counts from one**. The queue's own counter is zero-based inside the
processor and has already been incremented by the time it emits `failed`, so
one of the two is adjusted and the other is not. Both then agree with each
other, and with what a person would call the first attempt.

`requestedAt` is the earlier of the two timestamps on purpose. The gap between
asking and running is the queue's latency, and it can only be measured if the
earlier one was written down. For a scheduled job it is the moment of the tick,
taken from the queue's own stamp — see below.

## A payload is data

A job outlives the deploy that enqueued it. Whatever is in the payload has to
still mean something to a worker built from different code, so it is plain
data: no class instances, no object graphs, nothing whose meaning depends on
code that may have moved.

**Payloads carry no secrets.** This is a contract and a review item, not a
runtime check — a filter on key names has guaranteed false positives
(`clientSecretVersion`, `tokenCount`) and would refuse valid work while an
actual secret under an innocent name sailed through.

The payload is validated **where it is enqueued** as well as where it is
consumed. A producer that gets the shape wrong finds out at the line that got
it wrong; left to the consumer, the same mistake is a dead-lettered job in
another process, minutes later, with a stack that names the queue library.

## Reading an envelope from the future

The version is read off the raw message **before** the envelope is validated.
Doing it the other way round reports a newer envelope as a malformed one: every
field version 2 renamed comes back as its own schema error, and the person
reading it goes looking for a producer bug that is not there.

The check is strict in one direction. A consumer reads an envelope older than
its own; it refuses one that is newer, because the fields it would need are
ones nobody has written yet, and acting on a message it has misunderstood is
worse than not acting.

**What that costs the next version.** Backward reading keeps working only if
every field added after version 1 is optional. That is a rule about how the
schema may change, and no parser can enforce it: with one version in existence
there is no older shape to test against.

**Changing the version is a two-step deploy.** Readers first, writers second.
A producer that writes version 2 while a consumer still reads version 1 turns
every message into a permanent failure — correctly, by this contract, and
uselessly.

## A message that cannot be read is never retried

This is the rule the whole retry policy exists to protect.

A message whose shape is wrong is wrong on every attempt. Retrying it is an
infinite loop with a delay in it — a queue that looks busy and achieves
nothing, and a dead-letter that arrives an attempt budget later than it should.
So an unreadable envelope raises an error carrying `fatal: true`, the classifier
returns `fatal`, and the queue is told to stop immediately.

The error the handler threw is what gets marked, rather than wrapped: BullMQ
stops retrying on `err.name === 'UnrecoverableError'`, and setting the name
keeps the original stack. Wrapping replaced it with a stack pointing at the
queue library, which is the one part of a dead-lettered job worth opening.

## Three answers, not two

| Class | What it means | What happens |
|---|---|---|
| `retryable` | Not now: a timeout, a reset connection, a 503 | Retried with exponential backoff |
| `fatal` | Not ever: a 4xx, an unreadable message | Failed immediately |
| `unknown` | Nobody has classified this | Retried to a ceiling of five, then failed |

Two answers would not be enough. Everything unclassified would have to be
called one or the other, and whichever it was would be wrong half the time:
called retryable, a permanent failure spins; called fatal, a transient one is
thrown away. `unknown` is the honest answer, and a bounded one.

`ENOTFOUND` is deliberately *not* retryable. It is usually a hostname that is
wrong in the configuration — permanent, and retrying it spends every attempt of
every job on a deploy that will never work. It is not reliably permanent
either, so it falls to `unknown`, which is exactly the case that class exists
for. `EAI_AGAIN` is the transient DNS failure and stays retryable.

## What the queue does that is worth knowing

Measured against bullmq 6.3.4, not assumed:

- **`jobId` deduplication is silent.** A second `add` with the same `jobId` is
  ignored — nothing throws, and the returned job reports the payload that was
  *rejected*. Never read a job's data back from an enqueue call. The dedup is
  the mechanism that makes a crash between "enqueue" and "record that we
  enqueued" harmless, so it is used deliberately, with the caller supplying an
  id the work already has.
- **A schedule inherits none of the queue's defaults.** A job scheduler's
  template carries its own options, and without them BullMQ applies
  `attempts: 0` — no retry at all. One connection reset then loses a whole tick,
  silently, while an enqueued job beside it is tried eight times. The same
  option block is therefore attached to the template.
- **A schedule's template is written once.** It is copied to every tick after
  that, so a `requestedAt` stamped when the schedule was registered reports the
  age of the *schedule* — a number that grows without bound. A tick's envelope
  therefore takes its `requestedAt` from the queue's own stamp for that job,
  which is the moment being asked about.
- **Registering a schedule is last-writer-wins, and says nothing.** BullMQ
  overwrites whatever is stored under an id without comparing it. Schedule ids
  are therefore *stable* — the job's name, and nothing about its timing — so a
  changed interval is an overwrite that converges once the old replicas are
  gone. Encoding the interval in the id would make the two schedules different
  objects, which sounds safer and is not: something then has to delete the
  loser, and at boot the only thing that knows is a replica which cannot tell
  "this deploy dropped that job" from "the other half of this deploy has not
  booted yet". Two versions doing that to each other is a schedule that flaps
  for the length of the rollout.

  The cost is that a recurring job deleted from the code keeps firing: the
  scheduler lives in Redis, not in the source. `reconcileSchedules` removes
  those, and it is a deliberate step rather than boot work — it refuses to
  touch a schedule that is still due, so it cannot delete one another replica
  has just registered.
- **One worker consumes a whole queue.** A BullMQ worker is handed every job on
  its queue whatever name it was added under, so two handlers on one queue take
  each other's jobs and dead-letter them for a payload mismatch. A second
  `consume` on the same queue is refused.
- **The eviction policy is not enforced by the queue.** On `allkeys-lru` it
  logs a warning and carries on. A warning at startup is read once, by whoever
  was watching — so the queue library refuses to start instead. The check runs
  in the factory that builds the connection, not in a lifecycle hook: Nest
  resolves a factory before it constructs anything depending on it, so there is
  no ordering to get right. It carries its own deadline, because the connection
  must set `maxRetriesPerRequest: null` and ioredis then queues a command
  against an unreachable server indefinitely rather than failing it.
  A Redis that is *not allowed* to answer `CONFIG GET` is left alone: managed
  services routinely restrict it, and refusing to run there would be refusing
  to run in production to prove a point about production. Only that one refusal
  is tolerated — a connection error is not evidence about the policy.
- **The connection is handed in, not built from options.** Given plain options
  BullMQ opens one client per `Queue` and per `Worker` and closes each itself;
  given an instance it marks the connection shared and never closes it. Passing
  an instance is what makes the eviction check possible at all, and it makes
  one class responsible for closing it. It also makes
  `maxRetriesPerRequest: null` mandatory rather than advisory: `new Worker(...)`
  throws without it, because the worker duplicates the instance for its
  blocking fetch.
- **Shutdown drains.** `close()` without a force flag lets a job in flight
  finish. Killing instead leaves the work half-done and the queue waiting on a
  stalled check minutes later. The drain is **not** an `onApplicationShutdown`
  hook: Nest runs every `onModuleDestroy` first, the database client
  disconnects there, and the drain would then wait for a job whose transaction
  had already lost its connection. The process calls `drain()` itself, on the
  signal, before it closes the application.
- **There is no built-in dead-letter queue.** There is a failed set, and it is
  bounded by age rather than kept forever: this is the Redis that must never
  evict, and an unbounded set on it is a slow way to run it out of memory. A
  real dead-letter queue is a second queue fed from the `failed` listener, and
  it is not built until something needs to consume it.

## Where the boundary is

`bullmq` is banned from every module tag except the one the queue library
carries, the same way the ORM is banned outside the data-access library.

`type:data-access` alone cannot express that, because both libraries carry it:
a ban hung there would either ban a driver from its own owner or exempt both
libraries from both drivers. Each owner therefore carries a second tag naming
the driver it owns — `driver:orm` and `driver:queue` — and the constraint on
each bans the *other* driver. A project matching more than one source tag
collects every matching constraint, so the ORM library is bound by both.

The queue's own public surface names no driver type either. `enqueue` takes its
own options, `schedule` takes its own `Schedule`, and `consume` returns
nothing. A caller that had to name `JobsOptions` in a variable would fail lint
under the very ban above, and every option the driver happens to offer would
become part of this contract by accident.

`ioredis` is deliberately not banned. It is reached from the rate limiter, the
queue and the shared-counter store, and a facade in front of a client whose
whole surface is already a facade would add a name without adding a boundary.
