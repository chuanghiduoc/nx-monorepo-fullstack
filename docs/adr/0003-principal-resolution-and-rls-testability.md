# ADR-0003: Where the principal is resolved, and what it takes to test RLS

- **Status:** Accepted
- **Date:** 2026-09-02
- **Context:** Phase 3, Task 0. Two assumptions carried the whole phase's design, and neither could be settled by reading. Both were measured against a real PostgreSQL 18 before any Phase 3 code was written.

## Finding 1 — the test harness cannot be bound by RLS

```
[spike] connection role: {"user":"test","super":true,"bypass":true}
[spike] rows visible under a FORCE policy allowing only org a: 2
```

The second line is the one that matters. A table was created with `ENABLE` **and**
`FORCE ROW LEVEL SECURITY` and a policy admitting only `org = 'a'`; both rows
came back. `FORCE ROW LEVEL SECURITY` binds table owners — it has never bound
superusers or roles with `BYPASSRLS`, and the Testcontainers connection is both.

**Consequence:** every tenant-isolation test written against today's harness
would pass with no policy in effect at all. A green tenancy gate would mean
nothing. So the harness gains a non-superuser connection (`app_user`) *before*
the first policy is written, and every RLS suite opens with a guard test
asserting `rolsuper = false` and `rolbypassrls = false`.

## Finding 2 — better-auth reaches the root client, and the proxy refuses it inside a transaction

Same spike, three calls to a sign-up (which always reaches the adapter, unlike
`getSession` with no cookie, which returns null without a query):

| Where the call was made | Result |
|---|---|
| Outside any transaction | `Model user does not exist in the database` — the call reached PostgreSQL |
| Inside `withTenantTransaction` | `The root database client was used (user) while a transaction is active` |
| Inside `withSystemTransaction` | the same refusal |

The Prisma adapter calls `db[model].findFirst/create/…` on whatever client it
was handed, with `transaction: false`. The Phase 2 proxy sees a root-client
access while an async-context transaction is open and throws — exactly as
designed, and exactly where it matters.

## Decisions

1. **`auth.api.*` is never called while a `Database` transaction is active.**
   A session or membership lookup inside a business transaction would run on a
   different connection, outside the transaction and outside its tenant GUCs.
2. **The adapter is given the proxied root client, deliberately.** Handing it
   the raw instance would make a violation silent; this way it is a stack trace
   naming the model that was touched.
3. **The principal is resolved once per request, before any transaction** — in
   the Fastify `onRequest` hook — into a plain `Principal` value: user, active
   organization, roles and permission statements.
4. **The authz facade performs no database access.** It evaluates the resolved
   principal against in-memory role definitions, which is what makes
   `authz.require(...)` safe to call from inside a transaction — the common
   case in any service method.
5. **The harness exposes two connection strings:** `connectionUri` as
   `app_user` for the application, `migrationUri` as the owner for
   `migrate deploy`.

## Consequences

- Membership and role data must be on the principal by the time a service runs.
  A permission that depends on data not carried there is a signal to extend the
  principal, not to query from inside the facade.
- The rule is enforced by the runtime, not by review: any `auth.api.*` call
  that slips inside a transaction fails loudly on the first request that hits
  it, and a test asserts that refusal.
- better-auth's own tables get no tenant row-level security (class `AUTH`): a
  user must be able to list every membership before an organization is active,
  and the adapter runs with no GUCs set. Their isolation is better-auth's own
  access control, and that trade is worth writing down in the threat model
  when one exists.

## How to re-run the evidence

The spike specs were deleted after this record was written; they are in the
commit that introduced this ADR. Both findings reproduce in about a minute
against a fresh container.
