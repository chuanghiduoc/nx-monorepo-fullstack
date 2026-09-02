# Contract: authorization

One facade answers every permission question. Business code calls `require`;
nothing re-implements `if (!can) throw`, so every denial has the same status,
the same body and the same log record.

It is on the request path. `/api/v1/notes` calls `require` before every
operation, principals carry the roles of the membership in the active
organization, and the application provides the facade with the role
definitions the auth library administers — one list, so the two cannot
disagree about what a role grants.

```ts
authz.require(principal, 'note.update', { orgId, resourceOwnerId });
```

## The surface

| Call | Answer |
|---|---|
| `can(principal, action, ctx)` | boolean |
| `canAny` / `canAll` | boolean over a list |
| `require(principal, action, ctx)` | returns, or throws 403 |

The 403 body says only that the caller may not. The reason goes to the log,
where an operator can read it: telling the client which rule failed turns the
API into a map of the permission model.

## It performs no I/O

Everything a decision needs is on the principal, which the request resolved
before opening any transaction. This is not an optimisation — the database
read it would otherwise make goes through the root client, and the root client
refuses to be used while a transaction is open. A facade that queried would
throw on every check made inside a transaction, which is where checks belong.

## Default deny

An action is `<resource>.<verb>` and must be in the registry. An action nobody
declared is refused before any role is consulted, so a typo cannot become an
authorisation bypass. The registry also produces the permission statements the
auth library is configured with, so what a role grants and what the facade
knows about cannot drift apart.

## Principals

| Type | Decided from | Notes |
|---|---|---|
| `user` | the roles the organization grants | `actorId` names the administrator behind an impersonated session |
| `apiKey` | **only** the permissions written on the key | never the issuer's own rights |
| `system` | allowed | relays and schedulers; their limits are database grants, not this facade |

An API key that inherited its issuer's permissions would turn every leaked key
into an account takeover. Under impersonation the decision follows the user
being impersonated; the audit record carries both identities, because "who did
this" and "whose permissions allowed it" are different questions.

A permission granted in one organization means nothing in another: a context
naming a different organization is refused before the verb is even examined.

## What this layer is not

It is not the last line of defence. Row-level security is, and it holds when
application code is wrong. This layer turns a boundary violation into a 403
instead of an empty result, which is the difference between a caller that knows
it was refused and one that thinks the data does not exist.

## Covered by

`libs/core/server/platform/authz/src/lib/authz.service.spec.ts` — unknown
action, unknown resource, malformed action, role grants and combinations,
organization scope, api-key limits, impersonation, the 403 body, the log
record, and the registry's own guarantees.
