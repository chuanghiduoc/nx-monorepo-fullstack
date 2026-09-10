# Contract: stored files

Bytes never pass through the API. A caller asks for a ticket, uploads to the
store with a signed URL, and says it finished; a worker then reads the object
and decides what it is. Everything below follows from that one decision.

## The state machine

```
                       (request)                    (worker)
  ─────► PENDING ──────────────► UPLOADED ─────────► SCANNING
            │                                            │
            │ sweep, past the abandon window              ├──► READY
            ▼                                            ├──► REJECTED
         (deleted)                                       └──► QUARANTINED
```

- `PENDING` — the record exists, the store has nothing. The only state a
  request creates.
- `UPLOADED` — the caller said the upload finished **and the store confirmed an
  object is there**. The one transition a request may make.
- `SCANNING` — a worker has claimed the record with `FOR UPDATE SKIP LOCKED`.
- `READY` — the bytes were read and are what they claimed to be. The only state
  a download is signed for.
- `REJECTED` — the bytes are not what was declared, or are of a kind that is
  refused outright.
- `QUARANTINED` — the scan could not reach a verdict at the attempt ceiling.
  Terminal, and deliberately not the same as `REJECTED`: "we looked and it is
  wrong" and "we could not look" are different facts.

`REJECTED` and `QUARANTINED` carry a `reason`, enforced by a `CHECK` rather
than by the code that writes them.

## The grant is the enforcement

The API's role can write two columns and no others:

```sql
GRANT INSERT, SELECT ON "stored_files" TO app_user;
GRANT UPDATE ("status", "uploaded_at", "updated_at") ON "stored_files" TO app_user;
GRANT DELETE ON "stored_files" TO app_user;
GRANT SELECT, UPDATE, DELETE ON "stored_files" TO worker_user;
```

So no route, and no injection through one, can mark a file `READY` or set the
type the scanner detected. The repository's `markUploaded` additionally names
`AND status = 'PENDING'` in its `WHERE`, which makes the transition idempotent
and makes a replayed completion a no-op rather than a step backwards.

Row-level security scopes every read to the organization in the transaction's
context; the worker's policy is a second one, `FOR ALL TO worker_user`, because
a scan has no organization to be in.

## What a caller never sees

The object key. It is `<orgId>/<uuid>`, derived from neither the file name nor
anything a caller sent, and it is not in any response. A caller that knew it
would be one signed URL away from a file it was never granted, which is the
whole reason a download goes through a route that checks `status` first.

## The three upload shapes

The caller chooses, because getting it wrong is expensive and the size is a
number the caller also chose:

| Shape | For | Bounded by |
| --- | --- | --- |
| `put` | a server, one request | `STORAGE_MAX_UPLOAD_BYTES` |
| `post` | a browser form | the policy signed into the ticket |
| `multipart` | anything that must survive a dropped connection | the store |

`post` is the default. `multipart` requires `partCount` on the ticket and both
`uploadId` and `parts` on the completion — the upload id travels back with the
caller rather than living in a column, because it belongs to an upload in
progress and a column holding it would outlive the upload.

## Two drivers, one suite

`STORAGE_DRIVER` is `s3` or `local`, and `libs/core/server/platform/storage`'s
suite runs the same assertions against both — against a real MinIO for `s3` and
a temporary directory for `local`. "Works with either" is a fact rather than a
hope only because the two are never tested apart.

The local driver's URLs are signed for real: an HMAC over the **method**, the
key, the expiry and, for a part, the part's identity. `PUT /api/v1/files/local/:key`
and its `POST` and `GET` siblings verify it. That the method is in the signed
material is what stops a download link being replayed as an upload — and the
e2e suite asserts exactly that, by sending `GET` to a URL signed for `PUT` and
requiring a 403.

Those routes are excluded from the OpenAPI document: they are where a signed
URL happens to point, not part of the API's contract. They are marked
`@SignedRequest()`, which exempts them from the CSRF origin check — a route
whose whole authorization is a signature it verifies itself holds no ambient
authority for a cross-site page to borrow, and requiring an allowed `Origin`
there would refuse a server upload while stopping nothing.

## What the scanner actually checks

It reads the first `SNIFF_BYTES` (4100 — the largest prefix any detector in
`file-type` needs) and compares what the bytes are with what the caller
declared. Some types have no signature at all (`text/plain`, `application/json`,
`text/csv`); those are accepted on the declaration, because a sniffer that
guesses at them guesses wrong. A handful of prefixes are refused whatever was
declared: `MZ`, ELF, `#!` and the Java class magic number.

The size recorded is the one the **store** reports from a `HEAD`, never the one
the caller claimed.

## Cleanup

A `PENDING` record older than `STORAGE_ABANDONED_UPLOAD_MINUTES` is swept:
record first, object second. The order is what makes a failure recoverable — an
object with no record is rubbish the next sweep removes, while a record with no
object is a row a caller can still see and nothing can satisfy. Deleting a file
through the API follows the same order for the same reason.

## Configuration

| Variable | Meaning |
| --- | --- |
| `STORAGE_DRIVER` | `s3` or `local` |
| `STORAGE_MAX_UPLOAD_BYTES` | the ceiling every shape is bounded by |
| `STORAGE_SIGNED_URL_TTL_SECONDS` | how long a signed URL lives |
| `STORAGE_ABANDONED_UPLOAD_MINUTES` | when a `PENDING` record is swept |
| `STORAGE_LOCAL_ROOT` | `local` only: where objects go |
| `STORAGE_PUBLIC_ORIGIN` | `local` only: where its signed URLs point |
| `STORAGE_SIGNING_SECRET` | `local` only, and required — refused at boot without it |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | `s3` only |

A `local` deployment with no signing secret fails at boot with the variable's
name. Handing out URLs anybody could forge would otherwise look exactly like
the feature working.
