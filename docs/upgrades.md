# Upgrade paths

Every deliberate simplification in this repository has an entry here: the signal
that says it is time, and the steps to take. A simplification without an entry is
not allowed (spec §2, constraint 7).

Entries are grouped by what triggers them, not by technology.

---

## Toolchain

### TypeScript 7.1 — drop the dual install

- **Signal:** TypeScript 7 exposes a stable programmatic compiler API and the Nx
  plugin plus typescript-eslint consume it directly.
- **Today:** the workspace runs the Nx dual install — `tsc` is TypeScript 7.0.2
  (native) while the `typescript` specifier resolves to `@typescript/typescript6`
  so API consumers keep working (ADR-0001 §11).
- **Steps:** replace both aliases with a single `typescript` dependency on the 7.x
  line, run `pnpm nx run-many -t lint typecheck test build --skip-nx-cache`, and
  record the new typecheck timing in the ADR.

### Biome instead of ESLint + Prettier

- **Signal:** lint/format time blocks the local loop on a large graph.
- **Blocker:** Biome has no equivalent of `@nx/enforce-module-boundaries`, which
  is what keeps the architecture honest. Do not switch until it does.

### Rspack for the Nest build

- **Signal:** measured webpack watch/build time hurts, not a hunch.
- **Steps:** Rspack is close to a drop-in for webpack (Nest 12 itself moves that
  way). Swap the builder for `core-api`, keep the `IgnorePlugin` equivalent for
  the unused Nest optional integrations, and re-run the production bundle smoke
  test (`node dist/main.js` must answer on `/api`).

### NestJS 12

- **Signal:** `@nx/nest` generators ship support for it.
- **Steps:** `nx migrate latest`, then review: ESM output, Standard Schema
  validation (`@Body({ schema })`) which replaces the Zod pipe wiring, Vitest as
  the default runner, and Rspack as the default bundler.

### Nx Cloud

- **Signal:** CI wall-clock is dominated by tasks that other machines already ran.
- **Steps:** `nx connect`, uncomment the distribution lines already present in
  `.github/workflows/ci.yml`, and switch the affected command from
  `test`/`e2e` to `test-ci`/`e2e-ci`. Those atomized targets split suites per
  file but Nx refuses to run them without Nx Cloud, which is why CI uses the
  plain targets today.

---

## Data layer

### Prisma 8

- **Signal:** Prisma 8 has been the recommended production line for long enough
  to have a migration story others have walked.
- **Today:** Prisma 7 is the vendor-recommended production version.

### Search: Meilisearch/Typesense, then Elasticsearch

- **Signal (stage 2):** typo tolerance, facets, CJK tokenisation, or
  search-as-you-type below ~50ms.
- **Signal (stage 3):** log analytics, heavy aggregations, or billions of
  documents. Note Elasticsearch ships under ELv2; OpenSearch is the Apache-2.0
  fork.
- **Steps:** keep Postgres as the source of truth and drive the index from domain
  events, so the search engine can be rebuilt at any time.

---

## Messaging

### Kafka

- **Signal:** several independent services consume the same event stream, events
  must be replayable by new consumers, or throughput outgrows a Redis queue.
- **Steps:** the outbox already decouples producers from transport — point the
  relay at Kafka (or a CDC pipeline) and leave feature code untouched. BullMQ
  keeps the background-job role: Kafka's queue semantics (KIP-932) still lack a
  built-in DLQ and retry backoff.

### pg-boss or RabbitMQ instead of BullMQ

- **Signal:** dropping the Redis dependency (pg-boss) or needing broker-style
  routing across languages (RabbitMQ).
- **Steps:** rewrite the internals of the queue facade. Job-queue and
  message-broker semantics do not map 1:1 — the facade only promises the common
  denominator.

---

## Platform services

### SSO for enterprise customers (SAML 2.0 / OIDC)

- **Signal:** a customer requires their own identity provider.
- **Steps:** add the better-auth SSO plugin, configure per-organization
  providers, verify domains by TXT record. Test against a mock IdP — this is why
  it is not in the baseline: shipping auth code that cannot be exercised end to
  end is worse than not shipping it.

