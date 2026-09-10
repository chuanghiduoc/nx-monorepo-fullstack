# Contract: feature flags

Two tables and a cache. A flag has one global value and, for any organization
that needs to differ, one override.

## What it promises

**An evaluation never throws, and never blocks a request on the database.**

Every failure — an unknown key, a value of the wrong type, a database that is
not answering — resolves to the caller's own default, with a reason saying
which. A flag store that throws turns one outage into every request failing,
and a kill switch that fails closed is not a kill switch.

## Resolution order

```
override for this organization  ─┐
                                 ├─> the first one that exists
global value (cached)           ─┤
                                 │
the caller's default            ─┘
```

The override is looked up first and **short-circuits**: turning something on
for one customer does not require the global row to exist. Requiring two writes
to flip one switch is a tax charged at the moment somebody can least afford it.

An unknown key is not an error. It resolves to the caller's default with
`FLAG_NOT_FOUND`, which is what makes deleting a retired flag safe rather than
an outage in everything that still names it.

## Which organization

In order, and each step exists because the one before it does not cover the
case:

1. **Named in the evaluation context** (`orgId`). A worker handling one
   tenant's job knows, and has no request or tenant transaction to read it
   from.
2. **The open transaction.** The same source `OutboxRepository.append` and
   `QuotaRepository` read their tenant from, and the one that agrees with the
   policy that is about to bound the query.
3. **The ambient request context.** What lets a handler ask for a flag before
   it has opened any transaction and still get its own tenant's answer.

No tenant means **no override is read at all**. An API process outside a
request must not be handed some organization's answer by accident.

### Which transaction is the answer, not an implementation detail

`flag_overrides` is behind row-level security, so *which* transaction is open
decides which rows exist. The provider opens the right one rather than asking
the caller to remember:

| Situation | What it does |
| --- | --- |
| A transaction is already open | join it |
| A request, no transaction yet | open the request's own |
| Neither (a worker naming a tenant) | a system transaction |

In the last case `worker_user` reads through a policy that names its role.
`app_user` deliberately has no such policy, so an API process outside a request
reads no tenant's overrides at all — measured, and it is the intended answer
rather than a gap.

## The cache

**The global table only**, held in memory, reloaded when it is older than
`GLOBAL_FLAG_TTL_MS` (30 seconds).

There is no invalidation message, so **the time-to-live is the propagation
delay**: a change written to the table is visible in every process within that
window. Redis pub/sub is deferred, with the signal recorded in
`docs/upgrades.md` — a versioned key and a short window behave the same, and
the monotonic-version machinery exists mostly to solve a problem pub/sub itself
introduces.

Three things about it are load-bearing:

- **One reload, however many callers arrive at once.** A cold cache under load
  would otherwise issue a query per concurrent request — the stampede a cache
  exists to prevent, at the moment it matters.
- **A failed reload serves what it already has.** Not marked loaded, so the
  next call tries again rather than waiting out a window that never started.
  The staleness is logged at error level; the request continues.
- **It reads in the caller's transaction when there is one.** `feature_flags`
  is GLOBAL — no policy — so joining is not a compromise, and opening a system
  transaction unconditionally *was* one: `Database.run` refuses to join a
  transaction with a different context, so a flag read inside a tenant
  transaction threw, the failure was swallowed by the handler above, and the
  cache served its last successful load forever. Measured; a test pins it.

**Overrides are deliberately not cached.** Turning a flag on for one customer
is what happens during an incident, and taking effect on the next request
rather than at the end of a window is the whole value of it. A per-tenant cache
would also need a bound and an eviction policy for a problem nobody has
measured. The read is a primary-key lookup inside a transaction the caller had
already opened.

## Types

A value is stored as `jsonb` and read back as whatever it is. A value that is
not the type the caller asked for resolves to the caller's default with
`TYPE_MISMATCH` — **never coerced**. `Boolean('false')` is `true`, and a kill
switch that inverts itself on a typo is worse than one that does nothing.

Two traps are closed explicitly, and both have tests: `typeof null === 'object'`
does not make `null` an acceptable object, and a non-finite number is not a
number.

Storing values as jsonb rather than as four nullable columns is what lets a
flag change from a boolean to a variant string without a migration — which is
the kind of change flags exist to make cheap.

## OpenFeature, without the global client

`DatabaseFlagProvider` implements OpenFeature's `Provider`. The interface is
the cheap part and the reason it is here: every hosted vendor publishes an
OpenFeature provider, so replacing this one is a line in a module rather than
an edit at every call site.

**It does not call `OpenFeature.setProvider`.** That is process-global mutable
state, which every test then has to unwind and which two suites in one process
cannot share. A Nest application already has a container for this. Anyone who
wants the global client writes one line in their own bootstrap:

```ts
OpenFeature.setProvider(app.get(DatabaseFlagProvider));
```

`FeatureFlags` is the small surface a handler actually calls — `boolean`,
`string`, `number`, `object` — so nothing in this workspace depends on that
line having been written. The `*Details` variants return the resolution as
OpenFeature reports it, for the caller that wants to log *why*: the difference
between "the flag is off" and "the database was unreachable and the default is
off" is the whole of an incident investigation.

## Who may touch what

```
app_user                 feature_flags   SELECT
app_user                 flag_overrides  SELECT
worker_user              feature_flags   SELECT
worker_user              flag_overrides  SELECT
cross_tenant_admin_role  feature_flags   SELECT
cross_tenant_admin_role  flag_overrides  —
```

**Both roles read and neither writes.** A flag the application can rewrite is a
flag an injection can rewrite, and a flag is precisely the switch somebody
would most want to flip. Changes come from a migration, or from an operator
with the owner connection, until there is an administrative route — and that
route brings its own grant and its own authorization, which is the right moment
to decide who may.

`cross_tenant_admin_role` reads the global defaults, which are not a tenant's
data, and not the overrides, which are.

`feature_flags` is GLOBAL and carries no policy: the same row answers for
everyone, so there is nothing to isolate. `flag_overrides` is TENANT_OWNED with
the single-branch template, plus the same second policy the quota tables use —
a background process that must read across tenants gets a policy naming its
role, rather than the table having none.

## Both tables carry a reason

`feature_flags.description` and `flag_overrides.reason` are `NOT NULL`. A flag
nobody can explain is a flag nobody dares delete, and an override with no
reason outlives whoever set it.

## Covered by

- `libs/core/server/platform/flags/src/lib/flags.spec.ts`
