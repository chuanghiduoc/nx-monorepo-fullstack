# syntax=docker/dockerfile:1.7-labs
# The API, as an image.
#
# Build from the workspace root: this project's sources are only half of what
# it needs — the lockfile, the catalog and every library it imports live there.
#
#   docker build -f apps/core/api/Dockerfile -t core-api .
#

# Pinned to the version the workspace develops and tests on. A range here would
# let an image be built on a runtime nothing was ever run against.
ARG NODE_VERSION=24.19.0

# And pinned by digest, because a tag moves. `node:24.19.0-alpine` is rebuilt
# whenever its own base gets a patch, so two builds of the same commit can
# differ — which makes "the image that was scanned" and "the image that is
# running" two different things nobody can tell apart.
#
# The tag stays beside it so a person reading this knows what the digest is.
# Renovate is what moves both.
ARG NODE_DIGEST=sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

# --- build ------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine@${NODE_DIGEST} AS build

# corepack activates the exact pnpm the lockfile was written by, taken from
# package.json rather than named twice.
RUN corepack enable

WORKDIR /workspace

# Manifests first, so a change to source code does not invalidate the install
# layer. Copying the whole tree here would make every edit reinstall.
# Manifests only, so a change to source code does not invalidate the install
# layer — and by pattern rather than by name, so deleting a project (the
# browser application, say) does not break this build with a COPY that names a
# file no longer there.
#
# `--parents` keeps each manifest at its own path, which is what pnpm needs to
# see the workspace. It is a Dockerfile 1.7 feature, which is why the syntax
# directive above is the very first line of this file — anywhere else and it is
# read as an ordinary comment.
COPY --parents package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --parents apps/*/*/package.json libs/*/*/package.json ./
COPY --parents libs/*/*/*/package.json libs/*/*/*/*/package.json tools/*/package.json ./

# `--frozen-lockfile` is the point of copying the lockfile: the image resolves
# exactly what the tests resolved, or the build fails.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

COPY . .

# Generates the Prisma client as a build dependency, then bundles everything
# into `dist` — the bundle is self-contained, so nothing below installs.
RUN pnpm exec nx build core-api --skip-nx-cache

# --- migrate ----------------------------------------------------------------
# A one-shot image that applies the migration history, built from the same
# stage so the schema and the client can never disagree with the service's.
#
#   docker build -f apps/core/api/Dockerfile --target migrate -t core-api-migrate .
#
# It keeps the whole build stage, node_modules and all: the Prisma CLI is not a
# bundle and cannot be reduced to one file. That is a deliberate trade — this
# image runs once per deploy and never serves traffic, so its size costs a few
# seconds of pull rather than anything ongoing.
#
# It connects as the owner. The service's own role has no DDL, which is what
# makes a row-level policy something the service cannot switch off.
FROM build AS migrate

WORKDIR /workspace/libs/core/server/platform/data-access-db

# Inherited from `build`, which runs as root because installing and compiling
# needs to. Applying migrations does not: it reads a directory and talks to a
# database. This is also the one image in the deployment that connects as the
# owning role, so it is the last one to leave running as root — the runtime
# image next door has dropped to `node` since it was written.
USER node

ENTRYPOINT ["pnpm", "exec", "prisma"]
CMD ["migrate", "deploy"]

# --- runtime ----------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine@${NODE_DIGEST} AS runtime

# Signals reach PID 1 unhandled without an init, so a container would ignore
# SIGTERM and be killed rather than shut down — losing whatever it was doing.
# `upgrade` before `add`, and it is the difference between a release gate that
# means something and one that is switched off.
#
# Measured: `node:24.19.0-alpine` — and `node:24-alpine`, the newest there is —
# ships an OpenSSL with a fixable HIGH (CVE-2026-14456). Alpine has the patch;
# the Node image has not been rebuilt with it. So there is no base to move to,
# and the choices were to ignore the finding, to lower the gate, or to install
# the fix. This installs the fix.
#
# It also means the image is not purely a function of its digest any more, which
# is the cost: two builds of this Dockerfile a week apart can carry different
# OpenSSL builds. That is the right trade — an image pinned to a known-vulnerable
# library is reproducible and wrong — and it is why the scan runs on the image
# rather than on the base.
RUN apk upgrade --no-cache libcrypto3 libssl3 && apk add --no-cache tini

ENV NODE_ENV=production

WORKDIR /app

# `node` exists in the base image and owns nothing it can write to. Running as
# root would let a bug in the service edit the service.
COPY --from=build --chown=node:node /workspace/apps/core/api/dist ./

# Where the `local` storage driver keeps its objects, created here so the named
# volume mounted over it inherits this ownership. Docker gives a fresh volume to
# root when the image has no directory at the mount point, and the service —
# which runs as `node`, deliberately — then cannot write a single upload.
RUN mkdir -p /var/lib/app/storage && chown node:node /var/lib/app/storage

# npm is removed from the runtime, and it is not a size optimisation.
#
# The application is one bundled file started with `node main.js`; nothing here
# runs a package manager. What npm brings is its own vendored dependency tree,
# and a scanner reads it: measured, `trivy --ignore-unfixed --severity
# HIGH,CRITICAL` reported ten problems in this image and eight of them were
# npm's — `tar`, `undici`, `brace-expansion`, `ip-address` — none of which any
# code path here can reach.
#
# Leaving them would mean either a release gate that fails every build or an
# ignore list that trains people to stop reading it. Removing the package
# manager also takes `npm install` away from anybody who gets code execution
# inside the container, which is the better half of the reason.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER node

EXPOSE 3000

# Answers the same route the readiness probe uses, so an unhealthy container is
# one that cannot serve rather than one whose process happens to be alive.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "main.js"]