### ReBAC (OpenFGA / SpiceDB)

- **Signal:** permissions depend on relationships — deep hierarchies, delegation,
  sharing by association — not just roles and ownership.
- **Steps:** implement the authz facade against the new provider and sync tuples
  from domain events. Call sites do not change.

### Billing

- **Signal:** the product starts charging.
- **Steps:** entitlements and usage events already exist; attach a provider to
  the `onPlanChanged` hook. The boilerplate deliberately owns no payment code.

### Splitting `platform/auth` and adding `platform/gateway`

- **Signal:** a second product needs the same identity, or a second backend
  service needs one public entry point.
- **Steps:** better-auth runs standalone; other services verify the session.
  The gateway becomes the single edge once more than one backend exists.

### GraphQL

- **Signal:** clients need to shape aggregate responses themselves.
- **Steps:** `@nestjs/graphql` code-first *next to* REST, with its own generated
  client library. REST/OpenAPI remains the polyglot contract.

---

## Operations

### High availability beyond one VPS

- **Signal:** downtime of a single machine stops being acceptable.
- **Steps:** the compose stack is the reference topology; moving it to a managed
  Postgres, a Redis pair, and multiple app replicas behind the same edge is the
  first step, not a rewrite.

### Point-in-time recovery (WAL-G / pgBackRest)

- **Signal:** the recovery point objective drops below the daily dump baseline.

### Error tracking, load testing, antivirus scanning, preview environments

- **Signal:** each of these earns its place from a real incident or requirement,
  not from a checklist. Sentry for error grouping, k6 for load, a scanner behind
  the `StorageScanner` interface for uploads, ephemeral environments per PR.

### Feature-flag provider (Unleash, Flagsmith, GrowthBook)

- **Signal:** flags need targeting rules, gradual rollouts or an audit trail that
  a database table plus a cache no longer serves.
- **Steps:** the code talks to OpenFeature, so swap the provider registration.
  Call sites do not change.

### gRPC between internal services

- **Signal:** two internal services exchange enough traffic that HTTP/JSON
  overhead shows up in latency profiles, or they need streaming.
- **Steps:** keep REST/OpenAPI as the public contract; add gRPC only for
  service-to-service calls, with the protobuf definitions in a shared library.

### A separate scheduler entry point

- **Signal:** cron definitions must be deployed independently of worker code.
- **Steps:** BullMQ keeps schedules in Redis, so this is only a second entry
  point that calls `upsertJobScheduler` — split it out of the worker bootstrap
  without touching the handlers.

### Per-aggregate event ordering

- **Signal:** a consumer genuinely depends on the order of events for one
  aggregate. The outbox is at-least-once and unordered by design.
- **Steps:** partition delivery by `aggregate_id` and have consumers reject
  events whose `aggregate_version` is older than the one they last processed.

---

## Phase 1 simplifications

These are deliberate and small, but they are simplifications and so belong here.

### The API bundle is not minified

- **Today:** `optimization: false` in `apps/core/api/webpack.config.js`.
- **Signal:** image size or cold-start time matters (Phase 6 packaging).
- **Steps:** enable optimization for the production configuration only and
  re-run the bundle smoke test — decorator metadata is the thing to watch.

### Unused Nest optional integrations are ignored at build time

- **Today:** an `IgnorePlugin` entry keeps class-validator, microservices,
  websockets and the Fastify static/view plugins out of the bundle.
- **Signal:** a phase starts using one of them — realtime in Phase 5 needs
  `@nestjs/websockets`.
- **Steps:** install the package and remove it from the regex in the same
  commit, otherwise the runtime failure looks exactly like a missing install.

### Gitleaks is optional locally

- **Today:** the pre-push hook skips the scan when the binary is absent; CI
  always runs it.
- **Signal:** a secret reaches a branch before CI catches it.
- **Steps:** make the hook install-or-fail instead of skipping.

---

## Frontend

### A global state manager

- **Signal:** local state genuinely outgrows React state and TanStack Query's
  server cache. Until then, adding one is cost without benefit.

### The generated client is not linted

