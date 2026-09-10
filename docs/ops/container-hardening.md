# Container hardening

What `docker-compose.prod.yml` does beyond running the images, and why each
line is there. Every one of these was applied and then verified by running the
stack, because hardening that has not been run is a guess about what an image
needs.

## The Node services — api, worker, web

```yaml
cap_drop: ['ALL']
security_opt: ['no-new-privileges:true']
read_only: true
tmpfs: ['/tmp']
```

- **No capabilities.** Node binds a port above 1024 and the process already
  runs as `node` (the images set `USER node`), so nothing in the runtime path
  asks the kernel for a privilege.
- **`no-new-privileges`** is what stops a setuid binary inside the image
  undoing the line above. Without it, dropping capabilities is advice.
- **Read-only root filesystem.** Verified: `touch /app/anything` fails with
  `Read-only file system`. A compromised process cannot rewrite the code it is
  running.
- **`/tmp` on a tmpfs**, because the worker's liveness file lives there
  (`WORKER_HEARTBEAT_FILE=/tmp/core-worker-heartbeat`) and a read-only root
  would otherwise make the container unhealthy within a minute. Verified: the
  file exists and is written after the change. It is also the right place for
  it — liveness must not survive a restart.

## The edge — Caddy

```yaml
cap_drop: ['ALL']
cap_add: ['NET_BIND_SERVICE']
security_opt: ['no-new-privileges:true']
```

Caddy keeps exactly one capability, and finding out which took a container that
would not start. The official image runs `setcap cap_net_bind_service=+ep` on
the binary; with an empty bounding set the kernel refuses the exec outright:

```
edge-1  | exec /usr/bin/caddy: operation not permitted
```

— on a restart loop, with nothing in the message naming capabilities. The
capability is granted because the **image asks for it**, not because port 8080
needs it.

It is deliberately not `read_only`: Caddy writes certificates and its own state
to the `caddydata` volume, which is the one thing here that must survive a
restart.

## PostgreSQL and Redis

```yaml
security_opt: ['no-new-privileges:true']
```

Capabilities are **kept**. The official entrypoints chown the data directory
and drop privileges before starting the server, which needs `CHOWN`, `SETUID`
and `SETGID`. Dropping them makes the container fail to initialise, and a
database that will not start is a worse trade than the capability.

## What is deliberately not here

- **Resource limits** (`deploy.resources`, `mem_limit`). There is no
  measurement to set them from, and a limit guessed too low is an out-of-memory
  kill under exactly the load it was meant to survive. They belong in the
  deployment that has a machine and a workload, not in the file that describes
  the shape.
- **A user namespace remap.** It is a daemon-level setting, not a compose one,
  and it interacts with every bind mount. It is the next thing to reach for and
  it is not something this file can do on its own.
- **Seccomp beyond the default.** Docker's default profile already blocks the
  syscalls worth blocking here. A custom profile is a maintenance burden that
  pays off only when there is a threat model naming it.

## Checking it after a change

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod --profile web up --build -d
docker compose -f docker-compose.prod.yml --env-file .env.prod --profile web ps -a
```

Every service must reach `healthy`, and `edge` must not be `Restarting`. A
container that starts and then loops is the shape a capability problem takes,
and its log says `operation not permitted` without saying about what.
