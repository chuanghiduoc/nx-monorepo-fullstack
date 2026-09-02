# Contract: the typed API client

A frontend never hand-writes a `fetch` against our own API. It calls a client
generated from the API's OpenAPI document, so a contract change that the
frontend has not caught up with is a compile error, not a runtime surprise.

## The chain

```
Zod schema (apps/core/api/src/**/**.dto.ts)
  -> nestjs-zod + @nestjs/swagger        core-api:openapi
  -> apps/core/api/openapi.json          (committed)
  -> @hey-api/openapi-ts                 shared-api-client-core:generate
  -> libs/shared/api-client-core/src/generated  (committed)
  -> apps/core/web                       imports @workspace/shared-api-client-core
```

Both artifacts are committed on purpose: a contract change should be visible in
the diff a human reviews, not hidden inside a build step.

`shared-api-client-core:generate` declares `core-api:openapi` as a dependency, so
`pnpm nx run shared-api-client-core:generate` regenerates the document first —
there is no ordering to remember.

## Proven, not assumed

Renaming `title` to `label` in `demoItemSchema` and regenerating makes
`core-web` fail to typecheck:

```
src/app/demo-items/page.tsx:33:19 - error TS2339: Property 'title' does not
exist on type '{ id: string; label: string; createdAt: string; updatedAt: string; }'.
```

That is the whole point of the chain, and it is the reason at least one page
consumes the client for real.

## Drift

CI regenerates both artifacts and runs `git diff --exit-code` on them. A commit
that changes a DTO without regenerating fails there — otherwise the frontend
would keep typechecking against a contract the API no longer serves.

## Base URL

`libs/shared/api-client-core/src/client-config.ts` exports `createClientConfig`,
the generator's own initialisation hook (`runtimeConfigPath`). Every consumer
gets the base URL without having to call `setConfig`, because a caller who
forgot would silently issue a relative request against whatever host is serving
the page. It reads `API_URL` and falls back to `http://localhost:3000`.

The path is written as `./src/client-config.js`: the generator copies the string
into the emitted import verbatim, and a `.ts` extension there is a TS5097 error
under our module resolution.

## A pitfall the emitter now refuses

Zod 4 emits a *bare* nullable primitive (`z.string().nullable()`) as JSON
Schema `type: ["string", "null"]`. `@nestjs/swagger` reads that as its legacy
"array of types" form and rewrites it to `type: "array", items: { type:
"string" }` — silently, before `cleanupOpenApiDoc` runs. The generated client
believed `nextCursor` was a list of strings, and nothing failed: the runtime
never validates responses against the document.

Give the branch a constraint or description — `z.string().max(n).nullable()`
— and Zod emits `anyOf`, which every layer understands. The emitter
(`assert-no-collapsed-nullables.ts`) inspects the raw document for the marker
nestjs-zod leaves behind and fails the build naming the property, so the next
occurrence is a red build rather than a wrong contract. Found by reading the
generated types during the Phase 2 gate, not by a test — which is why there is
one now.

## Rules

- `src/generated` is never edited by hand, and never linted — it is typechecked,
  which is the property we depend on. `knip` treats it as an entry point so the
  dependencies it imports still count as used.
- `@hey-api/openapi-ts` is pinned to an exact version. Generated output changes
  between minor releases, and a floating range would turn an unrelated install
  into a drift-check failure.
- The fetch client is copied into `src/generated/client` by the generator, so
  no `@hey-api/client-fetch` package is imported at runtime — the plugin name
  in `openapi-ts.config.ts` is what selects it.
- The `@tanstack/react-query` plugin emits `queryOptions`, not hooks. The caller
  decides between `useQuery`, prefetching and server-side fetching — which
  matters because pages render on the server by default.

## Covered by

- `apps/core/web/src/app/demo-items/page.tsx` — the consuming page.
- `.github/workflows/ci.yml` — the drift check.
