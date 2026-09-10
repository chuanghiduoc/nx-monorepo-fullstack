# nx-monorepo-fullstack

Full-stack platform monorepo: **NestJS (Fastify)** + **Next.js (App Router)** on **Nx**,
built to be reused across products (CRM, ERP, HRM, CMS, AI, e-commerce admin…).

**Start here**

| Document | Answers |
|---|---|
| [`docs/conventions.md`](docs/conventions.md) | where new code goes, why library imports end in `.js`, how to create and move a library |
| [`docs/contracts/`](docs/contracts) | the promises the code keeps: errors, pagination, idempotency, transactions, tenancy, authorization, migrations, testing, the API client, the web surface, storage, realtime, the assistant and observability |
| [`docs/adr/`](docs/adr) | decisions taken, with the evidence that settled them |
| [`docs/upgrades.md`](docs/upgrades.md) | everything deliberately kept light, with the signal that says it is time |
| [`docs/ops/`](docs/ops) | running it: production checklist, database roles, container hardening, dashboards, capacity, service objectives and the restore drill |
| [`docs/superpowers/specs/`](docs/superpowers/specs) | the full architecture design |
| [`docs/adding-a-service-in-another-language.md`](docs/adding-a-service-in-another-language.md) | adding a service written in Go, Python or anything else |
| [`docs/sources.md`](docs/sources.md) | where the version and behaviour claims came from |

## Getting started

```bash
pnpm install
pnpm dev
```

On the first run it copies `.env.example` to `.env`, whose defaults match
`docker-compose.yml`. An existing `.env` is never touched, and `.env` is not
tracked — it is where this machine's real credentials go.

`pnpm dev` starts the dev infrastructure in Docker and both apps:

| Service        | URL                            |
| -------------- | ------------------------------ |
| API (Fastify)  | http://localhost:3000/api      |
| Web (Next.js)  | http://localhost:4200          |
| Mailpit UI     | http://localhost:8025          |
| MinIO console  | http://localhost:9001          |
| Postgres 18    | `localhost:5432`               |
| Redis critical | `localhost:6379` (noeviction)  |
| Redis cache    | `localhost:6380` (allkeys-lru) |

Observability (Grafana + Loki + Tempo + Prometheus) is opt-in to keep the default
footprint small:

```bash
pnpm dev:obs   # Grafana on http://localhost:3001, OTLP on :4317/:4318
```

## Everyday commands

| Command                      | What it does                                     |
| ---------------------------- | ------------------------------------------------ |
| `pnpm verify`                | lint + typecheck + test + build + e2e across the graph |
| `pnpm nx affected -t test`   | only what the current change touches              |
| `pnpm knip`                  | report unused files, dependencies and exports     |
| `pnpm nx release --dry-run`  | preview the next version and changelog            |
| `pnpm dev:down`              | stop the dev infrastructure                       |
| `pnpm prod:up`               | build the images and run the stack the way it ships |
| `pnpm prod:down`             | stop it and remove its volumes                    |

## Running it the way it ships

```bash
cp .env.prod.example .env.prod   # then edit it
pnpm prod:up
```

Two images — the API bundled to a single file, the web application as a
standalone server — behind one Caddy edge on http://localhost:8080. Migrations
run as a one-shot job before anything serves traffic, connecting as the owner;
the services themselves connect as `app_user`, which has no DDL.

Everything is served from **one origin** on purpose. The browser's session
cookie is set for whatever origin the API answered on, and the web application
reads that cookie to decide whether somebody is signed in — put them on
different sites and a signed-in person is redirected back to sign in forever,
with nothing in any log to explain it. Locally the two differ only by port,
which cookies ignore, so the mistake would first appear in a real deployment.

It is not a deployment: no TLS, secrets in a file, the database in a container.
It exists so the artifacts can be run and tested as they will run.

## Using only the backend

The browser half is optional, and that is tested rather than claimed. Delete
`apps/core/web`, `apps/core/web-e2e`, `libs/shared/ui` and
`libs/shared/api-client-core`, run `pnpm install && pnpm nx sync`, and the rest
still passes `pnpm verify` on its own — the API's dependency graph reaches
nothing under those four projects.

Nothing else needs editing: `pnpm dev` names no project, so it runs whatever
has a `serve` or `dev` target; the images copy workspace manifests by pattern
rather than by name; and the browser application and its edge sit behind a
Compose profile.

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
#   the API on its own, published on 3000

docker compose -f docker-compose.prod.yml --env-file .env.prod --profile web up -d
#   the application and the API behind one edge on 8080
```

## Workspace layout

Projects are named after their **scope**, never after a role or a framework, so a
second product or a second frontend never forces a rename.

```
apps/core/api                          core-api        NestJS + Fastify
apps/core/web                          core-web        Next.js App Router + Tailwind
apps/core/api-e2e                      core-api-e2e    API tests against the built bundle
apps/core/web-e2e                      core-web-e2e    Playwright

libs/core/server/platform/core         config, logging, errors, rate limiting,
                                       idempotency, pagination, request context
libs/core/server/platform/data-access-db   Prisma, the transaction seam, RLS helpers
libs/core/server/platform/authz        the permission facade
libs/core/server/platform/testing      Testcontainers harness and factories
libs/core/server/feature/auth          sessions, organizations, 2FA, API keys
libs/core/server/feature/notes         the reference feature, end to end

libs/shared/contracts                  Zod schemas the API and the forms share
libs/shared/ui                         design system, published as source
libs/shared/i18n                       the languages the platform offers
libs/shared/api-client-core            generated from openapi.json (do not edit)
```

A rule stated in two places disagrees the first time one of them moves, so
request shapes live in `libs/shared/contracts` and both sides read them: the
API wraps each schema in `createZodDto`, the browser hands the same schema to
its form resolver. A field that gets a new limit gets it in both at once.

Server libraries sit in two layers. `platform/` is infrastructure any feature
may depend on; `feature/` holds business capabilities, which may not import
each other. The folders make the dependency rule visible; ESLint is what
enforces it.

## Adding a UI component

The design system lives in one place, so shadcn components are always added from
that library — never from an app:

```bash
cd libs/shared/ui
pnpm dlx shadcn@latest add <component>
```

Export it from `src/index.ts` and consume it as `@workspace/shared-ui`.

Dependency rules are enforced by ESLint (`@nx/enforce-module-boundaries`) on three
axes — `scope:*`, `platform:*`, `type:*`. Notably a `type:feature` library may not
import another `type:feature`: cross-feature communication goes through domain
events or shared contracts. [`docs/conventions.md`](docs/conventions.md) has the
rest, including where a new capability goes and why library imports carry a
`.js` extension.
