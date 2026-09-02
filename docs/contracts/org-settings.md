# Contract: organization settings

Each organization holds its own configuration, stored as key and value and
validated against a schema registered for that key.

## Adding a setting

Register a schema. That is the whole change — no migration, no column:

```ts
export const SETTING_SCHEMAS = {
  'security.ipAllowlist': z.array(z.string().min(1)).max(200).default([]),
  'notifications.replyTo': z.email().optional(),
};
```

Key-value storage without a registry means anything goes; the registry is what
stops that. A key nobody registered is refused on read and on write, because a
typo would otherwise be stored happily and read back as "not set" — which
looks exactly like a setting nobody has configured.

Values are parsed on the way out as well as in. A row written before a schema
changed would otherwise reach the application as a shape nothing expects, and
fail wherever it happened to be used rather than at the boundary.

## Concurrent edits

A write may quote the version it read. If the stored version has moved on, the
write is refused with 409 and the caller re-reads. Two administrators editing
the same setting from the same starting point would otherwise both succeed,
and the second would erase the first without either noticing.

The version is part of the update's condition, not only of its payload:
between reading and writing, another transaction may commit, and an update by
id alone would overwrite it.

## Isolation

`org_settings` is a tenant-owned table with the standard policy. A read asks
for a key, never for an organization — the database supplies that. One
organization reading another's settings gets nothing, and that is enforced
below the repository rather than by a `where` clause somebody remembered.

## The IP allowlist

`security.ipAllowlist` is enforced by a global guard for any request acting
inside an organization:

| Situation | Result |
|---|---|
| No allowlist configured | Allowed — the absence of a rule, not a rule admitting nobody |
| Address in the list or a listed range | Allowed |
| Address outside | 403, with the address in the log and not in the response |
| Request with no organization | Not checked — there is no list to check against |

Matching uses `node:net`'s `BlockList`, which understands both address
families and CIDR. String comparison is where an allowlist grows the bug that
lets `10.0.0.10` through a rule written for `10.0.0.1`.

An unparseable address is refused. One malformed rule among good ones is
ignored, so a typo cannot lock an organization out of its own data — but a
list whose every rule is unusable refuses everyone, because the alternative is
a misconfigured allowlist silently becoming no allowlist at all.

## Which address

`request.ip`, resolved by Fastify from `X-Forwarded-For` **only** for the hops
named in `TRUSTED_PROXIES`. Trusting every hop would let any caller name its
own address, and this guard would then admit everyone while appearing to work.

Verified in both directions: with loopback trusted, a forwarded address is
taken; with the edge configured elsewhere, the same header is ignored and the
socket address stands.

## Covered by

- `libs/core/server/platform/core/src/lib/security/ip-allowlist.spec.ts` —
  ranges, boundaries, IPv6, IPv4-mapped addresses, malformed input.
- `libs/core/server/platform/data-access-db/src/lib/org-settings/org-settings.repository.spec.ts`
  — validation, unknown keys, version conflicts, cross-organization isolation.
- `apps/core/api-e2e/src/auth.e2e-spec.ts` — the guard on real requests, and
  the forwarding rules.
