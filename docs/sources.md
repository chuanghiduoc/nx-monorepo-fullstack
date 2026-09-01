# Sources

Evidence behind the version-sensitive decisions, so they can be audited instead
of trusted. Rows are added as each phase makes a decision that depends on
external behaviour.

| Claim | Source | Accessed | Version in use | Decision |
|---|---|---|---|---|
| Nx 23 is the current major line; the `ts` preset uses TypeScript project references | https://nx.dev/changelog | 2026-09-02 | `nx` 23.1.1, `create-nx-workspace` 23.1.3 | ADR-0001 §1 |
| `create-nx-workspace` fails under pnpm 11 because the generated `pnpm-workspace.yaml` has no `allowBuilds` | https://github.com/nrwl/nx/issues/35563 | 2026-09-02 | pnpm 11.23.0 | Approvals recorded via `pnpm approve-builds` |
| pnpm 11 replaced `onlyBuiltDependencies` with `allowBuilds` and defaults `strictDepBuilds` to true | https://pnpm.io/cli/approve-builds | 2026-09-02 | pnpm 11.23.0 | `pnpm-workspace.yaml` `allowBuilds` |
| NestJS Fastify bootstrap API and the need to bind `0.0.0.0` in containers | https://docs.nestjs.com/techniques/performance | 2026-09-02 | `@nestjs/platform-fastify` 11.2.3 | ADR-0001 §2, `apps/core/api/src/main.ts` |
| `@nestjs/platform-fastify` 12.x requires `@nestjs/common` 12 (`/internal` subpath) | Observed: `Cannot find module '@nestjs/common/internal'` with core 11.2.3 | 2026-09-02 | Nest 11.2.3 across the app | Pinned the adapter to the 11 line |
| `NxAppWebpackPlugin` accepts `externalDependencies: 'all' \| 'none' \| string[]` | https://nx.dev/docs/technologies/build-tools/webpack/guides/webpack-plugins | 2026-09-02 | `@nx/webpack` 23.1.1 | `apps/core/api/webpack.config.js` |
| Tailwind CSS v4 installs via `@tailwindcss/postcss` and `@import "tailwindcss"` | https://tailwindcss.com/docs/installation/framework-guides/nextjs | 2026-09-02 | tailwindcss 4.3.3 | `apps/core/web/postcss.config.mjs` |
| Turbopack options (`resolveAlias`, `rules`) live under the top-level `turbopack` key in Next 16 | https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack | 2026-09-02 | next 16.1.6 | `apps/core/web/next.config.js` (settled on `transpilePackages`) |
| PostgreSQL 18 images expect a single mount at `/var/lib/postgresql`, not `/var/lib/postgresql/data` | Container startup error from `postgres:18-alpine`; https://github.com/docker-library/postgres/issues/37 | 2026-09-02 | postgres 18.6 | `docker-compose.yml` |
| PostgreSQL 18 ships a built-in `uuidv7()` | Verified in the running container: `SELECT uuidv7()` → `01a05e45-face-7843-…` | 2026-09-02 | postgres 18.6 | Spec §3 ID standard |
| BullMQ requires `maxmemory-policy=noeviction` for correct queue behaviour | https://docs.bullmq.io/guide/going-to-production | 2026-09-02 | redis 8-alpine | `docker-compose.yml` `redis-critical` |
| Lefthook 2.x configures hooks under `jobs:`, not the 1.x `commands:` | https://lefthook.dev/configuration/ | 2026-09-02 | lefthook 2.1.12 | `lefthook.yml` |
| TypeScript 7.0.2 and `@typescript/typescript6` 6.0.2 both publish; Nx documents running them side by side | https://nx.dev/docs/kb/typescript-7 ; `npm view typescript@7 version` | 2026-09-02 | tsc 7.0.2 / API 6.0.2 | ADR-0001 §11 |
