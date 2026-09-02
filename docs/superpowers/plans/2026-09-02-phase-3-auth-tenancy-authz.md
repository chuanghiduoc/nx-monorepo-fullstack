# Phase 3 — Auth, Tenancy, Authz, i18n: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** After this phase a real product can start on the platform: users sign in (email/password, 2FA, device sessions), belong to organizations, are isolated from each other by PostgreSQL row-level security that holds even when application code is wrong, and every permission decision goes through one registry-driven facade that denies by default. The web app has auth screens, an organization switcher and vi/en.

**Architecture:** better-auth owns identity and organization membership (ADR-0002, mounted on Fastify). `Database.withTenantTransaction` from Phase 2 is the only place tenant GUCs are set; RLS policies read them. A Prisma Client Extension *guards* (throws when a tenant-scoped model is queried without context) and never opens transactions. `libs/core/server/authz` is the single facade for permission checks. Frontend talks only to the public edge origin; the backend URL stays server-only.

**Tech Stack:** better-auth 1.7 (+ organization, admin, two-factor, multi-session, api-key plugins), Prisma 7, PostgreSQL 18 RLS, `@nestjs/*` 11, Zod 4, Next 16, next-intl, react-hook-form + `@hookform/resolvers/zod`, shadcn/ui, Playwright, Vitest + Testcontainers (`@workspace/core-server-testing`).

**Spec:** §6.5 (tenant context, RLS, authz), §6.14 (security), §6.17 (roles, migrations), §6.18 (routing), §7 Phase 3, §8 (testing).

## Global Constraints

- Same as Phases 1–2: no hand-written versions; every library and schema comes from its own CLI or generator (`pnpm add`, `@nx/js:library`, `@better-auth/cli generate`, `prisma migrate dev --create-only`); every deliberate simplification is an entry in `docs/upgrades.md`; conventional commits; `pnpm verify && pnpm knip` green before each commit.
- **Fetch the vendor docs before each task and follow them** — the Phase 2 record (`docs/upgrades.md`, `docs/contracts/api-client.md`) shows what happens when a chain is assumed rather than read.
- Every RLS policy, `GRANT`/`REVOKE`, role and `CHECK` lives in a Prisma migration written with `--create-only`, with a reviewed `down.sql` beside it (Task 12 workflow). Never applied by hand.
- Tenant-scoped tables are declared with their class (`GLOBAL` | `TENANT_OWNED` | `TENANT_OPTIONAL` | `SYSTEM`) in the schema comment; the class decides the policy template. The generator never infers it.
- Three separate exit gates (auth, tenancy, authz). A green UI does not close a red gate.
- Working directory: `D:/nx-monorepo-fullstack/nx-monorepo-fullstack`; `docker compose up -d` running.

---

### Task 1: better-auth on Prisma with the plugin set

**Files:**
- Modify: `apps/core/api/src/app/auth/auth.config.ts`, `auth.handler.ts`
- Modify: `libs/core/server/data-access-db/prisma/schema.prisma` (generated section)
- Create: migration `..._better_auth` (+ `down.sql`)
- Modify: `libs/core/server/core/src/lib/config/env.schema.ts` (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `APP_ORIGIN`)

**Interfaces:**
- Produces: `auth` instance with `prismaAdapter(prisma, { provider: 'postgresql' })`, plugins `organization({ dynamicAccessControl: { enabled: true }, ac, roles })`, `admin({ ac, roles })`, `twoFactor()`, `multiSession()`, `apiKey([...])`; `advanced.database.generateId: false` so PostgreSQL's `uuidv7()` stays the only id source.
- Consumes: the root Prisma client **inside data-access-db only** — better-auth's adapter needs a raw client, so the adapter is constructed in `data-access-db` and exported as an opaque `authDatabase` (never the client itself). Document this as the one sanctioned exception to the root-client rule, and why.

