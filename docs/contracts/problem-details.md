# Contract: error responses (RFC 9457)

Every error this service returns is an `application/problem+json` document. One
shape means a client writes one error handler, and a log search finds every
failure the same way.

Implemented by `ProblemDetailsFilter` in `libs/core/server/core` — the only
place that formats an error response.

## Document shape

```jsonc
{
  "type": "https://errors.example.com/not-found", // stable, dereferenceable
  "title": "Not Found",                            // never changes for a type
  "status": 404,                                   // matches the HTTP status
  "detail": "Cannot GET /api/v1/items/42",         // safe to show a developer
  "instance": "/api/v1/items/42",                  // the request path
  "traceId": "b8731b8f-cb34-4ae1-af4b-a655cfe8dbf1"
}
```

Two extension members beyond the RFC:

| Member | When | Purpose |
|---|---|---|
| `traceId` | always | Matches `X-Request-Id` on the response and `req.id` in the logs. A user can quote it; support can find the request. |
| `errors[]` | validation failures | Field-level detail, so a form can highlight the field rather than showing one sentence. |

## Validation failures

A Zod failure becomes a `400` whose `errors` array names each field:

```jsonc
{
  "type": "https://errors.example.com/bad-request",
  "title": "Bad Request",
  "status": 400,
  "detail": "The request failed validation.",
  "instance": "/api/v1/items",
  "errors": [
    { "path": "email", "message": "Invalid email address" },
    { "path": "profile.age", "message": "Too small: expected number to be >=18" }
  ],
  "traceId": "..."
}
```

`path` is dotted, not an array, so a client can use it directly as a key.

## Type registry

`type` is derived from the status and published under `PROBLEM_TYPE_BASE_URL`.
The URL is an identifier first and documentation second — it must stay stable
even if the documentation moves.

| Status | `type` slug | Title |
|---|---|---|
| 400 | `bad-request` | Bad Request |
| 401 | `unauthorized` | Unauthorized |
| 403 | `forbidden` | Forbidden |
| 404 | `not-found` | Not Found |
| 409 | `conflict` | Conflict |
| 422 | `unprocessable-content` | Unprocessable Content |
| 429 | `too-many-requests` | Too Many Requests |
| 500 | `internal-server-error` | Internal Server Error |

Later phases add more specific types on top of these (`quota-exceeded`,
`idempotency-key-conflict`, `stale-write`); each one gets a row here when it
appears.

## Rules

1. **Deliberate client errors keep their message.** A caller needs it to fix the
   request.
2. **Unexpected errors never do.** `detail` becomes
   `"An unexpected error occurred."` — an exception message can carry a
   connection string, a file path or third-party internals, and the client can
   do nothing with any of it. The full error goes to the logs under the same
   `traceId`.
3. **`429` always carries `Retry-After`.** Otherwise a client can only guess,
   and guessing means hammering the endpoint that just asked it to stop.
4. **Nothing else formats errors.** No controller builds its own error body; if
   a new failure mode needs a shape, it gets a `type` here first.

## Covered by

- `libs/core/server/core/src/lib/errors/problem-details.spec.ts` — mapping,
  Zod issues, and the rule that internal messages never leak.
- `apps/core/api-e2e/src/api.e2e-spec.ts` — the real response: media type,
  members, and `traceId` matching the response header.
