# Phase 3 — Auth, Tenancy, Authz, i18n: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** After this phase a real product can start on the platform: users sign in (email/password, 2FA, device sessions), belong to organizations, are isolated from each other by PostgreSQL row-level security that holds even when application code is wrong, and every permission decision goes through one registry-driven facade that denies by default. The web app has auth screens, an organization switcher and vi/en.

**Architecture:** better-auth owns identity and organization membership (ADR-0002, mounted on Fastify). `Database.withTenantTransaction` from Phase 2 stays the only place tenant GUCs are set; RLS policies read them. A Prisma Client Extension *guards* (throws when a tenant-scoped model is queried without context) and never opens transactions. `libs/core/server/authz` is a **pure** facade: the principal — user, active organization, roles, permission statements — is resolved once per request, before any transaction, and evaluated without touching the database.

**Tech Stack:** better-auth 1.7 (+ organization, admin, two-factor, multi-session, api-key plugins), Prisma 7, PostgreSQL 18 RLS, `@nestjs/*` 11, Zod 4, Next 16, next-intl, react-hook-form + `@hookform/resolvers/zod`, shadcn/ui, Playwright, Vitest + Testcontainers (`@workspace/core-server-testing`).

**Spec:** §6.5 (tenant context, RLS, authz), §6.14 (security), §6.17 (roles, migrations), §6.18 (routing), §6.19 (contract artifacts), §7 Phase 3, §8 (testing), §9 (risks).

## Global Constraints

- Same as Phases 1–2: no hand-written versions; every library and schema comes from its own CLI or generator (`pnpm add`, `@nx/js:library`, `pnpm dlx @better-auth/cli generate`, `prisma migrate dev --create-only`); every deliberate simplification is an entry in `docs/upgrades.md`; conventional commits; `pnpm verify && pnpm knip` green before each commit.
- **Fetch the vendor docs before each task and follow them.** The Phase 2 record shows what assuming costs: `nextCursor` shipped as `Array<string>` for two commits because nobody read the generated types.
- Every RLS policy, `GRANT`/`REVOKE`, role and `CHECK` lives in a Prisma migration written with `--create-only`, with a reviewed `down.sql` beside it. Never applied by hand.
- Tenant-scoped tables declare their class (`GLOBAL` | `TENANT_OWNED` | `TENANT_OPTIONAL` | `SYSTEM` | `AUTH`) in a schema comment; the class decides the policy template. Nothing is inferred from a column name.
- **`auth.api.*` is never called while a `Database` transaction is active.** The better-auth Prisma adapter talks to the root client, which the Phase 2 proxy refuses inside a transaction. Task 0 proves this; the design follows from it.
- Three separate exit gates (auth, tenancy, authz). A green UI does not close a red gate.
- Working directory: `D:/nx-monorepo-fullstack/nx-monorepo-fullstack`; `docker compose up -d` running.

---

### Task 0: Spike — prove the two assumptions the whole phase rests on

**Files:**
- Temporary: a spec under `libs/core/server/data-access-db/src/lib/` (deleted at the end of the task)
- Create: `docs/adr/0003-authz-principal-resolution.md`

**Interfaces:**
- Produces: two verified facts, or a different design. Nothing else in Phase 3 starts until this task is done.

- [ ] **Step 1: Is RLS testable at all today?** Against a fresh container, `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`. The harness connects as `postgres`, and `FORCE ROW LEVEL SECURITY` does not apply to superusers — so every isolation test would pass without a single policy in effect. Record the output.
- [ ] **Step 2: Does better-auth throw inside a transaction?** Wire the Prisma adapter to the *proxied* root client and call `auth.api.getSession` (a) outside any transaction, (b) inside `withTenantTransaction`, (c) inside `withSystemTransaction`. Record which throw.
- [ ] **Step 3: Write ADR-0003** with what was observed: where the principal is resolved, why the authz facade performs no database access, and the rule that `auth.api.*` runs outside transactions. If Step 2 does *not* throw, say so and explain what actually happens — the design follows the observation, not the other way round.
- [ ] **Step 4: Delete the spike spec. Commit the ADR.**

---

### Task 1: Harness — a non-superuser connection, before any policy exists

**Files:**
- Modify: `libs/core/server/testing/src/lib/postgres.ts`
- Modify: `apps/core/api-e2e/src/global-setup.ts`
- Create: migration `..._database_roles` (+ `down.sql`)
- Modify: `docker-compose.yml` (init SQL granting the dev login), `.env.example`