- [ ] **Step 1: Docs first.** Read better-auth: adapters/prisma, concepts/cli, concepts/database (`generateId`), plugins organization (dynamic access control, `activeOrganizationId` on session), admin (ban, impersonation, `impersonatedBy` on session), two-factor, multi-session, api-key (`references: "organization"`, rate limit per key, `expiresAt`, prefix). Record the exact versions installed.
- [ ] **Step 2: Install** `pnpm --filter core-api add better-auth @better-auth/api-key` (and whatever the docs name for the others), catalog the ranges.
- [ ] **Step 3: Generate the schema, don't write it.** `pnpm exec @better-auth/cli generate --adapter prisma --dialect postgresql` against `auth.config.ts`; merge the output into `schema.prisma` via `@@map`/`@map` to snake_case and `@db.Uuid` ids with `@default(dbgenerated("uuidv7()"))`, `@db.Timestamptz(3)`. Then `prisma migrate dev --create-only`, review, `down.sql` via `prisma-down`.
- [ ] **Step 4: Failing e2e (api-e2e):** sign-up, sign-in, `get-session`, sign-out; 2FA enable → verify TOTP → sign-in requires code; multi-session list/revoke; org create → invite → accept → `activeOrganizationId` on session; admin ban → sign-in 403; impersonate → session carries `impersonatedBy`; api-key create → request with `x-api-key` on an opt-in route → 200, without → 401 **and no session fallback**.
- [ ] **Step 5: Implement, green.** `trustedOrigins` from `CORS_ORIGINS`; cookies `secure` in production; `rateLimit` on better-auth routes backed by Redis (critical role).
- [ ] **Step 6: Behind a proxy.** e2e sends `X-Forwarded-Proto: https` / `X-Forwarded-For` and asserts secure cookie attributes and the logged client IP — the ADR-0002 "not yet verified" item.
- [ ] **Step 7: Commit.**

---

### Task 2: Tenant context — request scope → `withTenantTransaction`

**Files:**
- Create: `libs/core/server/core/src/lib/tenancy/{tenant-context.storage,tenant-context.middleware,current-tenant.decorator}.ts` + specs
- Modify: `libs/core/server/data-access-db/src/lib/transaction/database.ts` (`tenant()` may open a short transaction from the request context — the `docs/upgrades.md` item)

**Interfaces:**
- Produces: `TenantContextStorage` (AsyncLocalStorage of `TenantContext` per request), resolved by middleware from the better-auth session (`activeOrganizationId` → `org`, no org → `user`) or api-key (`org` of the key, `principalType: 'apiKey'`); `@CurrentTenant()`.
- Consumes: `TenantContext` from Phase 2.

- [ ] **Step 1: Failing tests** — middleware maps session/api-key/none to `org` / `user` / **unauthenticated (no context, not system)**; `db.tenant()` outside a transaction but inside a request with context opens a short tenant transaction; outside any request still throws; a request that switches organization mid-flight is impossible (context is frozen at resolution).
- [ ] **Step 2: Implement.** Fastify `onRequest` hook (runs before Nest guards) rather than a Nest middleware so better-auth's routes and Nest's share one resolution.
- [ ] **Step 3: Commit.**

---

### Task 3: RLS — roles, policies, table classes

**Files:**
- Create: migrations `..._database_roles`, `..._rls_reference_tables` (+ `down.sql` each)
- Create: `libs/core/server/data-access-db/prisma/policies/README.md` (the four templates, copied verbatim into migrations)
- Modify: `docs/contracts/tenant-context.md` (write it for real)
- Modify: `docker-compose.yml` (init SQL creating roles in dev), `.env.example` (`DATABASE_URL` as `app_user`, `MIGRATION_DATABASE_URL` as `migration_role`)

**Interfaces:**
- Produces: roles `app_user`, `worker_user`, `erasure_role`, `migration_role`, `cross_tenant_admin_role` with explicit `GRANT`/`REVOKE`; `ENABLE ROW LEVEL SECURITY` + `FORCE` on every tenant-owned/optional table; the policy template from spec §6.5 using `NULLIF(current_setting(..., true), '')::uuid`.
- Reference tables: `demo_items` becomes `TENANT_OWNED` (adds `org_id NOT NULL`, backfilled from a seed org in dev; the migration states lock impact), plus a new `TENANT_OPTIONAL` reference table `notes` (`org_id NULL`, `user_id NOT NULL`) so both policy shapes are exercised.

