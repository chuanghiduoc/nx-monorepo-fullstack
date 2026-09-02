# Phase 3 — Auth, Tenancy, Authz, i18n: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** After this phase a real product can start on the platform: users sign in (email/password, 2FA, device sessions), belong to organizations, are isolated from each other by PostgreSQL row-level security that holds even when application code is wrong, and every permission decision goes through one registry-driven facade that denies by default. The web app has auth screens, an organization switcher and vi/en.

**Architecture:** better-auth owns identity and organization membership (ADR-0002, mounted on Fastify). `Database.withTenantTransaction` from Phase 2 stays the only place tenant GUCs are set; RLS policies read them. A Prisma Client Extension *guards* (throws when a tenant-scoped model is queried without context) and never opens transactions. `libs/core/server/platform/authz` is a **pure** facade: the principal — user, active organization, roles, permission statements — is resolved once per request, before any transaction, and evaluated without touching the database.

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

### Task 0 ✅ DONE: Spike — prove the two assumptions the whole phase rests on

**Files:**
- Temporary: a spec under `libs/core/server/platform/data-access-db/src/lib/` (deleted at the end of the task)
- Create: `docs/adr/0003-authz-principal-resolution.md`

**Interfaces:**
- Produces: two verified facts, or a different design. Nothing else in Phase 3 starts until this task is done.

- [x] **Step 1: Is RLS testable at all today?** Against a fresh container, `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`. The harness connects as `postgres`, and `FORCE ROW LEVEL SECURITY` does not apply to superusers — so every isolation test would pass without a single policy in effect. Record the output.
- [x] **Step 2: Does better-auth throw inside a transaction?** Wire the Prisma adapter to the *proxied* root client and call `auth.api.getSession` (a) outside any transaction, (b) inside `withTenantTransaction`, (c) inside `withSystemTransaction`. Record which throw.
- [x] **Step 3: Write ADR-0003** with what was observed: where the principal is resolved, why the authz facade performs no database access, and the rule that `auth.api.*` runs outside transactions. If Step 2 does *not* throw, say so and explain what actually happens — the design follows the observation, not the other way round.
- [x] **Step 4: Delete the spike spec. Commit the ADR.**

---

### Task 1 ✅ DONE: Harness — a non-superuser connection, before any policy exists

**Files:**
- Modify: `libs/core/server/platform/testing/src/lib/postgres.ts`
- Modify: `apps/core/api-e2e/src/global-setup.ts`, `libs/core/server/platform/data-access-db/src/lib/migrations.spec.ts`
- Create: migration `..._database_roles` (+ `down.sql`), `tools/postgres/10-dev-logins.sh`
- Modify: `docker-compose.yml`, `.env.example`, `libs/core/server/platform/data-access-db/prisma7.config.ts`
- Modify: `docs/contracts/testing.md` — one line naming the rule: schema commands take `migrationUri`, application and isolation assertions take `connectionUri`
- Create: `docs/ops/database-roles.md` — the production `ALTER ROLE ... LOGIN PASSWORD` step and where the secret comes from

**Interfaces:**
- Produces: `startPostgres()` returning `{ connectionUri (app_user), migrationUri (owner), createDatabase, stop }`, with `DATABASE_URL` set to the **app_user** URI. Roles `app_user`, `worker_user`, `erasure_role`, `migration_role`, `cross_tenant_admin_role` exist with explicit `GRANT`/`REVOKE`.

- [x] **Step 1: Failing guard test** — first test of every future RLS suite, added now: `current_user` has `rolsuper = false` and `rolbypassrls = false`, and `SET ROLE postgres` fails. It must fail against today's harness. That failure is the evidence that Task 0 Step 1 was right.
- [x] **Step 2: Roles migration.** Cluster-wide objects inside a per-database migration history need care:
  - `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN CREATE ROLE app_user NOLOGIN; END IF; END $$;` — the migration replays into the shadow database in the same cluster, so a plain `CREATE ROLE` fails the second time.
  - `down.sql` does `REVOKE ALL` and `DROP OWNED BY` **in the current database** and does not `DROP ROLE` (state why: other databases in the cluster may still grant to it).
  - No password in the migration. `LOGIN PASSWORD` is granted by the compose init script for dev and by a documented step in `docs/ops/` for production.
  - `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;` — **without** `FOR ROLE migration_role`. Default privileges apply only to objects created by the named role, and migrations run as the owner, so the `FOR ROLE` form would never fire and a table added in Task 5 or 7 would be silently unreadable — which reads exactly like RLS working.
  - A test that makes the two forms distinguishable: create a table through `migrationUri`, then assert `app_user` can `SELECT` from it with no explicit grant.
