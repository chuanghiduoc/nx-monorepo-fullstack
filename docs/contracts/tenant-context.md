# Contract: tenant context

Who a request acts as, and what it may therefore see. Resolved once, at the
start of the request, and frozen for its duration.

## The three shapes

| Context | Set for | GUCs the transaction sets |
|---|---|---|
| `{ kind: 'org', orgId, userId }` | a member acting inside an organization | `app.current_org_id`, `app.current_user_id` |
| `{ kind: 'user', userId }` | a signed-in user with no active organization | `app.current_user_id`; the org GUC is cleared |
| `{ kind: 'system' }` | relays, schedulers, idempotency | none |

A user with no organization is not "no tenant": they are a tenant of one,
themselves, and rows they own with a null organization are theirs. That is the
case a tenant-optional table exists for.

## Resolution

The Fastify `onRequest` hook in the auth library reads one credential and one
only:

1. `x-api-key` present → verify the key. A valid key resolves to an api-key
   principal; an **invalid key ends the request's identity**. It never falls
   through to the cookie, because a session standing in for a rejected key is
   the whole failure the two branches exist to prevent.
2. Otherwise → read the session cookie. An active organization on the session
   makes the context an `org` one; no organization makes it a `user` one.
3. Neither → no context at all. A route that needs one says so; a tenant query
   without one throws rather than returning an empty list.

The hook runs the rest of the request inside `AsyncLocalStorage.run`, passing
Fastify's `done` as the callback. `enterWith` in an async hook does **not**
survive into the route handler — measured, three tests failed exactly that way
before the change.

Identity is resolved here, before any handler, because resolving it costs a
database read through the root client, and the root client refuses to be used
once a transaction is open. Resolving early is what lets a permission check
inside a transaction be a pure function of the principal.

## Using it

```ts
await db.withRequestTransaction(async () => {
  await notes.create(input);   // runs as the tenant the request resolved to
});
```

`withRequestTransaction` reads the stored context and opens a transaction for
it. Where there is no request — a job, a script — name the tenant explicitly
with `withTenantTransaction(context, ...)` or use `withSystemTransaction(...)`.
Guessing a tenant would be the worst possible recovery.

## Enforcement, in three layers

1. **The application** resolves the context and passes it to the transaction.
2. **The transaction** sets the GUCs with `set_config(..., true)`, so they are
   transaction-local and a pooled connection never carries one tenant's
   identity into the next request.
3. **PostgreSQL row-level security** — the boundary that holds when the first
   two are wrong. Policies read the GUCs, and `FORCE ROW LEVEL SECURITY` binds
   even the table owner.

**The third layer is not in place yet.** No migration creates a policy; the
tenant-owned tables it will protect do not exist either. What does exist is
everything that makes it testable when it arrives: the application connects as
`app_user`, a role that is neither a superuser nor `BYPASSRLS`; the service
refuses to boot on a connection that row-level security cannot bind; and every
isolation suite opens by proving a live `FORCE` policy actually hides a row.
That order is deliberate — a policy written against a superuser connection
would have looked like it worked.

## Table classes

Every model declares one, in a comment above it. Nothing is inferred from a
column name — an `org_id` on an auth table would otherwise imply a policy that
must not exist there.

| Class | Meaning | Policy |
|---|---|---|
| `GLOBAL` | shared reference data | none |
| `TENANT_OWNED` | `org_id NOT NULL` | `org_id = current org` |
| `TENANT_OPTIONAL` | `org_id` nullable, `user_id NOT NULL` | current org, **or** null org and current user |
| `SYSTEM` | outbox, audit, idempotency | no tenant policy; reached through grants |
| `AUTH` | better-auth's own tables | none — see below |

A naive tenant-optional policy (`org_id IS NULL OR org_id = current`) would
show every null-organization row to every tenant. The second branch must name
the user as well.

`AUTH` tables carry organization columns but get no tenant policy on purpose: a
user must be able to list every organization they belong to *before* any of
them is active, and the auth library's adapter runs outside our transactions,
so no GUC is ever set for it. Their isolation is that library's own access
control.

## Covered by

- `libs/core/server/platform/data-access-db/src/lib/tenancy/rls-harness.spec.ts`
  — the connection is bindable at all: not a superuser, no `BYPASSRLS`,
  `SET ROLE` refused, and a live `FORCE` policy actually hides a row.
- `libs/core/server/platform/data-access-db/src/lib/transaction/with-request-transaction.spec.ts`
  — the request's context reaches the transaction, and its absence is an error
  with a usable message.
- `apps/core/api-e2e/src/auth.e2e-spec.ts` — resolution over a real connection,
  including a key and a cookie sent together.
