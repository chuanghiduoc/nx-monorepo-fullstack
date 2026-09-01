# ADR-0001: Architecture baseline

- **Status:** Accepted
- **Date:** 2026-09-02
- **Context:** Phase 1 of `docs/superpowers/specs/2026-09-01-nx-fullstack-boilerplate-design.md`

The full reasoning, alternatives and trade-offs live in the spec. This record
captures the decisions that are now real in the repository, so a reader does not
have to reverse-engineer them from configuration files.

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | **Nx 23 monorepo, TS preset, pnpm** | Project references cut typecheck cost; `affected` keeps CI proportional to the change; generators encode conventions. |
| 2 | **Fastify adapter for NestJS** | ~2x Express throughput and pino is Fastify's native logger. Cost: Express-only middleware does not apply; `@fastify/*` plugins are used instead. |
| 3 | **Scope-based project names** (`core-api`, not `api`) | A second product or frontend must never force a rename. Framework identity lives in tags, not in names. |
| 4 | **Boundaries enforced by ESLint on three axes** (`scope`, `platform`, `type`) | Conventions that are not machine-checked decay. Notably `type:feature` may not import another feature. |
| 5 | **Vitest over Jest** | Nx ships `@nx/vitest` as the supported path from v23; the backend suite runs in the `node` environment (jsdom cost ~30s per run for no benefit). |
| 6 | **Tailwind v4 + shadcn/ui in `libs/shared/ui`** | The design system is shared by every future frontend. shadcn writes imports against the package's own name; that self-reference is allowed only inside that library. |
| 7 | **pnpm catalog for shared runtime versions** | One place to change a version, no drift between projects, no hand-written version ranges. |
| 8 | **Nest optional integrations excluded from the bundle** | Nest lazily `require()`s class-validator, microservices, websockets and `@fastify/static`. Webpack fails on each one that is absent even though the runtime never loads them. Validation is Zod-based (spec §3), so they are ignored deliberately — install and un-ignore when a phase needs one. |
| 9 | **`shared-ui` consumed as TypeScript source** | Vite library mode bundles JS into a single entry, so subpath exports would not resolve. Next compiles the package via `transpilePackages`, the standard internal-package pattern. |
| 10 | **Two Redis roles, not one instance** | BullMQ requires `noeviction`; a cache wants `allkeys-lru`. One instance cannot satisfy both, and eviction on the queue silently drops jobs. |
| 11 | **TypeScript 7 via the Nx dual-install** | `tsc` is the native TypeScript 7.0.2 compiler while `typescript` resolves to 6.0.2, so tools that need the compiler API (the Nx plugin, typescript-eslint) keep working. Measured on this workspace: `nx run-many -t typecheck --skip-nx-cache` took **8.15s before and 7.96s after** — at six projects the gain is inside the noise. It is kept because the whole gate stays green, the cost is two dependency lines, and the benefit grows with the graph. Reverting is those same two lines. |

## Verified during review

- **The `IgnorePlugin` entry is required, not belt-and-braces.** Removing it
  while keeping `externalDependencies: 'all'` fails the build with 9 unresolved
  modules — `'all'` externalises declared dependencies, and these optional
  integrations are not declared anywhere. Re-check with a build before deleting it.
- **`test-ci` / `e2e-ci` cannot run without Nx Cloud.** Nx refuses the atomized
  targets outright, so CI runs `test` and `e2e`; the switch belongs in the commit
  that enables `nx connect`.
- **knip ignore list.** Entries fall into two groups: packages consumed through
  configuration rather than imports (ESLint plugins, `@nx/*` generators,
  `prettier`), and packages providing a binary or compiler behaviour
  (`tslib`, `@typescript/native`). No application dependency is ignored, and the
  `unresolved` issue class stays enabled — only the `"types": ["*"]` entry that
  `create-nx-workspace` writes into `tsconfig.base.json` is silenced.
- **Five webpack warnings remain by choice.** They report dynamic `require()`
  inside NestJS and Express. They are real information about lazy loading, so
  they stay visible; only the unactionable source-map warnings from prebuilt
  dependencies are filtered.

## Deliberately deferred

Nothing from Phase 1 is deferred; simplifications made in later phases must be
recorded in `docs/upgrades.md` before they are allowed — that file is a hard
requirement of the spec, not documentation courtesy.
