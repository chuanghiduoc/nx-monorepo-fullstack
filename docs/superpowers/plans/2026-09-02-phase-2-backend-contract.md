# Phase 2 — Backend core + API contract: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn `core-api` from a scaffold into a service with a real contract: Prisma on PostgreSQL 18 with UUIDv7, validated config, structured logging, RFC 9457 errors, rate limiting, durable idempotency, a generated type-safe client consumed by `core-web`, and a migration workflow that can be rolled back.

**Architecture:** Everything that more than one feature will need lands in `libs/core/server/core` (platform infrastructure), data access is confined to `libs/core/server/data-access-db`, and the OpenAPI document is a build artifact that drives client generation — never hand-written.

**Tech Stack:** Prisma 7, PostgreSQL 18, Zod + nestjs-zod, `@nestjs/swagger`, `@hey-api/openapi-ts`, nestjs-pino, `@nestjs/throttler`, `@fastify/helmet`, Scalar, Vitest + Testcontainers.

**Spec:** `docs/superpowers/specs/2026-09-01-nx-fullstack-boilerplate-design.md` — §5 (contract), §6.5 (tenant/transaction ownership), §6.14 (security), §6.17 (migrations), §7 Phase 2.

## Global Constraints

- Same as Phase 1: no hand-written versions (`pnpm add` / generators resolve them); every deliberate simplification gets an entry in `docs/upgrades.md`; conventional commits; `pnpm verify` green before each commit.
- New libraries are created with `pnpm nx g @org/workspace-plugin:feature-lib` or `@nx/js:library` — never by copying a folder.
- Working directory: `D:/nx-monorepo-fullstack/nx-monorepo-fullstack`.
- Docker compose must be running for integration work: `docker compose up -d`.
- Any Prisma/SQL that RLS or constraints depend on goes into a migration via `prisma migrate dev --create-only`, never applied by hand to a live database.

---

### Task 1: Spike — better-auth on Fastify (de-risk before anything depends on it)

**Files:**
- Create: `docs/adr/0002-better-auth-on-fastify.md`
- Temporary: a scratch route in `apps/core/api` (removed at the end of the task)

**Interfaces:**
- Produces: a recorded decision — which integration package (if any) is used, or which fallback is taken. Phase 3 depends on this answer.

- [ ] **Step 1: Check what exists today**

```bash
npm view better-auth version
npm view @better-auth/sso version
npm view nestjs-better-auth-fastify version 2>/dev/null || echo "candidate not published"
npm view @thallesp/nestjs-better-auth version 2>/dev/null || echo "candidate not published"
```
Record the versions you actually see; do not assume the ones named in the spec still exist.

- [ ] **Step 2: Install better-auth into core-api**

```bash
pnpm --filter core-api add better-auth
```

- [ ] **Step 3: Mount it on the Fastify adapter**

Follow better-auth's current documentation for a generic Node/Fastify handler (fetch the docs, do not write from memory). The goal is only: `GET /api/auth/ok` style route responds, and a session cookie round-trips. Prefer mounting better-auth's handler directly on the Fastify instance obtained via `app.getHttpAdapter().getInstance()` over adopting a third-party Nest wrapper, unless the wrapper is actively maintained and adds something the direct mount lacks.

- [ ] **Step 4: Prove it works**

```bash
pnpm nx build core-api
cd apps/core/api/dist && node main.js &
sleep 8
curl -si http://localhost:3000/api/auth/... | head -20   # the exact path depends on the handler
```
Expected: a 2xx/4xx response from better-auth (not a 404 from Nest), and a `Set-Cookie` header on a sign-up/sign-in attempt.

- [ ] **Step 5: Write ADR-0002 and remove the scratch route**

