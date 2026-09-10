# Contract: webhooks

An organization registers an endpoint; a domain event reaches it, signed. The
whole feature is a consumer of the outbox, and everything below follows from
that plus one fact: the receiver is somebody else's server.

## At-least-once, and it cannot be otherwise

`processed_events` is the exactly-once guarantee for a consumer whose whole
effect is a write to this database. A webhook's effect is an HTTP request, and
no transaction spans this database and a stranger's.

So the contract with the receiver is explicit, and it is half of the design:

**Every delivery carries `X-Webhook-Event-Id`. The receiver is responsible for
ignoring one it has already seen.**

A delivery that times out is retried whether or not it arrived. There is no
arrangement of code on this side that changes that.

## The two queues

```
outbox relay ──> webhook-dispatch ──> webhook-deliveries ──> the receiver
                 (one job per event)   (one job per endpoint)
```

Separate on purpose. Fanning out is a read and some enqueues, and it always
succeeds; delivering is slow and often does not. One queue for both would let
a receiver that times out for an hour block the fan-out of every other event.

The dispatcher **does not claim the event in `processed_events`**. That table's
guarantee needs the effect and the claim in one transaction, and this
consumer's effect is jobs on a queue — a claim would commit while the enqueues
did not, so a crash between them would leave an event marked handled and never
dispatched. A repeat fans out again, absorbed by the delivery queue's `jobId`
and, past that window, by the receiver.

## The signature

```
X-Webhook-Signature: t=1788000000,v1=<64 hex characters>
```

HMAC-SHA256 over `${t}.${body}`, where `t` is unix seconds.

**The timestamp is inside the signed material**, which is what makes it replay
protection rather than decoration: a captured request cannot have its timestamp
moved forward without invalidating the digest. A receiver rejects one further
than its tolerance from now — **in both directions**, because only checking the
past lets a captured request be held until the receiver's own clock catches up.

The default tolerance is 300 seconds and is published as
`DEFAULT_TOLERANCE_SECONDS`.

**Versioned** (`v1=`) because the day the scheme changes, both have to be sent
for a while and a receiver reading `v1=` has to keep working throughout.

`verify()` is exported so a receiver in this workspace never reimplements it.
The half people skip is the timestamp, and a verification written twice is
verified once.

## The secret is written once and never read back

`app_user` holds a **column-level `SELECT` that excludes `secret`**. Creating
an endpoint returns it in that one response; no route can ever produce it
again. That is the shape an API key has, for the same reason: a secret a
request can read is a secret an injection can read.

`worker_user` reads it, because signing needs the value. Hashing is not
available — a signature is computed, not compared. Encrypting it at rest is a
real answer that needs a key-management decision this phase does not have;
`docs/upgrades.md` records the signal.

**The consequence is that the repository names its columns.** Prisma's
`findMany` emits `SELECT` for every column of the model, so it fails with
`permission denied for column secret` — in production, and never in a test that
runs as the owner. It is the same trap `RETURNING` set for the outbox.

Rotating a secret is a create-and-delete, not an update: `app_user` has no
grant on that column at all, and leaving the old endpoint's deliveries
attributable to the key that signed them is the more useful history.

## Where a webhook may go

The string check is the least of it. Four steps, in this order, on **every
attempt** — not once when the endpoint was created, because the address a name
resolves to is not a property of the string:

1. **Parse.** `https:` only when `NODE_ENV=production`; `http:` elsewhere so a
   developer can point one at their own machine. No credentials in the URL —
   they smuggle a different host past a careless parser and they end up in
   logs.
2. **Resolve once**, `family: 0`, keeping the address.
3. **Validate the address**, not the name, against every private, loopback,
   link-local, carrier-grade-NAT and reserved range in both families.
4. **Connect to the address that was validated**, through
   `https.request({ lookup })`.

Step 4 is what closes DNS rebinding. A name that resolved to a public address
during validation and a private one a millisecond later never gets connected
to. `fetch` cannot express it — there is no way to say "connect to this
address" — which is why this uses `node:https`.

**TLS still verifies the certificate against the hostname.** The hostname stays
in the request options; only the socket's destination is pinned. Measured
against a real endpoint: `authorized: true`.

