# Contract: idempotency

A client that retries a mutation must not cause the work to happen twice. The
client opts in by sending `Idempotency-Key`; the server guarantees the rest.

Implemented by `IdempotencyStore` (`libs/core/server/platform/data-access-db`) and
`IdempotencyInterceptor` (`libs/core/server/platform/core`).

## Using it

```http
POST /api/v1/demo-items
Idempotency-Key: 6f1c...          ; any value the client can reproduce on retry
Content-Type: application/json

{"title":"…"}
```

| Situation | Response |
|---|---|
| First request with this key | The work runs; the response is stored |
| Retry, same key, same request | The stored response is replayed — the work does not run again |
| Retry while the first is still running | `409` with `Retry-After` |
| Retry after the first attempt failed | The work runs again — a failure releases the key immediately |
| Same key, different request body | `422` — the client made a mistake, and replaying would hide it |
| No key, or a safe method | Nothing changes |

## Identity

```
UNIQUE (scope_type, scope_id, route, idempotency_key)
```

Every column is `NOT NULL`. PostgreSQL treats `NULL`s as distinct, so a nullable
tenant column would silently let duplicates through — for exactly the callers
who are not in an organization.

- **scope** — `ORG`, `USER`, `API_KEY`, or `SYSTEM` plus the id. Two users
  sending the same key are two independent requests.
- **route** — method plus normalised path, without the query string. One key
  cannot mean two different operations.
- **request hash** — SHA-256 of the route and the canonicalised body. Key order
  in JSON carries no meaning and is normalised away, so a client that
  serialises differently on retry is not told its request changed.

## Lease and fence token

`lease_until` is a **lease, not a timeout**. When it expires, a later attempt is
*allowed to try* taking over — it does not prove the first attempt died.

The fence token is what makes that safe:

1. The first attempt claims the key and receives token *n*.
2. Its lease expires; a second attempt takes over and receives *n+1*.
3. The first attempt wakes up and tries to record its result with token *n* —
   the conditional update matches nothing, and the write is refused.

Without the token, a stale attempt would overwrite the result of the attempt
that legitimately owns the key.

## Completion and failure

The interceptor records the outcome **before** the response is sent, not
alongside it. Sending first and recording after looks harmless and is not: an
immediate retry then races the commit and is told the work is still in
progress, which is the one answer that is neither true nor useful.

A handler that throws releases the key. Without that, the record sits in
PROCESSING for the whole lease and every retry inside that window is refused
with a 409, even though nothing happened and the client is entitled to try
again.

Both `complete` and `fail` require the record to still be PROCESSING, so a
late failure cannot overwrite a stored response and a late completion cannot
resurrect a failed attempt. A stale fence token makes the update match
nothing; the interceptor logs that and still returns the response, because the
work did happen and the client is owed its answer — losing the stored copy is
the correct outcome when another attempt legitimately took the key over.

## Storage rules

- The database is the source of truth. Redis may cache lookups later, but a
  restart must never let a retried payment run twice.
- Response bodies above 64 KB are not stored: a replay returns the status
  without the body and the client re-reads the resource. Storing megabytes per
  key would turn the table into a cache nobody asked for.
- Streaming responses are out of scope — replaying one would mean buffering it,
  which defeats the reason it streams.
- Records carry `completed_at` and are indexed on it; Phase 4 adds the cleanup
  job (COMPLETED kept 24–72h, FAILED 12h) so the table does not grow forever.

## Covered by

- `libs/core/server/platform/data-access-db/src/lib/idempotency.store.spec.ts` — against
  a real PostgreSQL: claim, replay, mismatch, per-scope isolation, lease
  reclaim, fence-token rejection, and eight simultaneous claims where exactly
  one wins.
- `libs/core/server/platform/core/src/lib/idempotency/request-fingerprint.spec.ts` —
  route normalisation and body canonicalisation.
- `apps/core/api-e2e/src/api.e2e-spec.ts` — replay, the 422 on a changed
  request, and requests without the header. The 409 while in progress, the
  release after a failure and the state guards are covered by the store spec
  above; no end-to-end test races a retry against the first response yet.
