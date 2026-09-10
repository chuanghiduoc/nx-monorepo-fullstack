# Running this in production

What has to be true, which half is the compose file's and which half is yours,
and how to check each one rather than assume it.

## What the compose file already does

`docker-compose.prod.yml` is not an example. It is the shape of a deployment,
and everything below is already in it:

- **Migrations run first.** The `migrate` service runs `prisma migrate deploy`
  to completion, and both applications wait on
  `service_completed_successfully`. An application that started against an older
  schema would fail on the first request that touched a new column, minutes
  after the deploy looked successful.
- **One edge.** Caddy is the only published port. Postgres, Redis and the
  applications are on an internal network with nothing exposed to the host.
- **No capabilities, no new privileges, read-only root.** See
  `docs/ops/container-hardening.md` for the line-by-line reasoning.
- **Each role has its own connection string.** The API connects as `app_user`,
  the worker as `worker_user`, erasure as `erasure_role`, and migrations as the
  owner. See `docs/ops/database-roles.md`.
- **`/api/metrics` answers 404 at the edge** and is open inside the network.

## What is yours

### The network

Nothing but the edge should be reachable. On a single host that means a firewall
that admits 80 and 443 and nothing else; Postgres, Redis and the object store
must not have a public address at all. The compose file publishes only
`127.0.0.1:8080`, so the remaining exposure is whatever you put in front of it.

### The secrets

`.env.prod` is read by Compose and never baked into an image. Two of them fail
the boot when missing, deliberately:

- `BETTER_AUTH_SECRET` — sessions are signed with it. Changing it signs everyone
  out; leaking it lets somebody mint a session.
- `STORAGE_SIGNING_SECRET` — the local storage driver signs its own URLs.
  Without it the service would hand out URLs anybody could forge, and the
  failure would look exactly like the feature working.

`AI_API_KEY` is optional; without it the assistant refuses with the variable's
name rather than failing to start.

### TLS

`auto_https off` in the Caddyfile, because this file describes the shape and a
real deployment supplies its own hostname. Replace `:8080` with the hostname and
delete that line: Caddy obtains and renews a certificate on its own.

### Files

The stack ships with `STORAGE_DRIVER=local`, and that choice has a cost written
into the compose file: **one API replica**, because objects live on its disk.

A presigned S3 URL is signed for a *hostname*, and on one host the API and a
browser cannot agree on one — a URL signed for `minio:9000` is refused when used
from `localhost:9000`, and the reverse. A real deployment sets
`STORAGE_DRIVER=s3` and points `S3_*` at a managed store whose hostname is the
same from both sides; then the API scales.

### Resource limits and restarts

Every service is `restart: unless-stopped`, which is what you want for a crash
and not for a crash loop — a container that cannot start will restart forever
without saying why. Watch `docker compose ps` after a deploy rather than
assuming.

The compose file sets no CPU or memory limits. On a shared host, add them: the
API and the worker are Node processes whose heap grows until something stops
them, and "something" should be a limit you chose rather than the kernel's OOM
killer choosing for you.

`docs/ops/capacity.md` has the measured numbers to size them from —
**about 1.0 GB for the whole stack** under 20 concurrent readers — and
`pnpm prod:smoke` is how to measure them again on your own hardware.

### Logs

JSON on stdout, one line per request, with `reqId` on every line. Docker's
default driver keeps them forever; set `max-size` and `max-file` or a disk fills
up months from now for a reason nobody connects to logging.

## Observability

`OTEL_EXPORTER_OTLP_ENDPOINT` points at a collector; unset means nothing is
traced and every request still carries an id. `docs/contracts/observability.md`
says which spans exist and which do not.

`/api/metrics` is scraped from inside the network. It is **404 at the edge** —
404 rather than 403, because a 403 confirms the route exists.

## Backups

```sh
tools/scripts/backup.sh ./backups
```

Two files come out: a `pg_dump` in the custom format, and a tar of the object
store. They are separate because a deployment on S3 backs the bucket up where
the bucket lives and needs only the first.

**`pg_dump`, not a copy of the data directory.** A file copy taken while the
server is running is not a backup; it is a directory that sometimes restores.

Run it on a schedule, and **put the output somewhere else**. A backup on the
same disk as the database survives a mistake and not a disk. Encrypt it: it
contains every row, including whatever your users consider private.

`backup_age_seconds` is the metric that tells you it stopped. Alert on it. The
common failure is not a corrupt backup — it is a backup that quietly stopped
running three weeks ago.

## Restoring

```sh
tools/scripts/restore.sh backups/postgres-<stamp>.dump backups/storage-<stamp>.tar.gz
```

It stops the applications, drops and recreates the database, restores the dump,
replaces the object store, and starts everything again. It is destructive on
purpose: merging a backup into a live database leaves a half-restored system
nobody can reason about.

It uses **only what the backup contains**. A restore that quietly needs the
running system — a migration replayed from the repository, a role created by
hand, an object still on a disk somewhere — is a restore that works in a drill
and fails in an outage.

See `docs/ops/slo.md` for the measured RPO and RTO, and for the drill that
measured them.