**Redirects are not followed.** A `302` to `http://169.254.169.254/` is the
whole attack, and re-validating every hop is more code than telling receivers
not to redirect. A redirect is reported as the status it is.

### Two things the blocklist got wrong first

- **`::ffff:0:0/96` cannot go in the blocklist.** It is the IPv4-mapped IPv6
  range, and adding it looks like the obvious way to stop
  `::ffff:169.254.169.254`. Measured: Node's `BlockList` then treats the entire
  IPv4 space as blocked — `check('8.8.8.8', 'ipv4')` answers `true` — so every
  webhook is refused with a message claiming a public address is private. The
  mapped form is **unwrapped** to its v4 spelling and checked against the v4
  ranges instead.
- **`172.16.0.0/12` ends at 172.31.** Writing it as `/8` blocks a large part of
  the public internet, and a test pins both edges.

A refused address is **fatal**, not retryable: it will be just as private in
thirty seconds, and eight identical refusals only delay the dead letter
somebody has to read. The message names the **address**, because
"webhook.acme.test is not allowed" tells a tenant nothing they can act on.

## Retries

| What came back | What happens |
| --- | --- |
| 2xx | delivered |
| 5xx, timeout, refused connection | retried |
| 408, 425, 429 | retried — the receiver is asking for the backoff |
| any other 4xx | fatal; the receiver says the request is wrong and will say so again |
| an address that fails validation | fatal |

Eight attempts with exponential backoff, then the dead letter the queue keeps
for a fortnight.

**The endpoint is re-read on every attempt**, never taken from the job. A
delivery sits on the queue for as long as its retries take, and an endpoint
deleted, disabled or repointed in the meantime must not be delivered to from a
copy the queue kept — the secret above all, which would otherwise keep signing
with a rotated key for two weeks. An endpoint that no longer wants the event is
dropped rather than retried: its owner changed their mind, which is allowed.

## The delivery log

`webhook_deliveries` holds **one row per attempt**, not per delivery. The
question somebody asks is "why did this not arrive", and the answer is the
sequence — `503`, `503`, `timeout` — which a row per delivery overwrites with
its own last line.

`status` is null when nothing answered, and `error` says which. A receiver's
response body is kept only up to 200 characters: one that answers a webhook
with a megabyte of HTML must not be able to fill this process's memory or the
column.

Swept by the **hourly retention job** rather than the relay: its volume is
endpoints times events, not the outbox's delivery rate, so an hourly job keeps
up. It therefore needs no `FOR UPDATE SKIP LOCKED` — a scheduled job is one
replica per tick — which is why `worker_user` has no `UPDATE` here at all.

## Who may touch what

```
app_user                 webhook_endpoints   INSERT, DELETE,
                                             SELECT (every column but secret),
                                             UPDATE (url, event_types, enabled)
app_user                 webhook_deliveries  SELECT
worker_user              webhook_endpoints   SELECT
worker_user              webhook_deliveries  INSERT, SELECT, DELETE
cross_tenant_admin_role  both                —
```

Both tables are TENANT_OWNED with the single-branch policy, plus the
`worker_user` policy that lets the dispatcher read across tenants — the same
arrangement the quota and flag tables use, and for the same reason: a SYSTEM
table carries no policy at all, and `app_user` needs real rights here.

`cross_tenant_admin_role` gets nothing. An endpoint's URL and a tenant's
delivery history are that tenant's data.

## What is not here

- **An endpoint management API.** The repository and the grants are; the routes
  that call them are a feature, and the secret's one-time response is the part
  that needs designing with them.
- **A replay button.** The queue keeps a failed job for a fortnight and the
  outbox can replay an event for a week, so the mechanisms exist; the operator
  path on top of them does not.
- **Per-endpoint rate limiting.** A receiver that cannot keep up answers 429 and
  the backoff does the rest. Something cleverer needs a measurement nobody has.

## Covered by

- `libs/core/server/platform/webhooks/src/lib/safe-address.spec.ts`
- `libs/core/server/platform/webhooks/src/lib/signature.spec.ts`
- `libs/core/server/platform/webhooks/src/lib/deliver.spec.ts`
