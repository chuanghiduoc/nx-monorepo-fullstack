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

### Sliding quota windows

- **Signal:** an entitlement genuinely needs "N per rolling 30 days" rather
  than "N per calendar month". Today `QuotaWindow` offers `daily`, `monthly`
  and `lifetime`, and deliberately does not offer `sliding` — a counter row
  keyed by a window start cannot express one, and a name that silently
  delivered a fixed window instead would be worse than not having it.
- **Steps:** a sliding limit needs the individual consumption events inside the
  trailing period, so it is a second table and a second mechanism, not a new
  member of the enum. Keep the counter for the fixed windows; do not try to
  make one table serve both.

### Per-tenant quota window boundaries

- **Signal:** a customer says their month ends at the wrong time. Windows are
  computed in UTC, so a tenant in UTC+7 rolls over at 07:00 local.
- **Steps:** the boundary would come from the tenant's IANA zone, which makes
  `window_start` depend on a column in another table and on a DST rule — and a
  zone changed mid-month moves a boundary underneath counters that already
  exist. Decide what happens to those counters *before* writing the code; that
  decision is the whole of the work.

### FAST quota in Redis

- **Signal:** a measured p99 on the quota check above budget, or quota checks
  taking a visible share of transaction time. Not before — the STRICT path is
  one statement inside a transaction the request was opening anyway.
- **Steps:** Redis becomes the enforcement authority for the soft classes only
  (rate limiting, spam), with the database as durable accounting to reconcile
  against. Say plainly which class a given entitlement is: the two cannot share
  a transaction, so "fast and strict" is not on offer.

### Reading and ageing the audit trail

- **Signal:** somebody needs to *read* `audit_records`, or the table has grown
  past what one relation serves comfortably. Neither is true yet: nothing holds
  `SELECT` on it but the worker that writes it, and there is no retention at
  all.
- **Steps, in the order they become necessary:**
  - a read route, which decides which tenants a support role may see and grants
    `cross_tenant_admin_role` accordingly — today it is revoked precisely so
    that decision cannot happen by default privilege;
  - `PARTITION BY RANGE (occurred_at)`, because that is the column every query
    would filter on and the one a drop-a-partition policy would use;
  - an erasure path that clears `actor_id` and redacts `detail` while keeping
    the row. A delete is not the answer — a trail with holes in it is not a
    trail — and `erasure_role` holds no privilege here, so it grants itself
    exactly the columns it touches when it arrives.

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
  `platform-express`, the Fastify static/view plugins, `pg-native`,
  `@valkey/valkey-glide` and `ws`'s two native accelerators out of the bundle.
  `@nestjs/websockets` **left this list** when realtime arrived, which is the
  move described below actually happening.
- **Signal:** a phase starts using one of them.
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
  on it. `build` also lists `schema.prisma` among its own inputs: the generated
  client is gitignored, so Nx never hashes it, and without that line a schema
  change was a cache hit that restored a stale `dist`.
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

### `db.tenant()` stays synchronous; `withRequestTransaction` is the explicit form

- **Today:** the accessor returns the transaction in flight and throws outside
  one. A request that wants a transaction for its own tenant calls
  `withRequestTransaction`. The design does sanction an accessor that opens a
  short transaction itself, and that was read and traded away: an accessor
  that sometimes opens one makes two consecutive calls two transactions with
  nothing atomic between them, and the call site does not say so.
- **Signal:** a read path where the explicit call is pure ceremony — many
  single-statement reads, each already inside a request, none of them
  composing with a neighbour.
- **Steps:** resolve the stored context inside `tenant()`, return a promise,
  and migrate callers. The synchronous signature is what makes that a breaking
  change, so it happens once, deliberately.

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

### Paging backwards

- **Today:** the cursor payload carries `direction`, `encodeCursor` accepts
  `backward`, and `decodeCursor` rejects it with 400. No endpoint implements
  reverse keyset paging; returning the forward page instead would be a wrong
  answer with a 200.
- **Signal:** a screen needs a "previous page" that is not simply the browser's
  history — infinite scroll upwards, or a jump into the middle of a list.
- **Steps:** flip the comparison (`>` instead of `<`) and the `orderBy`, then
  reverse the rows before returning them; drop the guard in `decodeCursor` and
  the row in `docs/contracts/pagination.md`.

### The e2e suite clears rate-limit state before it runs