**Interfaces:**
- Produces: `startPostgres()` returning `{ connectionUri (app_user), migrationUri (owner), createDatabase, stop }`, with `DATABASE_URL` set to the **app_user** URI. Roles `app_user`, `worker_user`, `erasure_role`, `migration_role`, `cross_tenant_admin_role` exist with explicit `GRANT`/`REVOKE`.

- [ ] **Step 1: Failing guard test** — first test of every future RLS suite, added now: `current_user` has `rolsuper = false` and `rolbypassrls = false`, and `SET ROLE postgres` fails. It must fail against today's harness. That failure is the evidence that Task 0 Step 1 was right.
- [ ] **Step 2: Roles migration.** Cluster-wide objects inside a per-database migration history need care:
  - `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN CREATE ROLE app_user NOLOGIN; END IF; END $$;` — the migration replays into the shadow database in the same cluster, so a plain `CREATE ROLE` fails the second time.
  - `down.sql` does `REVOKE ALL` and `DROP OWNED BY` **in the current database** and does not `DROP ROLE` (state why: other databases in the cluster may still grant to it).
  - No password in the migration. `LOGIN PASSWORD` is granted by the compose init script for dev and by a documented step in `docs/ops/` for production.
  - `ALTER DEFAULT PRIVILEGES FOR ROLE migration_role IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;` so a future table is not silently unreadable.
- [ ] **Step 3: Make the guard test pass** by switching the harness to `app_user`, keeping `migrationUri` for `migrate deploy`. Run the whole existing suite: every Phase 2 test must still pass against the restricted role — that is the real check that the grants are right.
- [ ] **Step 4: Commit.**

---

### Task 2: better-auth on Prisma with the plugin set

**Files:**
- Modify: `apps/core/api/src/app/auth/auth.config.ts`, `auth.handler.ts`
- Modify: `libs/core/server/data-access-db/prisma/schema.prisma`
- Create: migration `..._better_auth` (+ `down.sql`), `libs/core/server/data-access-db/src/lib/auth/auth-database.ts`
- Modify: `libs/core/server/core/src/lib/config/env.schema.ts` (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `APP_ORIGIN`)

**Interfaces:**
- Produces: `auth` with `prismaAdapter(authDatabase, { provider: 'postgresql' })`, plugins `organization({ dynamicAccessControl: { enabled: true }, ac, roles })`, `admin({ ac, roles })`, `twoFactor()`, `multiSession()`, `apiKey(...)`; `advanced.database.generateId: false` so PostgreSQL's `uuidv7()` stays the only id source; `enableSessionForAPIKeys` **off**.
- `authDatabase` is exported from data-access-db and is the proxied root client — the one sanctioned adapter seam. It throws if used inside a transaction, which is the behaviour Task 0 recorded and the rule the whole phase depends on.
- All better-auth tables are class **AUTH**: no RLS, `app_user` gets CRUD. A user must list every membership before any organization is active, and the adapter runs without GUCs. Their isolation is better-auth's own access control, and the threat model records that.

- [ ] **Step 1: Docs first.** better-auth: adapters/prisma, concepts/cli, concepts/database (`generateId`), plugins organization / admin / two-factor / multi-session / api-key. Record installed versions.
- [ ] **Step 2: Install** with `pnpm --filter core-api add`, catalog the ranges.
- [ ] **Step 3: Generate the schema, do not write it.** `pnpm dlx @better-auth/cli@latest generate --adapter prisma --dialect postgresql` against a **plugins-only config file** (the real `auth.config.ts` imports the data-access adapter and the CJS client, which the CLI loader may not resolve). Merge into `schema.prisma` with `@map`/`@@map` to snake_case, `@db.Uuid` ids defaulting to `uuidv7()`, `@db.Timestamptz(3)`. Then `prisma migrate dev --create-only`, review, generate `down.sql`.
- [ ] **Step 4: Failing e2e (api-e2e).** Sign-up, sign-in, `get-session`, sign-out; 2FA enable → verify → sign-in requires a code; multi-session list/revoke; org create → invite → accept → `activeOrganizationId` on the session; admin ban → sign-in refused; impersonate → session carries `impersonatedBy`. API keys, both directions:
  - opt-in route + valid `x-api-key` → 200;
  - opt-in route + cookie only → 401;
  - **session-only route + valid `x-api-key` → 401** (this is what `enableSessionForAPIKeys: false` buys, and it is asserted, not assumed).
