# Contract: pagination

Lists return `{ items, nextCursor }`. `nextCursor` is `null` on the last page —
there is no separate `hasMore` flag to disagree with it.

Implemented by `libs/core/server/core/src/lib/pagination/cursor.ts`; the demo
list endpoint is the reference use.

## Using it

```http
GET /api/v1/demo-items?limit=20
GET /api/v1/demo-items?limit=20&cursor=eyJkaXJlY3Rpb24i...
```

| Situation | Response |
|---|---|
| No cursor | The first page |
| A cursor from the previous page | The next page, in the same order |
| `limit` outside 1–100, or not an integer | `400` — never silently clamped: a caller asking for 10 000 rows and receiving 100 believes it has the whole set |
| A cursor that was altered, truncated, or made up | `400 The cursor is not valid.` — deliberately without saying why |
| A cursor produced under different filters or sorting | `400` naming the cause: start again without a cursor |
| A cursor asking to page backwards | `400` — the payload carries `direction`, but no endpoint pages backwards yet, and returning the forward page would be a wrong answer with a 200 |

## Keyset, not offset

```sql
WHERE (created_at, id) < ($sort_key, $id)
ORDER BY created_at DESC, id DESC
LIMIT $limit + 1
```

`OFFSET` walks and discards every skipped row, and a row inserted between two
pages shifts everything after it, so page 3 repeats the last row of page 2.
Keyset reads from an index position, so both problems disappear.

The primary key is the tie-breaker because timestamps collide and UUIDv7s do
not; `(created_at, id)` is a total order, and the compound comparison is what
makes it one. The extra row (`limit + 1`) is how the endpoint knows another
page exists without a second `COUNT` query.

## The cursor is opaque

```
base64url( canonicalJson({ sortKey, id, filterHash, direction }) )
```

Clients hand it back unchanged. Encoding the keyset position as readable URL
parameters would make it part of the public contract, and the sort could never
change.

`filterHash` fingerprints the query (filters and sort) the cursor was produced
under. Keyset pagination is only correct while the query stays the same;
changing a filter between pages and keeping the cursor silently skips or repeats
rows — the kind of bug that surfaces weeks later as "the report is missing an
order". So the hash is checked on the way back in.

The cursor is opaque, **not signed**. A client that forges one can only move
its own reading position within data it is already allowed to read; tenancy
scoping in Phase 3 applies to the query regardless of the cursor. If a cursor
ever carries something a client must not choose, add an HMAC then (see
`docs/upgrades.md`).

## Timestamp precision

Columns used as sort keys are `TIMESTAMPTZ(3)`. PostgreSQL stores microseconds
and JavaScript `Date` carries milliseconds; a cursor built from a truncated
value never matches its own row again, and the equality branch of the keyset
comparison silently skips every row sharing that millisecond. This was
reproduced against a real database before the column type was changed.

## Covered by

- `libs/core/server/core/src/lib/pagination/cursor.spec.ts` — round trip,
  opacity, every malformed shape, filter mismatch, size cap, limit rejection.
- `apps/core/api/src/app/demo-items/demo-items.service.spec.ts` — against a real
  PostgreSQL 18: pages through more rows than one page holds without repeating
  or skipping, same order across boundaries, exact-fit last page, empty list,
  and a row inserted between pages.
