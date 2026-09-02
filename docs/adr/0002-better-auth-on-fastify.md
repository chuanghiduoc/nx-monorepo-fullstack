# ADR-0002: Mounting better-auth on Fastify

- **Status:** Accepted
- **Date:** 2026-09-02
- **Context:** Phase 2, Task 1 — the spec required this spike before Phase 3 could
  depend on authentication (spec §7 Phase 2, risk table entry on Fastify).

## Decision

better-auth is mounted **directly on the Fastify instance that Nest owns**, not
through a third-party NestJS wrapper.

```ts
const fastify = app.getHttpAdapter().getInstance();
fastify.route({ method: ['GET', 'POST'], url: '/api/auth/*', handler });
```

The handler converts Fastify's Node request into a Web `Request`
(`fromNodeHeaders` from `better-auth/node`), calls `auth.handler(request)`, and
copies status, headers and body back onto the Fastify reply.

## Why not a wrapper package

The first review round listed community integrations (`nestjs-better-auth`,
`nestjs-better-auth-fastify`, `@cms-nestjs-libs/better-auth`). All of them exist
to do exactly the bridge above. Authentication is the one dependency every other
feature sits on, so it is worth owning ~40 lines rather than tracking a small
package's release cadence. If a wrapper later offers something the direct mount
lacks — guards, GraphQL context, decorators worth having — adopting it is a
contained change behind the same route.

## Verified in this spike

Run against the built production bundle (`node dist/main.js`), not a dev server:

| Check | Result |
|---|---|
| `POST /api/auth/sign-up/email` | `200`, user JSON returned |
| Session cookies | `better-auth.session_token` and `better-auth.session_data`, both `HttpOnly`, `SameSite=Lax`, `Max-Age=604800` |
| `GET /api/auth/get-session` with cookie | Session + user returned, `expiresAt` one week out |
| `GET /api/auth/get-session` without cookie | `200` with a JSON `null` — no session leak, and no error that would confirm a guess |
| Nest routes unaffected | `GET /api` still answers `{"message":"Hello API"}` |

Versions at the time of the spike: `better-auth` 1.7.2, `@nestjs/platform-fastify`
11.2.3, Fastify 5.

## Consequences and follow-ups

- **`trustProxy: true`** is set on the Fastify adapter. Behind Caddy (spec §6.18)
  the client address and protocol arrive in `X-Forwarded-*`; without it, secure
  cookies and per-IP rate limiting would see the proxy instead of the caller.
- **`@opentelemetry/api` is now a real dependency.** better-auth's core imports
  it for instrumentation; the build fails without it. Phase 6 needs it anyway.
- **CSRF:** better-auth protects its own routes with `SameSite=Lax` cookies and a
  `trustedOrigins` allow-list. The rest of the API gets the origin-check guard
  planned in Phase 2, Task 6 — the two mechanisms are separate on purpose.
- **The spike configuration had no database.** That has since been replaced by
  the Prisma adapter with the organization, admin, two-factor, multi-session
  and api-key plugins, all covered end to end. Two things the spike could not
  have predicted turned up there: the schema generator lags the library, so
  `account.issuer` was missing and every sign-up returned 500; and the api-key
  plugin is a separate package, not an export of the library.
- **The mount now takes the instance as an argument** rather than importing a
  module-level singleton. The adapter needs the client attached to the
  connection pool the framework opens and closes, which makes the instance a
  provider, and a provider cannot be imported at module scope.
- **Where it lives:** the whole capability is a library
  (`libs/core/server/feature/auth`), not application code. The application
  imports it and mounts it. That is also what lets the request hook — which
  must call the auth API — live beside it instead of in the application.
- **Still not verified:** behaviour behind a real reverse proxy. The forwarded
  client address is asserted, but cookie attributes under a production build
  behind TLS are not.