- **Today:** `apps/core/api-e2e/src/global-setup.ts` deletes the throttler's
  `:hits` and `:blocked` keys from redis-critical before starting the server.
  Counters outlive the process under test, so a second run inside the same
  window began already blocked — and the readiness probe reported the server
  as never having started.
- **Signal:** the suite gets its own Redis (Testcontainers, as PostgreSQL
  already does) or the throttler gets a per-run key prefix.
- **Steps:** start a Redis container in the harness and point
  `REDIS_CRITICAL_URL` at it; delete the clearing step.

### Database role passwords are granted outside the migration

- **Today:** the roles migration creates `app_user` and the rest as `NOLOGIN`
  with no password — a credential in git is a credential leaked.
  `tools/postgres/10-dev-logins.sh` grants the development login when the
  container initialises; the test harness grants its own; production does it
  out of band.
- **Signal:** a secret manager exists in the deployment.
- **Steps:** read the password from it in the entrypoint, drop the compose
  init script, and record the rotation procedure in `docs/ops/`.

### The better-auth schema generator lags the library

- **Today:** `@better-auth/cli` is 1.4 while `better-auth` is 1.7, so the
  generated Prisma schema is missing anything added in between. It cost a 500
  on every sign-up: 1.7 added `account.issuer`, the generator did not emit it,
  and Prisma rejected the insert. `auth-schema.spec.ts` now compares the schema
  against the installed library's own `getAuthTables`, so the next gap is a
  failing test rather than a broken sign-up.
- **Signal:** the CLI catches up with the library, or better-auth ships a
  first-party Prisma generator.
- **Steps:** regenerate, run the drift spec, and delete whatever hand-written
  columns it stops flagging.

### API keys are verified server-side only

- **Today:** the plugin's HTTP surface is create/get/list/update/delete. There
  is no verify endpoint, by design — one would be an oracle for guessing keys.
  Verification is `auth.api.verifyApiKey`, called by the request hook.
- **Signal:** none expected.

### Roles are defined once, from the action registry

- **Today:** `access-control.ts` builds the permission statements from
  `permissionStatements()` in the authz library, so what the auth library
  enforces and what the facade knows about come from one list. The role
  *assignments* — which verbs an owner, an admin or a member gets — are still
  written there by hand, because they are a product decision rather than a
  vocabulary.
- **Signal:** an organization wants roles it defines itself beyond the dynamic
  roles the plugin already supports.
- **Steps:** the assignments move into data, and the registry stays the
  vocabulary they are validated against.

### The tenant-scoped reference feature is `notes`, not `users`

- **Today:** membership lives in the auth library's own `member` table, which
  its organization plugin owns together with the hooks and access control that
  guard it. A second write path around the plugin would bypass those, and an
  optimistic-concurrency column there would be ignored by every plugin write.
  The reference feature therefore CRUDs a tenant-owned table of its own.
- **Signal:** a product needs a member list, or a field on membership that the
  plugin does not expose.
- **Steps:** extend through the plugin's hooks and `additionalFields`, never a
  second table. If that proves insufficient, a `feature/users` library owns the
  extra data keyed by member id, and membership itself still changes only
  through the plugin.

### The tenant guard is an accessor, not a Prisma extension

- **Today:** `db.system()` returns a client that refuses tenant-scoped tables
  by name. The design called for a client extension checking the async context
  on every operation; that does not work, because Prisma runs the extension
  outside the context the transaction was opened in, so the store is always
  empty and every query looks unscoped — measured, with correct reads being
  rejected inside valid tenant transactions.
- **Signal:** Prisma propagates async context into extensions, or exposes the
  active interactive transaction to them.
- **Steps:** move the check into `$extends`, which would then also cover a
  client obtained some other way. The accessor covers every path that exists
  today, because a client is only ever obtained from one.

### The tenant-scoped model list is generated, not read at runtime

- **Today:** `tenant-scoped-models.ts` is written by a generator from the
  schema's class comments and committed; a test fails when the two disagree.
  Reading the schema on module load worked in tests and made the built service
  fail to boot — the schema is not in the bundle, and the file that read it
  used `import.meta`, which webpack cannot express in CommonJS.
- **Signal:** the schema ships alongside the bundle for another reason.
- **Steps:** read it at startup and delete the generator, keeping the drift
  test as a boot check.

---

## Phase 5 simplifications — storage, realtime, the assistant

### The production compose stores files on the API's own disk