The ADR must state: package + version chosen, how it is mounted, cookie/session behaviour behind a reverse proxy (`X-Forwarded-*`), CSRF behaviour, whether organizations/api-key/impersonation plugins are available on this version, and the fallback if the chosen approach fails later.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "docs(adr): record better-auth on fastify integration decision"
```

---

### Task 2: data-access-db library with Prisma 7

**Files:**
- Create: `libs/core/server/data-access-db/**` (generator)
- Create: `libs/core/server/data-access-db/prisma/schema.prisma`
- Create: `libs/core/server/data-access-db/src/lib/prisma.service.ts`
- Test: `libs/core/server/data-access-db/src/lib/prisma.service.spec.ts`

**Interfaces:**
- Produces: `PrismaService` (a `PrismaClient` subclass with lifecycle hooks) exported from `@org/core-server-data-access-db`; the Prisma schema location for all later models.

- [ ] **Step 1: Generate the library**

```bash
pnpm nx g @nx/js:library libs/core/server/data-access-db \
  --name=core-server-data-access-db \
  --tags="scope:core,platform:node,type:data-access" --no-interactive
```

- [ ] **Step 2: Install and initialise Prisma 7**

```bash
pnpm --filter core-server-data-access-db add @prisma/client@7
pnpm --filter core-server-data-access-db add -D prisma@7
cd libs/core/server/data-access-db && pnpm exec prisma init --datasource-provider postgresql
```
Check what `prisma init` created (Prisma ≥6.18 also writes `prisma.config.ts`) and keep its output rather than reshaping it.

- [ ] **Step 3: Write the first model with the conventions the spec fixes**

`schema.prisma` gets a `HealthProbe`-style demo model plus the conventions every later model must follow: UUIDv7 primary key generated by the database, `TIMESTAMPTZ` timestamps.

```prisma
model DemoItem {
  id        String   @id @default(dbgenerated("uuidv7()")) @db.Uuid
  title     String   @db.VarChar(200)
  createdAt DateTime @default(now()) @db.Timestamptz(6)
  updatedAt DateTime @updatedAt @db.Timestamptz(6)

  @@map("demo_items")
}
```

- [ ] **Step 4: Create the migration**

```bash
cd libs/core/server/data-access-db
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app pnpm exec prisma migrate dev --name init_demo_item
```
Expected: a migration directory is created and applied. Verify the default landed in the database, not just in the schema:

```bash
docker compose exec -T postgres psql -U postgres -d app -c "\d demo_items"
```
Expected: `id` column default is `uuidv7()`.

- [ ] **Step 5: PrismaService with lifecycle hooks**

```typescript
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }
}
```

- [ ] **Step 6: Test it against a real database (Testcontainers)**

```bash
pnpm --filter core-server-data-access-db add -D @testcontainers/postgresql
```
The test starts a `postgres:18-alpine` container, applies migrations with `prisma migrate deploy`, inserts a row, and asserts the generated id is a UUID **version 7** (the 13th hex character is `7`) — that is what proves the database default is doing the work.

- [ ] **Step 7: Run and commit**

```bash
pnpm nx test core-server-data-access-db
git add -A && git commit -m "feat(data-access-db): prisma 7 on postgres 18 with database-generated uuidv7"
```

---

### Task 3: core library — validated configuration

**Files:**
- Create: `libs/core/server/core/**` (generator)
- Create: `libs/core/server/core/src/lib/config/env.schema.ts`, `config.module.ts`
- Test: `libs/core/server/core/src/lib/config/env.schema.spec.ts`

**Interfaces:**
- Produces: `AppConfigModule` (global) and a typed `AppConfig` read from `@org/core-server-core`. Later tasks read `DATABASE_URL`, `REDIS_CRITICAL_URL`, `REDIS_CACHE_URL` through it, never `process.env` directly.

- [ ] **Step 1: Generate the library and install dependencies**

```bash
pnpm nx g @nx/js:library libs/core/server/core \
  --name=core-server-core --tags="scope:core,platform:node,type:util" --no-interactive
pnpm --filter core-server-core add @nestjs/config zod
```

- [ ] **Step 2: Write the failing test first**

```typescript
import { describe, it, expect } from 'vitest';
import { envSchema } from './env.schema';

describe('envSchema', () => {
  it('rejects a missing DATABASE_URL with a readable message', () => {
    const result = envSchema.safeParse({});
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('DATABASE_URL');
  });

  it('rejects a DATABASE_URL that is not a postgres url', () => {
    const result = envSchema.safeParse({ DATABASE_URL: 'mysql://x' });
    expect(result.success).toBe(false);
  });

  it('defaults PORT to 3000 when unset', () => {
    const parsed = envSchema.parse({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/app',
      REDIS_CRITICAL_URL: 'redis://localhost:6379',
      REDIS_CACHE_URL: 'redis://localhost:6380',
    });
    expect(parsed.PORT).toBe(3000);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
pnpm nx test core-server-core
```
Expected: FAIL — `env.schema` does not exist.

- [ ] **Step 4: Implement the schema and the module**

The schema validates `NODE_ENV`, `PORT`, `DATABASE_URL`, `REDIS_CRITICAL_URL`, `REDIS_CACHE_URL`, `LOG_LEVEL`, `CORS_ORIGINS`. `ConfigModule.forRoot({ isGlobal: true, validate })` runs the schema so the process fails at boot, not at first use.

- [ ] **Step 5: Green, then wire into core-api and commit**

```bash
pnpm nx test core-server-core
pnpm nx build core-api
git add -A && git commit -m "feat(core): fail-fast environment validation with zod"
```

---

### Task 4: Structured logging with request ids

**Files:**
- Modify: `libs/core/server/core/src/lib/logging/*`
- Modify: `apps/core/api/src/main.ts`, `app.module.ts`

- [ ] **Step 1: Install**

```bash
pnpm --filter core-server-core add nestjs-pino pino-http
pnpm --filter core-api add -D pino-pretty
```

- [ ] **Step 2: Configure**

JSON to stdout; `pino-pretty` only when `NODE_ENV !== 'production'`; redact `req.headers.authorization` and `req.headers.cookie`; generate a request id per request and return it as `X-Request-Id`.

- [ ] **Step 3: Prove the redaction works (test, not eyeballing)**

A test feeds a request with an `authorization` header through the configured serializer and asserts the output contains `[Redacted]` and not the token value.

- [ ] **Step 4: Verify end to end**

```bash
pnpm nx build core-api && cd apps/core/api/dist && node main.js &
sleep 8 && curl -si http://localhost:3000/api | grep -i x-request-id
```
Expected: the header is present, and the process log line for that request is JSON containing the same id.

- [ ] **Step 5: Commit**

---

### Task 5: RFC 9457 problem details

**Files:**
- Create: `libs/core/server/core/src/lib/errors/problem-details.filter.ts`, `problem-details.ts`
- Test: `.../problem-details.filter.spec.ts`
- Create: `docs/contracts/problem-details.md` (replaces the scaffold)

**Interfaces:**
- Produces: `ProblemDetailsFilter` (registered globally) and the `ProblemDetails` type reused by the OpenAPI document.

- [ ] **Step 1: Write the failing tests**

Cover: a `NotFoundException` becomes `application/problem+json` with `status: 404` and a stable `type`; a Zod validation failure produces `errors[]` entries carrying `path` and `message`; a 429 carries `Retry-After`; an unexpected `Error` becomes a 500 whose `detail` does **not** leak the internal message; every response carries `traceId`.

- [ ] **Step 2: Run, watch fail, implement, run green.**

- [ ] **Step 3: Register globally in `core-api` and re-run the api build.**

- [ ] **Step 4: Write `docs/contracts/problem-details.md`** — the error type registry (one row per `type` URI), the Zod mapping, and the rule that `detail` never contains an internal message.

- [ ] **Step 5: Commit**

---

### Task 6: Security middleware — helmet, CORS, CSRF origin check

**Files:**
- Modify: `apps/core/api/src/main.ts`
- Create: `libs/core/server/core/src/lib/security/origin-check.guard.ts` + spec

- [ ] **Step 1: Install** `pnpm --filter core-api add @fastify/helmet`

- [ ] **Step 2: Failing tests for the origin check** — a state-changing request (`POST`) with a foreign `Origin` is rejected with 403; with an allowed origin it passes; a `GET` is never blocked; requests without an `Origin` header (server-to-server) are allowed only when they carry an API key (documented, tested).

- [ ] **Step 3: Implement, register, verify with curl against the built bundle.**

- [ ] **Step 4: Commit**

---

### Task 7: Rate limiting on Redis

**Files:**
- Modify: `libs/core/server/core` (throttler module wiring)
- Test: integration test with a real Redis container

- [ ] **Step 1: Install** `@nestjs/throttler` and the Redis storage package that its current docs recommend (check the docs; the package name has changed across versions).

- [ ] **Step 2: Failing integration test** — N+1 requests within the window produce a 429 whose body is a Problem Details document and whose headers include `Retry-After`.

- [ ] **Step 3: Implement against `REDIS_CRITICAL_URL`** (rate limiting is in the critical role per spec §3 — a cache eviction must not reset limits).

- [ ] **Step 4: Commit**

---

### Task 8: Durable idempotency

**Files:**
- Create: migration for `idempotency_records`
- Create: `libs/core/server/core/src/lib/idempotency/*` + specs
- Create: `docs/contracts/idempotency.md` (replaces scaffold)

**Interfaces:**
- Produces: an `@Idempotent()` route decorator/interceptor; the table shape later phases rely on.

- [ ] **Step 1: Migration** — `UNIQUE(scope_type, scope_id, route, idempotency_key)` with **every column NOT NULL** (spec §5.5: a nullable tenant column would let duplicates through, because `NULL != NULL` in a unique index), plus `state`, `request_hash`, `response_status`, `response_body`, `started_at`, `lease_until`, `fence_token`, `completed_at` and an index on `completed_at` for the cleanup job.

- [ ] **Step 2: Failing tests** (integration, real Postgres): first call executes and stores; replay with the same key returns the stored status and body without re-executing (assert with a spy that the handler ran once); a concurrent second call while `PROCESSING` and the lease is valid gets 409 + `Retry-After`; the same key with a different `request_hash` gets 422; an expired lease can be reclaimed and the reclaiming request gets `fence_token + 1`; a stale writer holding the old token cannot mark the record `COMPLETED`.

- [ ] **Step 3: Implement, green, document the contract file.**

- [ ] **Step 4: Commit**

---

### Task 9: OpenAPI document as a build artifact

**Files:**
- Create: `apps/core/api/src/openapi.ts` (emit-and-exit entry)
- Modify: `apps/core/api/project.json` (an `openapi` target)
- Create: `apps/core/api/openapi.json` (committed artifact)

**Interfaces:**
- Produces: `nx run core-api:openapi` writes `openapi.json`; the client generation task depends on it.

- [ ] **Step 1: Install** `pnpm --filter core-api add @nestjs/swagger nestjs-zod`

- [ ] **Step 2: A demo endpoint with a Zod DTO** — `GET /api/v1/demo-items` returning the cursor page shape and `POST /api/v1/demo-items` returning 201 + `Location`. Register `ProblemDetails` as a global response schema.

- [ ] **Step 3: Emit-and-exit entry** — bootstraps the Nest application context without listening, writes `openapi.json`, exits 0.

- [ ] **Step 4: Wire the target and run it**

```bash
pnpm nx run core-api:openapi
node -e "const d=require('./apps/core/api/openapi.json');console.log(Object.keys(d.paths))"
```
Expected: the demo paths are listed and the `ProblemDetails` schema is present in components.

- [ ] **Step 5: Commit**

---

### Task 10: Generated client + drift check

**Files:**
- Modify: `libs/shared/api-client-core/**` (generated output + config)
- Modify: `apps/core/web` (consume the generated client)
- Modify: `.github/workflows/ci.yml` (drift step)

- [ ] **Step 1: Install** `@hey-api/openapi-ts` and its TanStack Query plugin at the exact versions its docs instruct (it is pre-1.0; the vendor asks for exact pins — record that in `docs/sources.md`).

- [ ] **Step 2: Generation target** — `nx run shared-api-client-core:generate` reads `apps/core/api/openapi.json` and writes into `libs/shared/api-client-core/src`. Declare `dependsOn: ["core-api:openapi"]` so the chain is one command.

- [ ] **Step 3: Consume it in `core-web`** — a server component listing demo items through the generated client. This is what makes a contract break a compile error.

- [ ] **Step 4: Prove the contract chain works** — rename a field in the Zod DTO, run `pnpm nx affected -t build`, and confirm `core-web` fails to compile. Restore it and confirm green. (Do this in the working tree; do not commit the broken state.)

- [ ] **Step 5: CI drift step**

```yaml
- run: pnpm nx run core-api:openapi && pnpm nx run shared-api-client-core:generate
- run: git diff --exit-code -- apps/core/api/openapi.json libs/shared/api-client-core/src
```

- [ ] **Step 6: Commit**

---

### Task 11: Cursor pagination helpers

**Files:**
- Create: `libs/core/server/core/src/lib/pagination/*` + specs

- [ ] **Step 1: Failing unit tests** — `encodeCursor`/`decodeCursor` round-trip a `{ createdAt, id, filterHash, direction }` payload; the encoded value is opaque (base64url, not readable JSON); decoding a cursor whose `filterHash` does not match the current query throws the error that maps to 400; an empty page returns `nextCursor: null`.

- [ ] **Step 2: Implement, green.**

- [ ] **Step 3: Use it in the demo list endpoint** with a keyset query (`WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT n`), and an integration test that pages through more rows than one page holds and never repeats or skips a row while a new row is inserted between pages.

- [ ] **Step 4: Commit**

---

### Task 12: Migration workflow — rollback, drift check, CI

**Files:**
- Create: `libs/core/server/data-access-db/migrations-rollback/*`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/upgrades.md` if anything is deliberately deferred

- [ ] **Step 1: Write a rollback script for each existing migration** — generate the skeleton with `prisma migrate diff` in the reverse direction, then adjust by hand for data.

- [ ] **Step 2: CI job on Testcontainers** — apply all migrations from zero; run `prisma migrate diff` between `schema.prisma` and the migrated database and fail on drift; then apply rollback → re-apply forward and assert the schema is identical.

- [ ] **Step 3: Document the workflow** in `docs/contracts/` (custom SQL via `--create-only`, expand→backfill→contract, `CREATE INDEX CONCURRENTLY` in its own migration).

- [ ] **Step 4: Commit**

---

### Task 13: API docs UI and test data factories

**Files:**
- Modify: `apps/core/api` (Scalar route)
- Create: `libs/core/server/testing/**` (generator) — factories and the Testcontainers harness

- [ ] **Step 1: Serve Scalar from `openapi.json`** at `/docs`, enabled by env (`DOCS_ENABLED`), off by default in production per spec §6.18.

- [ ] **Step 2: Testing library** — `@faker-js/faker` + `fishery` factories for the demo model, plus one shared helper that boots Postgres/Redis containers so every integration suite uses the same harness instead of re-implementing it.

- [ ] **Step 3: Move the existing integration tests onto the shared harness** so there is exactly one way to get a database in a test.

- [ ] **Step 4: Commit**

---

### Task 14: Transaction ownership — `withTenantTransaction` / `withSystemTransaction`

**Files:**
- Create: `libs/core/server/data-access-db/src/lib/transaction/*` + specs

**Interfaces:**
- Produces: the only sanctioned way to open a transaction. Phase 3 layers RLS GUCs on top of exactly this seam, so it must exist before tenancy work starts.

- [ ] **Step 1: Failing tests** — work inside the callback runs on the transaction client (a rollback inside the callback leaves nothing behind); nesting a call reuses the active transaction instead of opening a second one; calling the raw client while a transaction is active is detected and throws (the runtime invariant the spec demands, not a convention).

- [ ] **Step 2: Implement with AsyncLocalStorage**, exposing `db.tenant()` / `db.system()` accessors and keeping the root client private to the library.

- [ ] **Step 3: ESLint rule** preventing imports of the raw client outside `data-access-db`.

- [ ] **Step 4: Commit**

---

### Task 15: Phase 2 gate

- [ ] **Step 1:** `pnpm nx reset && pnpm verify && pnpm knip`
- [ ] **Step 2:** `docker compose up -d && pnpm dev` — API answers, web renders data fetched through the generated client.
- [ ] **Step 3:** Contract chain proof: change a DTO field → `nx affected -t build` fails in `core-web`; restore → green.
- [ ] **Step 4:** Security proof: 429 with `Retry-After`, idempotent replay, CSRF origin rejection — all covered by e2e, not by hand.
- [ ] **Step 5:** Self-review the full diff, fix what it turns up, re-verify, then commit `chore: phase 2 backend contract complete`.
