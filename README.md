# nx-monorepo-fullstack

Full-stack platform monorepo: **NestJS (Fastify)** + **Next.js (App Router)** on **Nx**,
built to be reused across products (CRM, ERP, HRM, CMS, AI, e-commerce admin…).

- Architecture spec: [`docs/superpowers/specs/`](docs/superpowers/specs)
- Upgrade paths for anything deliberately kept light: [`docs/upgrades.md`](docs/upgrades.md)
- Decision records: [`docs/adr/`](docs/adr)

## Getting started

```bash
pnpm install
pnpm dev
```

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

## Workspace layout

Projects are named after their **scope**, never after a role or a framework, so a
second product or a second frontend never forces a rename.

```
apps/core/api        core-api      NestJS + Fastify
apps/core/web        core-web      Next.js App Router + Tailwind
apps/core/api-e2e    core-api-e2e  API tests against the built bundle
apps/core/web-e2e    core-web-e2e  Playwright
libs/shared/ui       shared-ui     design system
libs/shared/i18n     shared-i18n   message catalogs
libs/shared/api-client-core        generated from openapi.json (do not edit)
```

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
events or shared contracts.