- [x] **Step 3: Make the guard test pass** by switching the harness to `app_user`, keeping `migrationUri` for `migrate deploy`. Run the whole existing suite: every Phase 2 test must still pass against the restricted role — that is the real check that the grants are right. `migrations.spec.ts` moves to `migrationUri`: as `app_user` it can run neither `migrate deploy` nor `db execute`.
- [x] **Step 4: Fail loudly on a stale volume.** The compose init script runs only on an empty data directory, so a developer carrying a Phase 2 volume gets `password authentication failed for user "app_user"` from `pnpm dev` with nothing pointing at the fix. The API's boot check names the remedy (`docker compose down -v`); `docs/ops/database-roles.md` covers production.
- [x] **Step 5: Commit.**

---

### Task 2 ✅ DONE: better-auth on Prisma with the plugin set

**Files:**
- Modify: `apps/core/api/src/app/auth/auth.config.ts`, `auth.handler.ts`
- Modify: `libs/core/server/platform/data-access-db/prisma/schema.prisma`
- Create: migration `..._better_auth` (+ `down.sql`), `libs/core/server/platform/data-access-db/src/lib/auth/auth-database.ts`
- Modify: `libs/core/server/platform/core/src/lib/config/env.schema.ts` (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `APP_ORIGIN`)

**Interfaces:**
- Produces: `auth` with `prismaAdapter(authDatabase, { provider: 'postgresql' })`, plugins `organization({ dynamicAccessControl: { enabled: true }, ac, roles })`, `admin({ ac, roles })`, `twoFactor()`, `multiSession()`, `apiKey(...)`; `advanced.database.generateId: false` so PostgreSQL's `uuidv7()` stays the only id source; `enableSessionForAPIKeys` **off**.
- `authDatabase` is exported from data-access-db and is the proxied root client — the one sanctioned adapter seam. It throws if used inside a transaction, which is the behaviour Task 0 recorded and the rule the whole phase depends on.
- All better-auth tables are class **AUTH**: no RLS, `app_user` gets CRUD. A user must list every membership before any organization is active, and the adapter runs without GUCs. Their isolation is better-auth's own access control, and the threat model records that.

- [x] **Step 1: Docs first, and record the api-key facts.** better-auth 1.7.2's export map has organization, admin, two-factor and multi-session but **no `./plugins/api-key`** (verified against the installed package). API keys are the separate package `@better-auth/api-key` (1.7.2 on npm). Record: the package, its version, and **the exact option name** that stops a key from authenticating session routes — `enableSessionForAPIKeys` is what this plan expects, and it appears nowhere in the installed tree. Write Step 4's assertion against the name you read. Assuming an option name is how `nextCursor` shipped as an array for two commits.
- [x] **Step 2: Install** with `pnpm --filter core-api add better-auth @better-auth/api-key`, catalog the ranges.
- [x] **Step 3: Generate the schema, do not write it.** `pnpm dlx @better-auth/cli@latest generate --adapter prisma --dialect postgresql` against a **plugins-only config file** (the real `auth.config.ts` imports the data-access adapter and the CJS client, which the CLI loader may not resolve). Merge into `schema.prisma` with `@map`/`@@map` to snake_case, `@db.Uuid` ids defaulting to `uuidv7()`, `@db.Timestamptz(3)`. Then `prisma migrate dev --create-only`, review, generate `down.sql`.
- [x] **Step 4: Failing e2e (api-e2e).** Sign-up, sign-in, `get-session`, sign-out; 2FA enable → verify → sign-in requires a code; multi-session list/revoke; org create → invite → accept → `activeOrganizationId` on the session; admin ban → sign-in refused; impersonate → session carries `impersonatedBy`. API keys, both directions:
  - opt-in route + valid `x-api-key` → 200;
  - opt-in route + cookie only → 401;
  - **session-only route + valid `x-api-key` → 401** (this is what `enableSessionForAPIKeys: false` buys, and it is asserted, not assumed).
- [x] **Step 5: Implement, green.** `trustedOrigins` from `CORS_ORIGINS`. Rate limiting on better-auth's own routes uses `rateLimit.customStorage` on redis-critical — **not** `storage: 'secondary-storage'`, which would also move sessions into Redis and contradict the deferral recorded in `docs/upgrades.md`.
- [x] **Step 6: Behind a proxy — the right two assertions.** `X-Forwarded-For` changes `request.ip` (asserted through a log line or an echo route); cookie attributes are audited against a second instance booted with `NODE_ENV=production` and an https `BETTER_AUTH_URL`, because `Secure` comes from `useSecureCookies`, not from the header.
- [x] **Step 7: Commit.**

