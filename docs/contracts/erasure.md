# Contract: erasure

A person asks to be forgotten; a month later they are. The whole design is one
sentence: **nothing reachable from a request can delete a person or edit an
audit record.**

## Two halves, two roles

```
POST /v1/me/erasure  ──>  user.deleted_at = now()      as app_user
                                   │
                          (ERASURE_GRACE_DAYS)
                                   │
     daily job         ──>  anonymise the trail        as erasure_role
                            delete the person           in one transaction
```

The request path writes a timestamp and nothing else. `app_user` cannot touch
`audit_records` at all, and `worker_user` — the role every outbox consumer
connects as — holds `INSERT, SELECT` there and no `DELETE` on `user`.

That is what makes the grace window a guarantee. A route that could erase would
be a route an injection could erase through, and the month would be worth
nothing.

## The grace window is the feature

An erasure cannot be undone. A mistaken one with no window is a support ticket
nobody can answer, so `ERASURE_GRACE_DAYS` (30) sits between the request and
the deletion, and `DELETE /v1/me/erasure` takes it back.

**Asking twice does not extend it.** A person who asked on the first and again
on the tenth expects the first date to hold; `COALESCE(deleted_at, now())` is
what keeps it.

**The account keeps working during the window.** Nothing is deleted yet, and an
account that stopped working the moment it was scheduled would make the window
unusable — the whole point of it is that a person can change their mind.

**A cancellation wins even after the batch has been read.** The sweep reads who
is due in one transaction and erases each person in another, so a cancellation
arriving in between meets an id that is already on the list. The delete
therefore carries the same window the read did — `deleted_at IS NOT NULL AND
deleted_at < cutoff` — which is what makes PostgreSQL re-check the row it
locked. Deleting by id alone honoured the stale list: the account went, the
cancellation had already answered "yes, taken back", and nothing could be
undone.

`ERASURE_GRACE_DAYS` lives in the **base** schema, not the worker's: the API
quotes the date back to the person asking and the worker acts on it, so two
variables would let the promise and the deletion disagree.

## What "erased" means, table by table

| Table | What happens |
| --- | --- |
| `user` | deleted |
| `session`, `account`, `member`, `invitation`, `twofactor` | go with it, `ON DELETE CASCADE` |
| `audit_records` | the row **stays**; `actor_id` becomes NULL and `detail` is replaced |
| an organization's own data (notes, …) | untouched — it belongs to the organization, not the member |

**The trail is anonymised first**, and the order is load-bearing: after the
delete there is nothing left to find the rows by. `audit_records.actor_id`
deliberately has no foreign key — a cascade there would destroy the evidence
the table exists to keep — so nothing would point at them any more.

**`detail` is replaced wholesale**, with `{ erased: true, erasedAt: … }`. It is
whatever the event carried, and no code here can know which keys of an
arbitrary jsonb identify a person; anything that tried would be a guess that
fails silently on the first event type nobody thought about. The event type,
the aggregate and the timestamps live in their own columns, so the trail still
says what happened and when — only who is gone.

A trail with holes in it is not a trail; a trail naming somebody who exercised
their right to be forgotten is not lawful. Keeping the row and removing the
person satisfies both.

## One role, one transaction

The obvious design splits it: the worker deletes the user, `erasure_role`
anonymises the trail. **It cannot work.** Two roles are two connections and
therefore two transactions, and a crash between them leaves a deleted user
whose audit rows still name them — the exact state the feature exists to
prevent, reachable by an ordinary restart. Worse, it is unrecoverable: once the
user row is gone there is no list of ids to anonymise from.

So `erasure_role` does both, and holds exactly:

```
erasure_role  user, organization  SELECT, DELETE
erasure_role  audit_records       SELECT, UPDATE (actor_id, detail)
```

Column-level, and that is the point rather than tidiness: it may remove the
person and nothing else. Rewriting `event_type` would let an erasure quietly
change what the trail says happened. It holds no `DELETE` on `audit_records` at
all.

Four tests run as the wrong role and are refused: the worker cannot edit an
audit record or delete a person, and `erasure_role` cannot rewrite another
column or delete a record.

### One privilege had to be taken away

`worker_user` could delete any account in the system. Nothing granted it — the
roles migration's `ALTER DEFAULT PRIVILEGES` hands every new table full DML to
both application roles, and `user` and `organization` were created by the
better-auth migration under exactly that default. Found by a test that ran
`DELETE FROM "user"` as `worker_user` and expected to be refused; it was not.

`app_user` keeps it, because better-auth's own admin and organization plugins
delete through the request path and revoking it would break them without
replacing them. The route that makes soft delete the only way in is what should
take it away, and it does not exist yet.

## The connection

Opened for the run and closed after it, with `max: 1` — not a pool.

The job runs daily. A permanent third pool would count against
`WORKER_DATABASE_POOL_MAX`, which the worker asserts at boot, for every one of
the twenty-three hours it is doing nothing. A short-lived client is the honest
shape for work that happens once a day, and it keeps the blast radius small:
the role that can delete a person exists for a minute at a time.

It is opened through `PrismaService.onModuleInit` rather than a bare
`$connect`, so it also refuses a connection row-level security cannot bind —
the check that would catch somebody pointing `ERASURE_DATABASE_URL` at the
owner, which is the one role that could then quietly rewrite the trail.

## Failures

One transaction **per person**, not per batch: an erasure that fails halfway
through a hundred must not undo the ninety-nine that worked.

A failure is logged and skipped. The next run finds the person again, and one
unerasable row must not hold up everybody else's right to be forgotten.

Erasing somebody who is already gone throws rather than succeeding quietly —
the anonymisation in the same transaction has to roll back with it, and
throwing is what does that.

## What is not here

- **Organization erasure.** The column exists and the grant covers it; the job
  does not act on it. Erasing an organization is a decision about its members —
  whose accounts are not theirs to delete — and about their data, and half of
  that answer is worse than none.
- **An administrative erasure route.** Erasing somebody else needs an answer
  about who may, and the wrong answer is unrecoverable. What the regulation is
  actually about is the person asking, and that is what exists.
- **An export.** The right to erasure and the right to portability are
  different requests with different shapes.

## Covered by

- `libs/core/server/platform/data-access-db/src/lib/erasure/erasure.repository.spec.ts`
- `apps/core/api-e2e/src/privacy.e2e-spec.ts`
