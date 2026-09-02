# Contract: transaction ownership

`Database` (`libs/core/server/data-access-db`) is the only sanctioned way to
touch PostgreSQL. It owns the transaction and the tenant GUCs; nothing else
opens one.

```ts
await db.withTenantTransaction({ kind: 'org', orgId, userId }, async () => {
  await orders.create(input);       // repositories run on the same transaction
  await outbox.append(orderCreated); // …so the outbox write commits with it
});
```

## Surface

| Call | Runs as | Sets |
|---|---|---|
| `withTenantTransaction(ctx, work)` | `ctx.kind = 'org'` | `app.current_org_id`, `app.current_user_id` |
| | `ctx.kind = 'user'` (B2C, no active org) | `app.current_user_id`; org GUC cleared |
| `withSystemTransaction(work)` | system (relays, schedulers, idempotency) | nothing |
| `tenant()` / `system()` | inside the matching transaction only | — |

The callbacks receive **no client**. Work inside reaches the transaction via
`db.tenant()` / `db.system()`, which read it from `AsyncLocalStorage`: a
repository three calls deep runs on the transaction the use case opened,
without every function in between passing `tx` along — and no `Prisma.*` type
appears in a feature's signature (spec §4 rule 5b).

Options: `timeoutMs` (Prisma default 5 s), `maxWaitMs` (2 s), `isolation`
(`read-committed` | `repeatable-read` | `serializable`). Keep interactive
transactions short; never make a network call inside one.

## Rules the runtime enforces

| Situation | Behaviour |
|---|---|
| Nested call, same context | Joins the transaction in flight. One commit, one rollback. |
| Nested call, different tenant or system↔tenant | Throws `different tenant context`. Changing identity part-way would run the inner work under the outer GUCs. |
| `tenant()` outside a tenant transaction | Throws. Under RLS FORCE a query on the root client returns **nothing, silently** — a stack trace is the honest failure. |
| Root client touched while a transaction is active | Throws `root database client was used`. The root client is a `Proxy` that checks the async context on every property access. |
| Root client outside a transaction | Works — it is how connections are opened and closed. |

GUCs are set with `set_config(name, value, true)`: **transaction-local**, gone
at COMMIT or ROLLBACK. A pooled connection never carries one tenant's identity
into the next request, which is what makes PgBouncer transaction mode safe.

## Structural enforcement

- `PrismaService` (the root client) is not exported from the library. Feature
  modules import `DatabaseModule`, `Database`, and repositories.
- `@nx/enforce-module-boundaries` bans `@prisma/*` and `prisma` for every tag
  except `type:data-access` (`eslint.boundaries.mjs`, `ORM_PACKAGES`). Adding
  `import { Prisma } from '@prisma/client'` to the API fails lint with
  `A project tagged with "type:app" is not allowed to import "@prisma/client"`.
- Repositories open their own short transaction when none is active
  (`DemoItemRepository` is the reference), so a caller never has to remember
  and a query never lands on the root client.

## What Phase 3 adds on top

RLS policies read exactly these GUCs; a request-scoped `TenantContext`
resolved by middleware feeds `withTenantTransaction`; the five database roles
and the policy template are documented in `docs/contracts/tenant-context.md`.
Nothing in this seam changes — that is the point of having it first.

## Covered by

- `libs/core/server/data-access-db/src/lib/transaction/database.spec.ts`
  against a real PostgreSQL: commit, rollback, both GUC shapes and their
  transaction-locality, nesting, context change refusal, accessor guards, root
  client refusal, and two tenants in flight at once.
- `idempotency.store.spec.ts` and `demo-items.service.spec.ts` — consumers
  running through the seam.