- [ ] **Step 1: Access-pattern note first** (Database Workflow Step 0, one page): which queries hit tenant tables, expected volume, which need `(org_id, created_at DESC, id DESC)` composite indexes — RLS adds `org_id = …` to every plan, so every index leads with `org_id`.
- [ ] **Step 2: Failing integration tests (Testcontainers, `app_user` connection):**
  - as `org A`, rows of `org B` are invisible — **with the Prisma extension from Task 4 disabled**, i.e. RLS alone;
  - `USER_ONLY` sees only `org_id IS NULL AND user_id = me` on the optional table and nothing on the owned table;
  - no GUC set → owned table returns nothing (documenting *why* the extension must throw first);
  - `app_user` cannot `SET ROLE`, cannot bypass RLS, cannot read `idempotency_records` beyond its grants; `migration_role` can DDL;
  - PgBouncer transaction mode: a second container running pgbouncer in front; two interleaved transactions from different orgs never see each other's GUC.
  - `EXPLAIN (ANALYZE, BUFFERS)` of the demo list under RLS is captured into `docs/contracts/tenant-context.md` — index used, no seq scan.
- [ ] **Step 3: Migrations, green.** `prisma migrate dev --create-only`, policies pasted from the template, `down.sql` reviewed (`DROP POLICY`, `DISABLE ROW LEVEL SECURITY`, `REVOKE`, `DROP ROLE` in the right order — roles are cluster-wide, state that).
- [ ] **Step 4: Commit.**

---

### Task 4: Prisma Client Extension — the guard

**Files:**
- Create: `libs/core/server/data-access-db/src/lib/tenancy/{tenant-scoped-models,tenant-guard.extension}.ts` + spec
- Modify: `prisma.service.ts` (root client `$extends` the guard; the Proxy from Phase 2 stays)

**Interfaces:**
- Produces: `TENANT_SCOPED_MODELS` (declared list, generated from schema comments by a small script in `tools/`, checked in and drift-tested), an extension that throws `NoTenantContextError` when any operation on a tenant-scoped model runs while `activeTransaction()?.context.kind` is `system` or absent — **it does not open transactions and does not inject `where`** (spec §6.5: RLS is the boundary; the extension exists so a developer gets a stack trace instead of an empty list).

