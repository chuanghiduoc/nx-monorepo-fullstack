# Contract: realtime

Two transports, one bus, and a promise deliberately smaller than it looks.

## What it promises, and what it does not

**It promises**: an event published anywhere in the system reaches every browser
that is connected, in the right organization's stream, on whichever replica it
happens to be talking to.

**It does not promise delivery.** Redis Pub/Sub stores nothing. A message
published while a browser is between reconnects is gone, and nothing here will
tell it so. That is not a gap to be closed later — it is the shape of the
mechanism, and a notification centre built on top of a Pub/Sub channel would be
a feature that works in development and loses messages in production.

Anything that must survive a reconnect is a row in a table and a fetch when the
client comes back. The outbox remains the durable path and the source of truth;
this is a nudge that says "look again".

## The shape

```
  publisher (an API request after its commit, or the worker)
        │
        │ PUBLISH <REALTIME_CHANNEL>
        ▼
   Redis Pub/Sub  ──────────┬───────────────┐
                            ▼               ▼
                      API replica 1    API replica 2
                        │      │         │      │
                     SSE│      │Socket.IO│      │
                        ▼      ▼         ▼      ▼
                      only the clients that replica holds
```

`RealtimeBus.publish(audience, name, data)` is the only entry point. One
mechanism for both transports, so an event a Socket.IO client sees and one an
SSE client sees are the same event, published once.

**The publisher does not deliver to its own clients directly.** It publishes,
and its own subscriber connection receives the message like every other
replica's. Delivering locally *as well* would send one event twice to everybody
connected to the publishing replica — invisible until somebody runs two.

## Publish after the commit, never inside it

A message announcing a write that then rolls back is a lie the client cannot
detect, and there is no second message that takes it back. The opposite failure
— a committed write nobody was told about — the client recovers from by
re-reading, which is all this ever promises.

Every publisher therefore sits outside its transaction and swallows its own
failures. A Redis that is unreachable must not turn a successful write into a
500, or a successful scan into a retried one.

## The room is the tenant, and the client never names it

`org:<orgId>` when the principal has an active organization, `user:<userId>`
otherwise — the same split the database makes. It is derived from the resolved
principal on the server. A client that could name its room could name someone
else's, and no check afterwards recovers from that.

`?names=note.created,file.ready` filters *within* the room. It is a filter and
never a permission: it saves bytes on the wire and decides nothing about what
may be seen.

## SSE — for traffic that goes one way

`GET /api/v1/realtime/stream`, `text/event-stream`, and it stays open.

Identity comes from the ordinary request path: it is a `GET`, so the hook that
resolves a principal for every request has already run, and an anonymous caller
is refused with 403. There is nothing extra to remember, which is the reason to
prefer this shape wherever the traffic only goes one way — a progress bar, a
scan result, a notification.

Each frame carries the event name as its `event:` type and a JSON body:

```
event: note.created
data: {"name":"note.created","at":"2026-09-05T16:14:30.204Z","data":{"id":"…","title":"…"}}
```

A `ping` event arrives on an idle stream every `REALTIME_HEARTBEAT_SECONDS` and
means nothing but "still here". Without it something between the browser and the
service — a proxy, a load balancer, a phone's radio — eventually closes an idle
socket, and the feature works in a test and dies in a deployment.

## Socket.IO — for traffic that goes both ways

`/api/realtime/socket.io`, **websocket transport only**. Long-polling spreads
one logical connection over several HTTP requests, which needs sticky sessions
at the edge; the Redis adapter does not make that go away, it only makes the
*messages* cross instances.

**The handshake is verified once, at connect.** After it there is no request to
hang a guard on, so a socket that connected before its session was checked is a
socket that will be checked never. It uses the application's own principal
resolver, handed to the adapter rather than reimplemented — one definition of
"who is this". A connection that resolves to nobody is refused, not accepted and
ignored.

The room is joined by the server at the handshake, from that principal. The
client is never asked which room it wants; it could only answer with a string,
and one string is as good as another.

### Why the Redis adapter is installed even though the bus fans out

The bus delivers locally (`server.local.to(room)`), so cross-instance delivery
is already handled and the adapter is not doing that job. It is there because
the next thing anybody writes is `server.to(room).emit(...)` in their own code,
and without the adapter that quietly reaches one replica's sockets. A
boilerplate that is wrong when extended in the obvious way is worse than one
that is missing the feature.

## The edge

Both routes live under `/api`, like everything else the service answers — one
prefix rule is easier to keep true than two. The Caddyfile matches
`/api/realtime/*` **before** the general `/api` rule and proxies it with
`flush_interval -1`: without that the proxy buffers, and a stream that never
ends is handed over never. Compression is applied to everything else by an
explicit matcher, for the same reason.

Next.js cannot stand in for this. Its rewrites do not support WebSocket and
buffer SSE.

## Configuration

| Variable | Meaning |
| --- | --- |
| `REALTIME_REDIS_URL` | where the bus fans out; unset means `REDIS_CRITICAL_URL` |
| `REALTIME_CHANNEL` | the Pub/Sub channel, `realtime` by default |
| `REALTIME_HEARTBEAT_SECONDS` | how often an idle SSE stream is given something to carry |

`REALTIME_REDIS_URL` is a **base** variable, not an API one, because the worker
publishes too — a scan's verdict is the clearest thing a browser wants told. A
bus whose two ends read different variables is a bus that works until somebody
points them at different servers.

Falling back to the queue's instance does not violate its `noeviction`
requirement: Pub/Sub stores nothing to evict. The variable exists so a
deployment with real volume can move realtime off the instance carrying the
jobs, without a rebuild.

`REALTIME_CHANNEL` matters when two deployments share one Redis. Without
separate channels each reads the other's events, and the symptom — a stranger's
notification in your stream — is not one anybody guesses from.

## What publishes today

| Event | From | Audience |
| --- | --- | --- |
| `note.created` | the API, after the note commits | the note's organization |
| `file.ready`, `file.rejected`, `file.quarantined` | the worker, after the scan settles | the file's organization |

Both are examples rather than a catalogue: the bus takes any name, and a feature
that wants to announce something calls `publish` after its own commit.

## How it is proven

- **Cross-instance** — the bus's own suite builds *two* `RealtimeBus` objects
  with their own connections against one real Redis, publishes on one and
  receives on the other. One instance cannot observe the property that matters.
- **Exactly once on the publishing replica** — the same suite, with a negative
  control: delivering locally as well as publishing makes it fail with two.
- **End to end** — the API's e2e suite opens a real SSE stream and a real
  Socket.IO connection against the running service, writes through the ordinary
  request path, and reads the event out of both. Its negative controls: a
  constant room makes the isolation tests fail, and a filter that matches
  everything makes the filter test fail.
- **Refusal** — an anonymous `GET` is 403 and an anonymous socket is refused at
  the handshake, both asserted.