---

### Task 3 ✅ DONE: `libs/core/server/platform/authz` — a pure facade and the Principal

**Files:**
- Create: `libs/core/server/platform/authz` via `@nx/js:library` (tags `scope:core,platform:node,type:util`)
- Create: `src/lib/{action-registry,principal,authz.service,authz.errors}.ts` + specs

**Interfaces:**
- Produces: `Principal` (`{ type: 'user' | 'apiKey' | 'system', id, actorId?, orgId?, roles[], statements }`) — defined here because Task 4 resolves it; `ActionRegistry` (typed `<resource>.<verb>`, versioned, and the single source that *generates* better-auth's `createAccessControl` statements); `authz.can/require/canAny/canAll`; `ForbiddenProblem` (403 Problem Details, deny reason logged and never returned).
- **No database access.** Evaluation runs against the principal and the role definitions in memory. That is what makes it safe to call from inside a transaction, and it is the direct consequence of Task 0.

- [x] **Step 1: Failing unit tests (pure, no DB, no container):** unknown action → deny; unknown resource → deny; role grants → allow; ownership condition; api-key principal limited to the key's own permissions and never the issuer's; `effectiveUser` vs `actor` — the check uses effective, the audit context carries both; `require` throws the 403 Problem with type `…/forbidden` and no reason in the body; **the same test installs a capturing logger and asserts the denial record carries the action, the principal type and the reason** (§6.5 requires the reason as a log and audit event, and the authz gate claims it); a policy version bump invalidates a cached decision. The "unknown action" test casts through `unknown`, since a typed registry would otherwise refuse to compile it — the point is the runtime deny path.
- [x] **Step 2: Implement.** Deny is the default branch of an exhaustive `switch` over `Principal['type']`.
- [x] **Step 3: Commit.**

---

### Task 4 ✅ DONE: Tenant context — resolved once per request, before any transaction

**Files:**
- Create: `libs/core/server/platform/core/src/lib/tenancy/{request-context.storage,current-principal.decorator}.ts` + specs — the auth-agnostic half: the `AsyncLocalStorage` instance, the stored shape, the decorator
- Created: `libs/core/server/feature/auth/src/lib/tenant-context.hook.ts` — beside the auth capability, because it calls `auth.api.*`. The plan had put it in the application, since `auth` was application code at the time; Task 2 moved the whole capability into a library, which removed the constraint. A worker can now use the same resolution
- Create: `libs/core/server/platform/data-access-db/src/lib/transaction/with-request-transaction.ts` + spec
- Modify: `docs/contracts/transactions.md`, `docs/upgrades.md`

**Interfaces:**
- Produces: a Fastify `onRequest` hook that resolves the `Principal` **and** the `TenantContext` — from `x-api-key` via `auth.api.verifyApiKey`, otherwise from the session via `auth.api.getSession`, otherwise unauthenticated — and runs the rest of the request inside `AsyncLocalStorage.run`, passing Fastify's `done` as the callback. `Database.withRequestTransaction(work)` reads the stored `TenantContext` and delegates to `withTenantTransaction`.
- `db.tenant()` keeps the Phase 2 behaviour: it throws outside a transaction.
- **A deliberate deviation, recorded as one.** §6.5's auto-wrap prohibition is about the *Prisma extension*; the sentence above it does sanction the accessor opening a short transaction itself. We keep `tenant()` synchronous anyway, because an accessor that sometimes opens a transaction makes two consecutive calls two transactions with no atomicity between them, and nothing at the call site says so. `withRequestTransaction` is the explicit form. Constraint 7 applies: this becomes an entry in `docs/upgrades.md` that **replaces** the older one, and the entry says the spec sentence was read and traded away.

- [x] **Step 1: Failing tests.** The hook maps api-key / session / neither to the three shapes; the context is visible **inside the route handler**, not merely inside the hook; the api-key branch never consults cookies; `withRequestTransaction` throws with a clear message when there is no request context. Measured: `enterWith` inside an async hook does *not* reach the handler — three tests failed exactly that way — while running the continuation inside `AsyncLocalStorage.run` does.
- [x] **Step 2: Implemented** with a callback-style hook that calls `done` inside `AsyncLocalStorage.run`, which is the mechanism `@fastify/request-context` uses. No extra dependency was needed once the mechanism was right.
- [x] **Step 3: Update the contract docs.** `transactions.md` gains `withRequestTransaction`; the `docs/upgrades.md` entry about `tenant()` is **replaced** (today: synchronous, explicit form; signal: a read path where the explicit call is pure ceremony; steps: resolve the stored context inside `tenant()`, return a promise, migrate callers) — not deleted, so the next reader sees the trade rather than assuming it was missed.
- [x] **Step 4: Commit.**

---

### Task 5 ✅ DONE: RLS — policies on new reference tables

**Files:**
- Modify: `libs/core/server/platform/data-access-db/prisma/schema.prisma` — **required**: `migrations.spec.ts` diffs the migrated database against the schema and fails on any difference, so a table created only in SQL breaks the drift check
- Create: migrations `..._tenant_reference_tables`, `..._rls_policies` (+ `down.sql` each)
- Create: `libs/core/server/platform/data-access-db/prisma/policies/README.md` (the templates, copied verbatim into migrations)
- Modify: `docs/contracts/tenant-context.md` (write it for real)
- Modify: `libs/core/server/platform/testing/src/lib/postgres.ts` (a PgBouncer helper)

**Interfaces:**
- Produces: two new reference tables with `ENABLE` + `FORCE ROW LEVEL SECURITY` and the §6.5 policy template using `NULLIF(current_setting(..., true), '')::uuid`:
  - `notes` (**TENANT_OWNED**): uuidv7 id, `org_id NOT NULL @db.Uuid`, `title`, `body`, `version INT NOT NULL DEFAULT 1` (§6.17 requires optimistic concurrency on every mutable aggregate, and Task 8 returns 409 from it), `created_at`/`updated_at` `@db.Timestamptz(3)`, index `(org_id, created_at DESC, id DESC)` — the one Step 2's EXPLAIN asserts on — and the class comment Task 6's script reads.
  - `bookmarks` (**TENANT_OPTIONAL**): `org_id NULL`, `user_id NOT NULL`, same conventions.
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

### Task 6 ✅ DONE: the tenant guard (an accessor, not an extension)

**Files:**
- Create: `libs/core/server/platform/data-access-db/src/lib/tenancy/{tenant-scoped-models,tenant-guard.extension}.ts` + spec
- Create: `libs/core/server/platform/data-access-db/tools/list-tenant-models.ts` (beside `migration-history.ts`, so the spec can import it relatively; a root-level `tools/` file belongs to no project and has no path alias)
- Modify: `prisma.service.ts`

**Interfaces:**
- Produces: `TENANT_SCOPED_MODELS`, generated from the schema's class comments by a script and committed, with a test that fails when the file and the schema disagree; an extension that throws `NoTenantContextError` when an operation on a tenant-scoped model runs with `activeTransaction()?.context.kind === 'system'` or with no transaction. It **does not** open transactions and **does not** inject `where`: RLS is the boundary, the extension exists so a developer sees a stack trace instead of an empty list.

- [ ] **Step 1: Failing tests** — a tenant-scoped `findMany` inside `withSystemTransaction` throws; inside `withTenantTransaction` it passes; a GLOBAL model inside a system transaction passes; `$queryRaw` is not guarded (documented: raw SQL is the author's responsibility, and RLS still applies); an **unclassified model is a hard error**, never a default, because §6.5 says nothing is inferred. Add the missing class comments to the two existing models in the same step (`DemoItem` → GLOBAL, `IdempotencyRecord` → SYSTEM).
- [ ] **Step 2: Implement** with `$extends({ query: { $allModels: { $allOperations } } })`. **`$extends` returns a new client**, so applying it to anything other than what `Database` opens transactions on has no effect: `PrismaService` stays the Nest provider (keeping the lifecycle hooks and the root proxy) and gains a `readonly client = guardRootClient(this).$extends(tenantGuard)` built once in the constructor; `Database` opens transactions on `prisma.client`. Making `PrismaService` *be* the `$extends` result would drop the class methods Nest calls, so `onModuleInit`/`onModuleDestroy` would never run and the pool would neither open eagerly nor close.
- [ ] **Step 3: Prove the seam survived it** — the root-client refusal test still fires, and `onModuleDestroy` still closes the pool.
- [ ] **Step 4: Commit.**

---

### Task 7 ✅ DONE: `org_settings` and the IP allowlist guard

**Files:**
- Create: migration `..._org_settings` (**TENANT_OWNED**, `UNIQUE (org_id, key)`, `value JSONB`, `version INT`)
- Create: `libs/core/server/platform/core/src/lib/org-settings/setting-registry.ts` (pure Zod map, `type:util`)
- Create: `libs/core/server/platform/data-access-db/src/lib/org-settings/org-settings.repository.ts` (domain DTOs)
- Create: the service and `IpAllowlistGuard` in `apps/core/api` (an app may depend on both; `type:util` may not reach the database)
- Modify: `apps/core/api/src/main.ts` and `libs/core/server/platform/core/src/lib/config/env.schema.ts` — `trustProxy: true` trusts **every** hop, so a client-supplied `X-Forwarded-For` does change `request.ip` and the allowlist guard is worth nothing. It becomes configuration: the edge's address or CIDR, defaulting to the loopback edge in development

**Interfaces:**
- Produces: per-key Zod validation (unknown key → 400), `get`/`set` with an optimistic version check (409 on stale), and a guard reading `security.ipAllowlist` against `request.ip` — the value `trustProxy` resolves, never a header parsed by hand.

- [ ] **Step 1: Failing tests** — validation per key; stale write → 409 Problem; empty allowlist → allow; IP outside → 403; IPv6 and CIDR boundaries; a spoofed `X-Forwarded-For` from an **untrusted** hop does not change `request.ip`, while the same header from the configured edge does (Task 2 Step 6 asserts that direction; both must hold under one configuration).
- [ ] **Step 2: Implement, green. Commit.**

---

### Task 8 ✅ DONE: Reference feature — tenant-scoped CRUD

**Files:**
- Create: `libs/core/server/feature-notes` via the workspace generator (`type:feature`), and the notes repository in `data-access-db`
- Modify: `apps/core/api` (mount), `apps/core/api/openapi.json` + generated client (drift check)

**Interfaces:**
- Produces: `GET/POST/PATCH/DELETE /api/v1/notes` scoped by the request's organization through `withRequestTransaction`, `authz.require('note.<verb>')`, cursor pagination, optimistic concurrency (`version`, 409), `DELETE` idempotent 204.
- **Membership changes are not part of this.** better-auth's organization plugin owns `addMember`, `updateMemberRole`, `removeMember` with its own access control and hooks; a second write path around it would bypass them, and a `version` column on a plugin-managed table would be ignored by every plugin write.

- [ ] **Step 1: Failing e2e** — the §6.5 matrix: an org member sees only their org; an api key of org A cannot read org B; a user-only principal gets 403 on an org route; a stale PATCH → 409; two DELETEs → 204 twice.
- [ ] **Step 2: Implement, green. Commit.**

---

### Task 9: Web — auth screens, org switcher, device sessions, forms, i18n

**Files:**
- Create: `apps/core/web/src/app/(auth)/{sign-in,sign-up,two-factor}/page.tsx`, `src/app/(app)/{notes,settings/organizations,settings/devices}/page.tsx`, `src/proxy.ts`, `messages/{vi,en}.json`
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
- [ ] Update `docs/upgrades.md` for every simplification taken (expected: ReBAC provider slot, sessions not in secondary storage, email via Mailpit only, `cross_tenant_admin_role` unused until an admin surface exists, `db.tenant()` staying synchronous, and — since §7 Phase 3 ends with "user CRUD tenant-scoped" — **tenant-scoped member/user CRUD deferred to the organization plugin's own endpoints**: signal, a product needs a member list or a member field the plugin does not expose; steps, extend through the plugin's hooks and `additionalFields`, never a second table).

## What the finished tasks actually produced

| Task | Landed as | What it cost to find out |
|---|---|---|
| 0 | ADR recording two measured facts | the harness was a superuser, so a FORCE policy admitting one tenant returned both rows; and the auth adapter is refused inside a transaction |
| 1 | five database roles, an app_user harness, a boot check | the roles migration must be idempotent (cluster-wide objects, per-database history), and `ALTER DEFAULT PRIVILEGES FOR ROLE` would never have fired |
| 2 | auth on Prisma with organizations, 2FA, sessions, API keys | the schema generator lags the library by three minors: `account.issuer` was missing and every sign-up returned 500 |
| 3 | the authz facade, 24 unit tests | — |
| 4 | request context, `withRequestTransaction`, `/api/whoami` | `enterWith` in an async Fastify hook does not reach the route handler; the continuation must run inside `AsyncLocalStorage.run` |

Two things were also corrected outside the plan: server libraries were grouped
into `platform/` and `feature/` with `nx g @nx/workspace:move`, and `prisma-down`
now refuses to overwrite a hand-written rollback script — it had already
replaced one with an empty skeleton.

## Task order and why

`0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11`.

The spike comes first because two P0 design questions have no answer without running something. The harness must connect as a restricted role before any policy is written, or the isolation tests would pass vacuously. `authz` (Task 3) precedes the request hook (Task 4) because the hook resolves a `Principal`, whose type lives in the facade. Policies (5) precede the guard extension (6) so the isolation tests exercise RLS alone. The reference feature (8) needs all of it, and the UI (9) needs the feature.
