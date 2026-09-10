# Contract: quota

An organization's allowance for one entitlement, in one window. The units are
taken in the same transaction as the thing they pay for, so there is no state
in which the work happened and the quota was not charged.

## What it promises

**No oversell, at READ COMMITTED, without a lock the caller has to remember.**

Measured: 25 concurrent transactions each consuming one unit against a limit of
ten left `used = 10` exactly. Every statement here is a single statement, and a
conditional upsert takes the row lock itself.

The shape it replaces is check-then-insert — `SELECT SUM(...)`, decide, then
write — which is **write-skew on an aggregate**. Two transactions both read
`used = 8` against a limit of 10, both add 2, both commit, and the total is 12.
No snapshot prevents that; only a conditional write does.

## The one statement

```sql
INSERT INTO org_quota_counters (org_id, entitlement, window_start, used)
SELECT $org, $e, $w, $n WHERE $n <= $limit
ON CONFLICT (org_id, entitlement, window_start)
DO UPDATE SET used = org_quota_counters.used + $n
 WHERE org_quota_counters.used + $n <= $limit;
```

Zero rows means refused. One row means charged. **The boundary is `<=`** — a
limit of ten permits the tenth unit — and a test pins that, because it is the
kind of thing a refactor flips silently.

Three earlier designs failed here, each measured on PostgreSQL 18:

- **A plain conditional `UPDATE` refuses everything.** `UPDATE` does not create
  rows, so the first consume of every entitlement, for every organization, in
  every window, changes nothing — which the caller reads as "over quota". A new
  tenant is refused its first note and every tenant is refused on the first of
  the month.
- **An upsert whose `WHERE` guards only the update path raises instead of
  refusing.** A fresh key asked for 99 units against a limit of 10 is inserted
  unconditionally and stopped by the `CHECK`, which is SQLSTATE 23514 inside
  the caller's transaction — rolling back the business write. `WHERE $n <=
  $limit` on the `SELECT` is what makes the insert path behave like the update
  path.
- **A `CHECK (used <= limit)` makes a downgrade impossible.** Lowering a plan's
  limit to 5 for a tenant at `used = 8` fails with a constraint violation, for
  exactly the tenants who downgrade.

## There is no `limit` column

The ceiling is an argument, resolved by the caller before it asks, and the
statement enforces it on every write. The counter stores only `used`.

That is what makes a downgrade ordinary: after the limit drops, further
consumes are refused and nothing raises. The tenant sits above its new ceiling
until the window rolls, which is the honest state of affairs — the units were
spent.

The only constraint is `CHECK (used >= 0)`, and it fires only for a bug: a
refund of units that were never taken. Business outcomes never reach it.

## Over quota is 429. A missing entitlement is not.

The limit is resolved **before** the statement, and a missing entitlement
raises rather than returning a refusal.

Measured, with the limit read from an entitlement table inside the statement:
"this organization has no entitlement row" and "this organization is over
quota" both return zero rows, indistinguishably. They are different failures —
one is the tenant's, one is ours — and answering 429 to our own broken
provisioning hides it behind a plausible business error for as long as nobody
looks.

## The window

`daily`, `monthly` or `lifetime`, declared per entitlement.

**`sliding` is deliberately not offered.** A sliding limit cannot be a counter
row keyed by a window start at all; it needs the individual events inside the
trailing period. Offering the name would let a caller ask for a sliding limit
and silently get a fixed one, which is the failure worth the most trouble to
prevent. It is an upgrades entry.

`window_start` is computed by the library from the window kind and the clock,
**never passed in**. Two callers rounding differently would split one window
into two rows and both halves would get the whole limit.

**It is computed in UTC, and that is a decision.** A tenant-local boundary
would make `window_start` depend on a column in another table and on a DST
rule, and a tenant that changed its zone mid-month would move a boundary
underneath counters that already exist. A tenant in UTC+7 has a month that
rolls at 07:00 local; it is written here so that is known rather than
discovered. Per-tenant boundaries are an upgrades entry.

`lifetime` uses the epoch as its window start. The column is part of a primary
key and NOT NULL, so it needs a value, and the epoch is the one value nobody
can mistake for a boundary somebody meant.

## Reservations

For work that outlives its request. `consume` is the one-step path and most
callers want it.

```
reserve ──commit──> COMMITTED   (units stay spent)
   │
   ├──release──> RELEASED       (units come back)
   └──expiry sweep──> EXPIRED   (units come back)