- [ ] **Step 5: Implement, green.** `trustedOrigins` from `CORS_ORIGINS`. Rate limiting on better-auth's own routes uses `rateLimit.customStorage` on redis-critical — **not** `storage: 'secondary-storage'`, which would also move sessions into Redis and contradict the deferral recorded in `docs/upgrades.md`.
- [ ] **Step 6: Behind a proxy — the right two assertions.** `X-Forwarded-For` changes `request.ip` (asserted through a log line or an echo route); cookie attributes are audited against a second instance booted with `NODE_ENV=production` and an https `BETTER_AUTH_URL`, because `Secure` comes from `useSecureCookies`, not from the header.
- [ ] **Step 7: Commit.**

---

### Task 3: `libs/core/server/authz` — a pure facade and the Principal

**Files:**
- Create: `libs/core/server/authz` via `@nx/js:library` (tags `scope:core,platform:node,type:util`)
- Create: `src/lib/{action-registry,principal,authz.service,authz.errors}.ts` + specs

**Interfaces:**
- Produces: `Principal` (`{ type: 'user' | 'apiKey' | 'system', id, actorId?, orgId?, roles[], statements }`) — defined here because Task 4 resolves it; `ActionRegistry` (typed `<resource>.<verb>`, versioned, and the single source that *generates* better-auth's `createAccessControl` statements); `authz.can/require/canAny/canAll`; `ForbiddenProblem` (403 Problem Details, deny reason logged and never returned).
- **No database access.** Evaluation runs against the principal and the role definitions in memory. That is what makes it safe to call from inside a transaction, and it is the direct consequence of Task 0.

- [ ] **Step 1: Failing unit tests (pure, no DB, no container):** unknown action → deny; unknown resource → deny; role grants → allow; ownership condition; api-key principal limited to the key's own permissions and never the issuer's; `effectiveUser` vs `actor` — the check uses effective, the audit context carries both; `require` throws the 403 Problem with type `…/forbidden` and no reason in the body; a policy version bump invalidates a cached decision. The "unknown action" test casts through `unknown`, since a typed registry would otherwise refuse to compile it — the point is the runtime deny path.
- [ ] **Step 2: Implement.** Deny is the default branch of an exhaustive `switch` over `Principal['type']`.
- [ ] **Step 3: Commit.**

---

### Task 4: Tenant context — resolved once per request, before any transaction

**Files:**
- Create: `libs/core/server/core/src/lib/tenancy/{request-context.storage,tenant-context.hook,current-principal.decorator}.ts` + specs
- Create: `libs/core/server/data-access-db/src/lib/transaction/with-request-transaction.ts` + spec
- Modify: `docs/contracts/transactions.md`, `docs/upgrades.md`

**Interfaces:**
- Produces: a Fastify `onRequest` hook that resolves the `Principal` **and** the `TenantContext` — from `x-api-key` via `auth.api.verifyApiKey`, otherwise from the session via `auth.api.getSession`, otherwise unauthenticated — and stores them with `storage.enterWith(...)`. `Database.withRequestTransaction(work)` reads the stored `TenantContext` and delegates to `withTenantTransaction`.
- `db.tenant()` keeps the Phase 2 behaviour: it throws outside a transaction. It is synchronous, and making it open one would be the auto-wrap the spec forbids (§6.5) — two consecutive calls would silently become two transactions.

- [ ] **Step 1: Failing tests.** The hook maps api-key / session / neither to the three shapes; the context is visible **inside a Nest guard and inside a service method**, not merely inside the hook (`AsyncLocalStorage.run` in a Fastify hook does not survive into the handler — `enterWith` does, which is what `@fastify/request-context` uses); the api-key branch never consults cookies; `withRequestTransaction` throws with a clear message when there is no request context.
- [ ] **Step 2: Implement.** Registering `@fastify/request-context` is acceptable if it turns out to carry the storage more reliably than a hand-rolled `enterWith` — decide from the test, not from taste.
- [ ] **Step 3: Update the contract docs** (the `tenant()` upgrades entry is replaced by this design; `transactions.md` gains `withRequestTransaction`).
- [ ] **Step 4: Commit.**

---

### Task 5: RLS — policies on new reference tables

**Files:**
- Create: migrations `..._tenant_reference_tables`, `..._rls_policies` (+ `down.sql` each)
- Create: `libs/core/server/data-access-db/prisma/policies/README.md` (the templates, copied verbatim into migrations)
- Modify: `docs/contracts/tenant-context.md` (write it for real)
- Modify: `libs/core/server/testing/src/lib/postgres.ts` (a PgBouncer helper)

**Interfaces:**
- Produces: two new reference tables — `notes` (**TENANT_OWNED**: `org_id NOT NULL`) and `bookmarks` (**TENANT_OPTIONAL**: `org_id NULL`, `user_id NOT NULL`) — with `ENABLE` + `FORCE ROW LEVEL SECURITY` and the §6.5 policy template using `NULLIF(current_setting(..., true), '')::uuid`.
- **`demo_items` stays GLOBAL.** It is the reference for the global pattern, it is read by an unauthenticated page and by four e2e suites through `withSystemTransaction`, and giving it an `org_id` would need a seed organization inside a migration — which §6.17 forbids.

- [ ] **Step 1: Access-pattern note** (Database Workflow Step 0, one page): the queries these tables serve, expected volume, and why every index leads with `org_id` (RLS adds that predicate to every plan).
- [ ] **Step 2: Failing integration tests, on the `app_user` connection from Task 1:**
  - org A cannot see org B's rows — **with the guard extension not yet in place**, so this is RLS alone;
  - a user-only context sees only `org_id IS NULL AND user_id = me` on the optional table, and nothing on the owned table;
  - with no GUC set, the owned table returns nothing (which is why Task 6's extension must throw first);
  - `app_user` cannot `SET ROLE`, cannot bypass RLS, and has only the granted rights on SYSTEM tables;
  - PgBouncer in transaction mode: two interleaved transactions from different orgs never see each other's GUC;
  - `EXPLAIN (ANALYZE, BUFFERS)` on ≥100k rows across ≥2 orgs after `ANALYZE` — assert an Index Scan on `(org_id, created_at DESC, id DESC)` and `Rows Removed by Filter = 0`. On a ten-row table the planner picks a sequential scan whatever the index says, and recording that would be evidence of nothing.
- [ ] **Step 3: Migrations, green.** Policies pasted from the template; `down.sql` drops policies and disables RLS in the right order.
- [ ] **Step 4: Commit.**

---

### Task 6: Prisma Client Extension — the guard

**Files:**
- Create: `libs/core/server/data-access-db/src/lib/tenancy/{tenant-scoped-models,tenant-guard.extension}.ts` + spec
- Create: `tools/list-tenant-models.ts` (reads the class comments in `schema.prisma`)
- Modify: `prisma.service.ts`

**Interfaces:**
- Produces: `TENANT_SCOPED_MODELS`, generated from the schema's class comments by a script and committed, with a test that fails when the file and the schema disagree; an extension that throws `NoTenantContextError` when an operation on a tenant-scoped model runs with `activeTransaction()?.context.kind === 'system'` or with no transaction. It **does not** open transactions and **does not** inject `where`: RLS is the boundary, the extension exists so a developer sees a stack trace instead of an empty list.

- [ ] **Step 1: Failing tests** — a tenant-scoped `findMany` inside `withSystemTransaction` throws; inside `withTenantTransaction` it passes; a GLOBAL model inside a system transaction passes; `$queryRaw` is not guarded (documented: raw SQL is the author's responsibility, and RLS still applies); the Phase 2 root-client refusal still fires after `$extends`.
- [ ] **Step 2: Implement** with `$extends({ query: { $allModels: { $allOperations } } })`.
- [ ] **Step 3: Commit.**

---

### Task 7: `org_settings` and the IP allowlist guard

**Files:**
- Create: migration `..._org_settings` (**TENANT_OWNED**, `UNIQUE (org_id, key)`, `value JSONB`, `version INT`)
- Create: `libs/core/server/core/src/lib/org-settings/setting-registry.ts` (pure Zod map, `type:util`)
- Create: `libs/core/server/data-access-db/src/lib/org-settings/org-settings.repository.ts` (domain DTOs)
- Create: the service and `IpAllowlistGuard` in `apps/core/api` (an app may depend on both; `type:util` may not reach the database)

**Interfaces:**
- Produces: per-key Zod validation (unknown key → 400), `get`/`set` with an optimistic version check (409 on stale), and a guard reading `security.ipAllowlist` against `request.ip` — the value `trustProxy` resolves, never a header parsed by hand.

- [ ] **Step 1: Failing tests** — validation per key; stale write → 409 Problem; empty allowlist → allow; IP outside → 403; IPv6 and CIDR boundaries; a spoofed `X-Forwarded-For` from an untrusted hop does not change `request.ip`.
- [ ] **Step 2: Implement, green. Commit.**

---

### Task 8: Reference feature — tenant-scoped CRUD

**Files:**
- Create: `libs/core/server/feature-notes` via the workspace generator (`type:feature`)
- Modify: `apps/core/api` (mount), `apps/core/api/openapi.json` + generated client (drift check)

**Interfaces:**
- Produces: `GET/POST/PATCH/DELETE /api/v1/notes` scoped by the request's organization through `withRequestTransaction`, `authz.require('note.<verb>')`, cursor pagination, optimistic concurrency (`version`, 409), `DELETE` idempotent 204.
- **Membership changes are not part of this.** better-auth's organization plugin owns `addMember`, `updateMemberRole`, `removeMember` with its own access control and hooks; a second write path around it would bypass them, and a `version` column on a plugin-managed table would be ignored by every plugin write.

- [ ] **Step 1: Failing e2e** — the §6.5 matrix: an org member sees only their org; an api key of org A cannot read org B; a user-only principal gets 403 on an org route; a stale PATCH → 409; two DELETEs → 204 twice.
- [ ] **Step 2: Implement, green. Commit.**

---

### Task 9: Web — auth screens, org switcher, device sessions, forms, i18n

**Files:**
- Create: `apps/core/web/src/app/(auth)/{sign-in,sign-up,two-factor}/page.tsx`, `src/app/(app)/settings/{organizations,devices}/page.tsx`, `src/proxy.ts`, `messages/{vi,en}.json`
- Create: `libs/shared/contracts` (`type:util`, `platform:shared`) — the Zod schemas both the API DTOs and the forms import
- Modify: `libs/shared/ui` (form primitives via `shadcn add form`), `libs/shared/i18n` (retag `platform:web`, since next-intl is Next-only), `docs/contracts/api-client.md` (the chain now starts in `libs/shared/contracts`)

**Interfaces:**
- Consumes: the better-auth client (with plugin clients) and the generated API client. The browser only ever sees the public edge origin (`NEXT_PUBLIC_APP_ORIGIN`); server components use `API_URL`.
- Includes the **impersonation banner** (§7 Phase 3 DoD, §9 risk table): while `impersonatedBy` is set, every page shows who is acting as whom, and leaving impersonation is one click.

- [ ] **Step 1: Docs first.** next-intl for Next 16 App Router; better-auth client plugins; react-hook-form + `zodResolver` with Zod 4.
- [ ] **Step 2: Move the demo DTO schemas** into `libs/shared/contracts`; the API keeps `createZodDto`, the form keeps `zodResolver`, and a test asserts both reject the same invalid input.
- [ ] **Step 3: Playwright e2e** (extend `global-setup` to start the API): sign-up → 2FA setup → sign-out → sign-in with a code; create org → switch → the notes page shows only that org; the devices page lists two sessions and revokes one; impersonation shows the banner; the same flow in `vi` and `en`, asserting translated headings and no missing-key fallbacks.
- [ ] **Step 4: Implement, green. Commit.**

---

### Task 10: Threat model

**Files:**
- Create: `docs/security/threat-model.md` (spec §6.19 lists it as a Phase 3 deliverable)

- [ ] **Step 1: Write it** against what now exists: trust boundaries (browser → edge → API → database), the AUTH table class and why it carries no RLS, api-key scope, impersonation, the IP allowlist, what an attacker gets from a forged cursor, and what the root-client proxy and RLS each protect against. Every claim names the test or the constraint that backs it.
- [ ] **Step 2: Commit.**

---

### Task 11: Phase 3 gates

- [ ] **Auth gate:** Task 2's matrix green, including both api-key directions and the proxy behaviour; cookie attributes audited on a production-mode instance.
- [ ] **Tenancy gate:** the `rolsuper`/`rolbypassrls` guard test green (so isolation is being tested at all); Task 5's isolation tests green **without** the guard extension; the extension's throw test green; PgBouncer green; `EXPLAIN` recorded on realistic volume.
- [ ] **Authz gate:** registry-driven checks, default deny proven, principal types covered, deny reasons in logs and not in bodies.
- [ ] `pnpm nx reset && pnpm verify && pnpm knip`; `pnpm dev` smoke in vi and en; two independent reviews of the full diff; fix; commit `chore: phase 3 auth, tenancy, authz complete`.
- [ ] Update `docs/upgrades.md` for every simplification taken (expected: ReBAC provider slot, sessions not in secondary storage, email via Mailpit only, `cross_tenant_admin_role` unused until an admin surface exists).

## Task order and why

`0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11`.

The spike comes first because two P0 design questions have no answer without running something. The harness must connect as a restricted role before any policy is written, or the isolation tests would pass vacuously. `authz` (Task 3) precedes the request hook (Task 4) because the hook resolves a `Principal`, whose type lives in the facade. Policies (5) precede the guard extension (6) so the isolation tests exercise RLS alone. The reference feature (8) needs all of it, and the UI (9) needs the feature.