- [ ] **Step 1: Failing tests** — tenant-scoped `findMany` inside `withSystemTransaction` throws; inside `withTenantTransaction` passes; a global model inside a system transaction passes; `$queryRaw` is *not* guarded (documented: raw SQL is the developer's responsibility, RLS still applies).
- [ ] **Step 2: Implement** with `$extends({ query: { $allModels: { $allOperations } } })` per Prisma docs; confirm the extended client still works under the Phase 2 Proxy (test: root-client refusal still fires).
- [ ] **Step 3: Commit.**

---

### Task 5: `libs/core/server/authz` — the facade

**Files:**
- Create: `libs/core/server/authz` via `@nx/js:library` (tags `scope:core,platform:node,type:util`? no — `type:data-access`? decide: it reads membership/roles, so **`type:util` with an injected `MembershipReader` port** keeps it framework-clean and unit-testable)
- Create: `src/lib/{action-registry,principal,authz.service,authz.errors}.ts` + specs

**Interfaces:**
- Produces: `ActionRegistry` (typed `<resource>.<verb>`, versioned, mirrors better-auth AC statements — one source: the registry *generates* the `createAccessControl` statements), `Principal = { type: 'user' | 'apiKey' | 'system', id, actorId? (impersonation), orgId?, roles[] }`, `authz.can/require/canAny/canAll`, `ForbiddenProblem` (403 Problem Details with an internal deny reason logged, never returned).
- Consumes: better-auth's `hasPermission` for org roles (dynamic roles included), ownership/attribute conditions evaluated locally (ABAC-lite).

- [ ] **Step 1: Failing unit tests (pure, no DB):** unknown action → deny; unknown resource → deny; role grants → allow; ownership condition; api-key principal restricted to the key's permissions and never to the issuing user's; `effectiveUser` vs `actor` — check uses effective, audit context carries both; `require` throws the 403 Problem with `type` `…/forbidden` and no reason in the body; policy version bump invalidates a cached decision.
- [ ] **Step 2: Implement.** Deny is the default branch of an exhaustive `switch` over `Principal['type']`.
- [ ] **Step 3: Nest integration:** `@RequirePermission('invoice.read')` guard using the facade; e2e proves default deny on a route with a typo'd action.
- [ ] **Step 4: Commit.**

---

### Task 6: `org_settings` and the IP allowlist guard

**Files:**
- Create: migration `..._org_settings` (`TENANT_OWNED`, `UNIQUE (org_id, key)`, `value JSONB`, `version INT` for optimistic concurrency per spec §6.17)
- Create: `libs/core/server/core/src/lib/org-settings/{setting-registry,org-settings.service,ip-allowlist.guard}.ts` + specs

**Interfaces:**
- Produces: `SettingRegistry` (key → Zod schema; unknown key → 400), `orgSettings.get/set` with `If-Match`-style version check (409 on stale), `IpAllowlistGuard` reading `security.ipAllowlist` (CIDR list) and the client IP **from `trustProxy`-resolved `request.ip`** — never from a header parsed by hand.

- [ ] **Step 1: Failing tests** — validation per key; stale write → 409 Problem; allowlist empty → allow; IP outside → 403; IPv6 and CIDR boundaries; `X-Forwarded-For` spoofing without the proxy trust does not change `request.ip`.
- [ ] **Step 2: Implement, green. Commit.**

---

### Task 7: Reference feature — tenant-scoped user/member CRUD

**Files:**
- Create: `libs/core/server/feature-members` via the workspace generator (`type:feature`)
- Modify: `apps/core/api` (mount), `apps/core/api/openapi.json` + generated client (drift check)

**Interfaces:**
- Produces: `GET/POST/PATCH/DELETE /api/v1/members` scoped by the request's org through `withTenantTransaction`, `authz.require('member.<verb>')`, cursor pagination, optimistic concurrency (`version`, 409), `DELETE` idempotent 204.

- [ ] **Step 1: Failing e2e:** the full matrix from spec §6.5 — org member sees own org only; api-key of org A cannot read org B; USER_ONLY gets 403 on an org route; stale PATCH → 409; delete twice → 204 twice.
- [ ] **Step 2: Implement, green. Commit.**

---

### Task 8: Web — auth screens, org switcher, device sessions, forms, i18n

**Files:**
- Create: `apps/core/web/src/app/(auth)/{sign-in,sign-up,two-factor}/page.tsx`, `src/app/(app)/settings/{organizations,devices}/page.tsx`, `src/proxy.ts` (Next 16 name for middleware), `src/i18n/*`, `messages/{vi,en}.json`
- Modify: `libs/shared/ui` (form primitives via `shadcn add form`), `libs/shared/i18n` (next-intl config)
- Create: `libs/shared/contracts` (`type:util`, `platform:shared`) holding the Zod schemas both API DTOs and forms import — **one schema validates both sides** (spec §7 Phase 3)

**Interfaces:**
- Consumes: better-auth client (`createAuthClient` with plugin clients), generated API client. Base URLs: browser uses the public edge origin only (`NEXT_PUBLIC_APP_ORIGIN`); server components use `API_URL`.

- [ ] **Step 1: Docs first.** next-intl App Router setup for Next 16; better-auth client plugins; react-hook-form + `zodResolver` with Zod 4.
- [ ] **Step 2: Move the demo DTO schemas** into `libs/shared/contracts`; `demo-item.dto.ts` imports them — the API keeps `createZodDto`, the form keeps `zodResolver`; a test asserts both reject the same invalid input.
- [ ] **Step 3: Playwright e2e (web-e2e, against a running API — extend `global-setup` to start it):** sign-up → 2FA setup → sign-out → sign-in with code; create org → switch → members page shows only that org; devices page lists two sessions and revokes one; the same flow in `vi` and `en` (assert translated headings, no missing-key fallbacks).
- [ ] **Step 4: Implement, green. Commit.**

---

### Task 9: Phase 3 gates

- [ ] **Auth gate:** Task 1 e2e matrix green, proxy behaviour verified, cookies audited in the response (HttpOnly, Secure in prod, SameSite=Lax), api-key never falls back to session.
- [ ] **Tenancy gate:** Task 3 isolation tests green **with the extension disabled**; extension throw test green; PgBouncer test green; `EXPLAIN` recorded; a query on a tenant-scoped model outside any context produces a stack trace, never an empty list (e2e on a deliberately broken route that is deleted after the proof).
- [ ] **Authz gate:** registry-driven, default deny proven, principal types covered, deny reasons in logs and not in bodies.
- [ ] `pnpm nx reset && pnpm verify && pnpm knip`; `pnpm dev` smoke in vi and en; two independent review rounds on the full diff; fix; commit `chore: phase 3 auth, tenancy, authz complete`.
- [ ] Update `docs/upgrades.md` for every simplification taken (expected: ReBAC provider slot, secondary storage for sessions, email delivery via Mailpit only, `cross_tenant_admin_role` unused until an admin surface exists).