- **Today:** `docker-compose.prod.yml` ships `STORAGE_DRIVER=local` with a named
  volume shared by the API and the worker. A presigned S3 URL is signed for a
  *hostname*, and on one host the API and a browser cannot agree on one — a URL
  signed for `minio:9000` is refused when used from `localhost:9000`, and the
  reverse. Publishing the port does not fix it and routing through the edge does
  not either, because SigV4 signs the `Host` header.
- **Cost, stated:** **one API replica.** The objects live on its disk.
- **Signal:** a second API replica, or a host that can lose its disk.
- **Steps:** set `STORAGE_DRIVER=s3` and point `S3_*` at a managed store whose
  hostname is the same from both sides. The driver is the same either way —
  that is what the storage suite proves by running one set of assertions against
  both.

### Realtime is best effort and stores nothing

- **Today:** Redis Pub/Sub. A message published while a browser is between
  reconnects is gone, and nothing tells it so. The outbox stays the durable path.
- **Signal:** a notification that has to survive a reconnect — an unread badge,
  an approval waiting for somebody.
- **Steps:** a `notifications` table and a fetch on connect. **Not** a durable
  queue in front of the bus: the delivery guarantee a browser can honour is
  "ask again when you come back", and anything else is machinery pretending.

### The Socket.IO Redis adapter is installed but is not what fans out

- **Today:** the bus delivers locally (`server.local.to(room)`), so the adapter
  is not doing that job. It is there because the next thing anybody writes is
  `server.to(room).emit(...)` in their own code, which without it quietly
  reaches one replica's sockets.
- **Signal:** nothing. This is the safe arrangement.
- **Steps:** if the adapter is ever removed, `RealtimeBus.publish` becomes the
  only legal way to emit, and that has to be enforced by review — there is no
  lint rule for it.

### The RAG demo is a demo

- **Today:** fixed 1,200-character chunks with a 150-character overlap,
  characters rather than tokens, no respect for headings or sentences; a plain
  similarity search with no reranking, no query rewriting, and no evaluation of
  whether any of it helps.
- **Signal:** somebody asks whether the answers are any good, and nothing can
  answer that.
- **Steps:** in this order — an evaluation set first, because every change below
  it is unmeasurable without one; then structural chunking, then a reranker,
  then query rewriting. Adding them in the other order is how a retrieval stack
  gets slower and nobody can say whether it got better.

### The embedding dimension is fixed at 1536 by a migration

- **Today:** `vector(1536)`, which is what `text-embedding-3-small` produces.
  The number is in the migration, in `EMBEDDING_DIMENSIONS`, and in the
  contract.
- **Signal:** a better or cheaper embedding model with a different dimension.
- **Steps:** a migration for the column **and** a re-embed of everything already
  stored. There is no way to do one without the other, which is why the number
  is not a setting.

### The AI token ceiling is soft

- **Today:** the ceiling is read before the call and the tokens are recorded
  after it, so work already in flight can carry an organization past its limit.
- **Signal:** a tenant whose overshoot costs real money.
- **Steps:** a reservation of an *estimate* before the call and a reconciliation
  after — which trades "can overshoot" for "can refuse work that would have
  fit", and needs a per-purpose estimate to be worth having.

### Vector search has no per-tenant partitioning

- **Today:** one HNSW index over every organization's passages, with row-level
  security filtering afterwards.
- **Signal:** enough passages that a search reads far more of the index than it
  returns.
- **Steps:** pgvector's iterative index scans first, because it is a setting;
  partitioning by organization only if that is not enough.

---

## Phase 6 simplifications — observability and operations

### Tracing is instrumented by hand

- **Today:** spans at four boundaries — an HTTP request, an enqueue, a consume,
  and whatever a feature adds explicitly. There is no span for an outbound HTTP
  call, a Redis round trip, or an individual SQL statement.
- **Why:** `@opentelemetry/auto-instrumentations-node` patches `Module._load`,
  and both applications are bundled into one file with
  `externalDependencies: 'none'` — there are no module boundaries left to patch.
- **Signal:** following a real problem needs a boundary that is not covered.
- **Steps:** another explicit span at that boundary. **Not** a return to
  auto-instrumentation, which would mean giving up the single-file image; and
  not adding the package "just in case", because it produces a working SDK and
  no spans, which is worse than none.

### The worker serves no metrics

- **Today:** everything scrapable is read from the database or from Redis by the
  API. The worker traces but publishes no Prometheus text, because giving it an
  HTTP surface would undo the reason it has none.
