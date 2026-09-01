# Adding a service in another language

The workspace is polyglot by contract, not by toolchain: a service written in Go,
Python or Rust joins by honouring the same HTTP contract, not by adopting the
TypeScript build.

## What a new service must provide

1. **An `openapi.json`**, committed to the repository like every other service's
   spec. It is the artifact the rest of the workspace consumes.
2. **RFC 9457 problem responses** (`application/problem+json`) with the same
   extension members: `errors[]` for field-level validation and `traceId` for
   correlation.
3. **URI versioning** — `/api/v1/...`. Additive changes do not bump; breaking
   changes ship as `v2` alongside `v1`.
4. **Cursor pagination** with an opaque cursor, matching the shape the
   TypeScript services return: `{ items, nextCursor }`.
5. **The declared security schemes** — session cookie, bearer, or API key — so
   generated clients know how to authenticate.
6. **W3C trace context propagation** (`traceparent`), so a request keeps one
   trace across service boundaries.

## Wiring it into the workspace

```bash
# 1. Prepare the scope (writes an ordered checklist)
pnpm nx g @org/workspace-plugin:product-scope --name=billing

# 2. Add the Nx plugin for the language, e.g.
pnpm nx add @nxlv/python      # Python
pnpm nx add @nx-go/nx-go      # Go
```

Then generate a client library for the service so frontends consume it the same
way they consume `core-api`:

```
libs/shared/api-client-billing   # generated from apps/billing/api/openapi.json
```

Tag it `scope:shared`, `platform:shared`, `type:data-access`, and never edit the
generated sources by hand.

## What stays out

A polyglot service does **not** import TypeScript libraries and is not imported
by them. The only coupling is the OpenAPI contract — that is what makes the
language choice reversible.