### Who may restore, and who is told

A restore destroys the current database. That makes it the one operation where
"who is allowed" has to be written down *before* the night somebody needs it —
during an incident nobody reads a policy, they read a runbook.

| | |
| --- | --- |
| **Owner** | the on-call engineer for the service. One person, named on the rota, not "the team". |
| **May run it** | the owner, alone. A second person may hold the terminal; only one decides. |
| **Must be told first** | whoever can say what the data loss costs — the product owner, or whoever answers to the customer. A restore chooses to lose everything since the last backup, and that is a business decision wearing an operations hat. |
| **Must be told after** | everybody who was told first, plus support, with the backup's timestamp — that timestamp *is* the window of lost work, and support will be asked about it. |

Before running it, write down the answers to these, in the incident channel:

1. **Which backup**, by filename and timestamp. Not "the latest".
2. **What is lost**: everything written after that timestamp. Say it as a
   duration, out loud.
3. **Why a restore rather than a repair.** A restore is right for corruption or
   deletion, and wrong for "the application is behaving oddly" — for which it
   loses data and fixes nothing.
4. **Who agreed**, by name.

Afterwards, and before saying it is over:

- The application answers: `curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/api`.
- A row that existed before the backup is readable through the API, not only
  present in the database.
- An uploaded file **downloads**, not merely appears in a listing. The drill in
  `docs/ops/slo.md` checks the bytes for exactly this reason.
- The worker is consuming: `queue_depth{state="waiting"}` falls rather than
  climbing.

**Rehearse it on a schedule, not after an incident.** A restore procedure that
has not been run in six months is a document, not a capability — which is why
the drill is part of Phase 6's exit gate rather than an appendix to it.

## The release, and how to check it

`.github/workflows/release.yml` builds, scans, describes and signs each image on
a `v*` tag. Every step produces something you can check afterwards — an image
with a signature nobody verifies is a decoration:

```sh
# The signature, keyless: no key anybody had to keep safe for a year.
cosign verify \
  --certificate-identity-regexp '^https://github.com/<owner>/<repo>/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/<owner>/<repo>/core-api@sha256:<digest>

# Where it came from: the commit, the workflow, the runner.
gh attestation verify oci://ghcr.io/<owner>/<repo>/core-api@sha256:<digest> \
  --owner <owner>

# What is inside it.
cosign download attestation \
  --predicate-type https://cyclonedx.org/bom \
  ghcr.io/<owner>/<repo>/core-api@sha256:<digest>
```

Deploy by **digest**, not by tag. A tag moves; a digest is the image that was
scanned and signed.

### What has been exercised, and what has not

The workflow itself has never run: there is no remote to push a tag to. Rather
than leave that as a claim, every step it performs was run by hand against a
**real registry** — a `registry:2` on localhost, a real push, a real signature
and a real attestation:

```
cosign sign --key cosign.key <registry>/core-api@<digest>
  → Signing artifact... Pushing signature to: <registry>/core-api

cosign verify --key cosign.pub <registry>/core-api@<digest>
  → The cosign claims were validated
  → The signatures were verified against the specified public key

trivy image --format cyclonedx --output sbom.cdx.json <image>
cosign attest --key cosign.key --type cyclonedx --predicate sbom.cdx.json <image>
cosign verify-attestation --key cosign.pub --type cyclonedx <image>
  → The cosign claims were validated
```

Two things are still only exercised by the workflow, and both are GitHub's to
provide:

- **Keyless signing.** The commands above used a generated key pair. Keyless
  binds the signature to the workflow's OIDC identity, and only GitHub can issue
  that token — which is the point of it.
- **SLSA build provenance**, produced by `actions/attest-build-provenance` from
  the runner's own view of the build.

So: the publishing path is proven; the identity behind it is not, and cannot be
from here.

### What the scan gate found

The gate fails on a fixable HIGH or CRITICAL, and making it pass was not a
formality. Measured with Trivy against the real images:

- **Ten findings in the API image, eight of them npm's own vendored packages** —
  `tar`, `undici`, `brace-expansion`, `ip-address` — none reachable by anything
  in a single-file bundle started with `node main.js`. The runtime images now
  delete npm, which also takes `npm install` away from anybody who gets code
  execution inside a container.
- **Two more from Alpine's OpenSSL**, present in `node:24.19.0-alpine` *and* in
  the newest `node:24-alpine`. Alpine had the patch; the Node image had not been
  rebuilt with it. The runtime stages `apk upgrade libcrypto3 libssl3`, which is
  a fix rather than an exception.
- **Forty-six in the web image, all Next.js 16.1.7**, fixed in 16.2.11 and
  later. The catalog moved to `~16.3.4`. That is the gate doing the job it
  exists for: nothing else in this workspace would have said so.

After all three, every image reports **0 fixable HIGH or CRITICAL**.

The bases are pinned by digest as well as by tag, so two builds of one commit
use the same base. The `apk upgrade` is the deliberate exception: it means the
image is not purely a function of its digest, which is the right trade — an
image pinned to a known-vulnerable library is reproducible and wrong.