- **Signal:** a number only the worker knows that cannot be derived from
  storage — a per-job timing histogram, say.
- **Steps:** OTLP metrics pushed from the worker to the same collector that
  takes its traces. Prometheus text stays the API's.

### `backup_age_seconds` trusts whoever writes the key

- **Today:** `backup.sh` writes `app:backup:last-completed` to the queue's Redis
  on its way out, and the collector reads it on every scrape. That instance is
  the one checked at boot for `noeviction`, so a cache cannot throw the key away
  — a backup age that vanished would read as "no backup has ever run", which is
  the alarm the metric exists to raise, raised for the wrong reason.
  With no key the series is **absent rather than zero**: a gauge at zero reads
  as "a backup finished just now", the one direction this must never be wrong
  in. Alert on `absent(backup_age_seconds)`.
- **Signal:** backups start being taken by something other than this script — a
  managed snapshot, a sidecar — and nothing writes the key.
- **Steps:** whatever takes the backup writes the key, or the metric reports on
  a backup nobody is taking. There is no way to detect that from inside the
  API, which is why it is written down here rather than guarded in code.

### `@nx/docker` builds the images; it does not publish them

- **Today:** the plugin is installed and `nx docker:build core-api` works from
  anywhere in the workspace, for all three images. Its inferred target is
  **overridden** in each project: `@nx/docker` infers `docker build .` with the
  project directory as the context, and these Dockerfiles need the workspace
  root — measured, the inferred options were
  `{"cwd": "apps/core/api", "command": "docker build ."}`, which cannot see the
  lockfile, the catalog or any library.
- **Not used:** its `nx-release-publish` target. Publishing here is not a
  publish step — it is build, scan the *same bytes*, fail on a fixable HIGH,
  produce an SBOM, push, attest provenance, sign, and verify the signature the
  pipeline just made. That sequence lives in `.github/workflows/release.yml`
  because most of it has no meaning outside a CI run with an OIDC identity.
- **Signal:** `nx release` grows the ability to run those steps between version
  and publish, or the pipeline stops needing to scan before pushing.
- **Steps:** move the publish to `nx release publish`, keep the scan gate ahead
  of it, and delete the duplicated tagging from the workflow.

### The release workflow's identity is GitHub's

- **Today:** build, Trivy scan, SBOM, provenance and a keyless Cosign signature
  on a `v*` tag. Every step was exercised by hand against a real registry — a
  push, `cosign sign`, `cosign verify`, `cosign attest`,
  `cosign verify-attestation` — using a generated key pair.
- **Not exercised:** keyless signing and SLSA provenance, both of which need the
  runner's OIDC token. Only GitHub can issue it.
- **Signal:** the first tag.
- **Steps:** push it, then run the three verification commands in
  `docs/ops/production.md` against what came out. If they fail, the pipeline
  produced files rather than guarantees.

### Base images are pinned by digest, and then patched

- **Today:** `FROM node:24.19.0-alpine@sha256:…`, and the runtime stages then
  `apk upgrade libcrypto3 libssl3`, because the Node image ships an OpenSSL with
  a fixable HIGH that Alpine has already patched and the image has not been
  rebuilt with.
- **Cost, stated:** the image is no longer purely a function of its digest — two
  builds a week apart can carry different OpenSSL builds.
- **Signal:** the Node image is rebuilt with the fix.
- **Steps:** move the digest and drop the `apk upgrade`. Renovate moves the
  digest; the scan is what says whether the upgrade line is still needed.

### npm is deleted from the runtime images

- **Today:** `rm -rf /usr/local/lib/node_modules/npm` in every runtime stage.
  Nothing there runs a package manager, and npm's vendored tree was eight of the
  ten findings in the first Trivy run.
- **Signal:** something in an image genuinely needs to install a package at
  runtime — which would be worth arguing about before it is worth allowing.
- **Steps:** put it back and pin the findings instead, knowing that is a
  standing exception rather than a fix.

### Recovery has no point-in-time restore

- **Today:** `pg_dump` on a schedule. The RPO is the backup interval, measured
  by a drill rather than asserted.
- **Signal:** an RPO measured in minutes rather than hours.
- **Steps:** WAL archiving with WAL-G or pgBackRest, and a different restore
  procedure — the one in `tools/scripts/restore.sh` restores a dump and knows
  nothing about a WAL timeline. Listed under **Operations** above as well; this
  entry exists so the drill's numbers point at it.
