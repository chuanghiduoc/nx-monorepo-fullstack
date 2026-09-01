# Upgrade paths

Every deliberate simplification in this repository has an entry here: the signal
that says it is time, and the steps to take. A simplification without an entry is
not allowed (spec §2, constraint 7).

Entries are grouped by what triggers them, not by technology.

---

## Toolchain

### TypeScript 7 (native compiler)

- **Signal:** typecheck time becomes a felt cost in the local loop or CI.
- **Status:** not adopted; the workspace uses the TypeScript 6.0 that
  `create-nx-workspace` installs.
- **Steps:** follow Nx's side-by-side recipe (`nx.dev/docs/kb/typescript-7`):
  alias `@typescript/native` to TypeScript 7 and keep `typescript` pointing at
  the 6.x package so tools that need the compiler API keep working. Measure
  `nx run-many -t typecheck --skip-nx-cache` before and after, record both
  numbers in an ADR. Roll back by reverting the two devDependency lines.

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
- **Steps:** `nx connect`, then uncomment the distribution lines already present
  in `.github/workflows/ci.yml`.

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

---

## Frontend

### A global state manager

- **Signal:** local state genuinely outgrows React state and TanStack Query's
  server cache. Until then, adding one is cost without benefit.