- **Today:** `libs/shared/api-client-core/src/generated` is excluded from ESLint.
  It is typechecked, and knip treats it as an entry point, so the properties we
  actually depend on are still enforced.
- **Signal:** never, unless we start hand-editing generated output — which would
  be the real problem.
- **Steps:** none. Linting it would mean carrying rule exceptions for a vendor's
  code style in review.

### `@hey-api/openapi-ts` is pinned to an exact version

- **Today:** `0.99.0`, no caret. Generated output changes between minor
  releases, and the CI drift check compares it byte for byte.
- **Signal:** an upgrade is wanted, or Renovate opens the PR.
- **Steps:** bump the pin, run `pnpm nx run shared-api-client-core:generate`, and
  commit the regenerated output in the same commit — the diff is the review.

### Cursors are opaque but not signed

- **Today:** base64url of canonical JSON with a filter hash. A forged cursor can
  only move a client's own reading position within data it may already read.
- **Signal:** a cursor starts carrying something the client must not choose —
  a tenant id, a visibility flag, a price band.
- **Steps:** append an HMAC (key from the environment schema) in `encodeCursor`
  and verify it in `decodeCursor` before parsing. The format is internal, so
  no client changes.

### `prisma-generate` is a plain Nx target

- **Today:** `core-server-data-access-db:prisma-generate` runs `prisma generate`
  with the schema as its input; `typecheck`, `build`, `test` and `lint` depend
  on it, so the client can never lag the schema.
- **Signal:** none expected. If Prisma ships an official Nx plugin, switch.

### `CREATE INDEX CONCURRENTLY` is not yet automated

- **Today:** no migration needs it; every index was created with its table.
- **Signal:** the first index added to a table with real volume.
- **Steps:** create the migration with `--create-only`, write
  `CREATE INDEX CONCURRENTLY`, and apply it outside Prisma's transaction:
  `prisma db execute --file` followed by `prisma migrate resolve --applied`.
  Add that sequence to `prisma-migrate-deploy` if it becomes routine.

### Rolling back a successful migration removes its history row by hand

- **Today:** `down.sql` plus `DELETE FROM "_prisma_migrations"`. Prisma's
  `migrate resolve --rolled-back` only accepts failed migrations.
- **Signal:** Prisma adds first-class down migrations.
- **Steps:** replace the two-step in `docs/contracts/migrations.md` and in
  `migrations.spec.ts` with the command.

### The docs page allows inline scripts

- **Today:** `/docs` (Scalar) gets its own CSP with `script-src 'self'
  'unsafe-inline'` because the page bootstraps with an inline `<script>`.
  Every other route keeps `default-src 'none'`; an e2e test checks both.
- **Signal:** Scalar's Fastify plugin exposes a nonce for the bootstrap
  script, or the page is served from a static host instead.
- **Steps:** switch the route CSP to `'nonce-…'` via `@fastify/helmet`'s
  `enableCSPNonces`, drop `'unsafe-inline'`, keep the e2e assertion.

### `db.tenant()` throws outside a transaction instead of opening one

- **Today:** the accessor only returns the transaction in flight. Repositories
  open a short transaction themselves when none is active, so callers never
  notice.
- **Signal:** Phase 3's request-scoped tenant context exists, and a read path
  wants `db.tenant()` to open a short transaction from it implicitly.
- **Steps:** resolve the context from the request store inside `tenant()` and
  call `withTenantTransaction` — one implementation, no extension magic.

### Nullable fields must carry a constraint or description

- **Today:** `z.string().nullable()` collapses to `type: ["string","null"]`,
  which `@nestjs/swagger` turns into an array. The emitter refuses such a
  document (`assert-no-collapsed-nullables.ts`); the fix is
  `z.string().max(n).nullable()` or a `.describe()`, which yields `anyOf`.
- **Signal:** nestjs-zod handles Zod 4.5's `type` arrays itself (watch its
  releases; the marker it uses is `x-nestjs_zod-empty-type`), or
  `@nestjs/swagger` stops reading JSON-Schema type arrays as `[Type]`.
- **Steps:** delete the guard and its spec; keep the constraints, they were
  correct anyway.