```

**The units are taken when the reservation is created**, not when it is
committed. A reservation that had not charged would be a promise the counter
cannot keep: two concurrent reservations of six units each against a limit of
ten would both succeed.

`commit` only closes the reservation. `release` and the sweep are what refund.

**`release` is idempotent through the state machine, not through a flag.** The
update moves a row only out of `RESERVED`, so a retried release refunds once
and reports honestly that the second call changed nothing. A flag would need a
read to check it, and a read before a write is the race this whole design
avoids.

**A refund goes to the window the reservation charged**, which it carries
itself. A job that started on the 31st and failed on the 1st must not credit a
month that was never charged and leave the charged one permanently short.

### The expiry sweep

On the **hourly retention job**, not on the outbox relay. Its volume is bounded
by how many long jobs start, not by how fast the outbox delivers, so an hourly
job keeps up — and it keeps the worker's connection arithmetic unchanged, since
that sweep already runs at concurrency one.

Two things in that statement are not decoration:

- `FOR UPDATE SKIP LOCKED`, so replicas take disjoint batches, and the state is
  checked **again** in the outer update against a row that may have been
  settled in between — a job that finished while the sweep was running, whose
  units would otherwise come back twice.
- **The refunds are summed per counter before they are applied.** PostgreSQL
  updates a target row at most once per statement, so a plain join refunded one
  reservation's units and silently dropped the rest of the batch. Measured:
  three expired reservations of two units each returned two units instead of
  six, with all three marked `EXPIRED` — four units gone, and nothing anywhere
  reporting it, until the tenant hit a limit it was nowhere near. A test asked
  for a batch and that is what found it.

## Lock order

There is no cycle, so there is nothing to order:

- `reserve` locks the counter, then inserts a reservation **nobody else can be
  holding**, because it did not exist a moment earlier.
- `release`, `commit` and the sweep lock a reservation, then the counter.

The only shared resource is the counter row, and `reserve` never waits on a
reservation. A release waiting on a counter that a reserve holds waits for a
transaction that is not itself waiting for anything.

## Who may touch what

```
app_user                 org_quota_counters  INSERT, SELECT, UPDATE
app_user                 quota_reservations  INSERT, SELECT, UPDATE
worker_user              org_quota_counters  SELECT, UPDATE
worker_user              quota_reservations  SELECT, UPDATE
cross_tenant_admin_role  both                —
```

**No `DELETE` anywhere.** The right to delete a counter is the right to reset a
quota to zero, and a settled reservation is the record that its units came
back.

`app_user` needs `SELECT` as well as `INSERT` because an `ON CONFLICT` target
is an inference specification, which reads the table — the same fact that cost
the audit migration a correction.

### TENANT_OWNED, with a second policy — not SYSTEM

Both tables carry the ordinary tenant policy, and a second one that names
`worker_user`:

```sql
CREATE POLICY tenant_isolation ON "org_quota_counters"
  USING ("org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (...);

CREATE POLICY sweeper ON "org_quota_counters"
  FOR ALL TO worker_user USING (true) WITH CHECK (true);
```

The obvious reading is SYSTEM — the sweeper has to see every tenant and
`worker_user` has no `BYPASSRLS` — and it is a hole. **SYSTEM means no policy,
and a table with no policy is not protected by row-level security at all.**
`app_user` needs INSERT, SELECT and UPDATE here, so on a SYSTEM table those
rights would reach every tenant's row from the process that faces the internet:
one injection reads every customer's usage, or resets it.

Policies are OR-ed and a policy can name a role, so the sweeper gets its own
rather than the table giving up on policies. Measured on PostgreSQL 18 with
`FORCE` on:

| Session | Sees |
| --- | --- |
| `app_user`, tenant A's GUC set | 1 row — its own |
| `app_user`, no GUC set | 0 rows |
| `app_user` updating tenant B's row | `UPDATE 0` |
| `worker_user`, no GUC at all | every tenant |

The outbox could not use this shape, and the difference is worth naming:
`app_user` there must not read at all, and a policy granting a scoped read is
wider than no grant.

## What is not here

- **FAST quota (Redis Lua).** There is no measured bottleneck on a quota check,
  and it is the only part of this that would need Redis. Deferred with a
  signal, in `docs/upgrades.md`.
- **Entitlement storage.** Which limit applies to which organization belongs to
  `feature-entitlements`. This library takes the limit as an argument, which is
  also what lets it be tested without inventing a plan.
- **A usage API.** `usage()` reads the current window for the calling tenant.
  There is no cross-tenant reporting route, and `cross_tenant_admin_role` holds
  nothing, until somebody decides which tenants it may read.

## Covered by

- `libs/core/server/platform/data-access-db/src/lib/quota/quota.repository.spec.ts`
- `libs/core/server/platform/data-access-db/src/lib/quota/window.spec.ts`
