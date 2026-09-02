# Contract: routing

One table decides which path reaches which process. There is no second place
where a route is rewritten, and no path is served by two things.

## Today (development)

| Path | Served by | Notes |
|---|---|---|
| `/api/auth/*` | the auth library, mounted on the Fastify instance | registered before Nest's router; Nest never sees these |
| `/api/*` | Nest controllers under the global `api` prefix | everything else the API exposes |
| `/docs`, `/docs/*` | the API reference UI | off in production unless `DOCS_ENABLED` says otherwise |
| everything else on `:4200` | Next.js | pages, static assets, its own route handlers |

The browser reaches the API at `http://localhost:3000`; server components use
`API_URL`. Nothing in the browser learns the backend address from the page.

## Why authentication is mounted, not routed

The auth library speaks the Fetch API (`Request`/`Response`); Nest speaks
Fastify. Mounting its handler directly on the Fastify instance is one adapter
of about forty lines, against a dependency that everything else authenticates
through. A Nest controller wrapping it would add a second router in front of a
library that already has one.

The route is registered with an explicit method list and a wildcard path, so a
request that is not `/api/auth/*` cannot reach it by accident.

## Ordering, and why it matters

Fastify runs hooks before any route handler, in registration order:

1. security headers (helmet), so every response carries them — errors included;
2. CORS;
3. the tenant-context hook, which resolves identity before any handler and so
   before any transaction;
4. the route.

The docs UI registers its own per-route header policy inside that chain: the
API's own policy is `default-src 'none'`, which a page that loads a script
cannot live with, and relaxing it globally would relax it for every JSON
response too.

## Production (Phase 6)

A single edge (Caddy) terminates TLS and routes by the same table: `/api/*`
and `/api/auth/*` straight to the API, `/realtime/*` to the API with buffering
off, everything else to Next. `/metrics` is not reachable from outside.

That is a topology and exposure decision, **not** a security boundary. The API
treats every request as untrusted regardless of which hop it arrived through,
and authenticates and authorises it itself.

## Covered by

`apps/core/api-e2e/src/api.e2e-spec.ts` — the prefix is enforced, an unknown
route answers with a problem document, the docs UI answers on its own path and
its relaxed header policy does not leak onto `/api`.
