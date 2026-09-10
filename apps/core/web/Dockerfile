# syntax=docker/dockerfile:1.7-labs
# The web application, as an image.
#
# Build from the workspace root, for the same reason the API does:
#
#   docker build -f apps/core/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_API_ORIGIN=https://app.example.com -t core-web .
#

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

RUN corepack enable

WORKDIR /workspace

# Manifests only, so a change to source code does not invalidate the install
# layer — and by pattern rather than by name, so deleting a project does not
# break this build with a COPY that names a file no longer there.
#
# `--parents` keeps each manifest at its own path, which is what pnpm needs to
# see the workspace. It is a Dockerfile 1.7 feature, which is why the syntax
# directive above is the very first line of this file — anywhere else and it is
# read as an ordinary comment.
COPY --parents package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --parents apps/*/*/package.json libs/*/*/package.json ./
COPY --parents libs/*/*/*/package.json libs/*/*/*/*/package.json tools/*/package.json ./

# A real directory tree rather than the workspace's usual links into a shared
# store. The framework's file tracing copies what it finds, and in a linked
# install what it finds is a symlink — sometimes one whose target it never
# copied — so the standalone output does not stand alone.
#
# Appended to the copy inside this image rather than set in the repository:
# only this build wants a hoisted tree, and a developer's install should keep
# the layout their tooling expects. `COPY . .` below restores the original
# file, by which time the install has already happened.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    printf '\nnodeLinker: hoisted\n' >> pnpm-workspace.yaml && \
    pnpm install --frozen-lockfile

COPY . .

# The browser learns where the API is at *build* time: the framework inlines a
# NEXT_PUBLIC_* variable into the bundle, so a value supplied when the
# container starts arrives too late and the bundle points at localhost.
ARG NEXT_PUBLIC_API_ORIGIN
ARG NEXT_PUBLIC_DEFAULT_LOCALE=vi
ENV NEXT_PUBLIC_API_ORIGIN=${NEXT_PUBLIC_API_ORIGIN}
ENV NEXT_PUBLIC_DEFAULT_LOCALE=${NEXT_PUBLIC_DEFAULT_LOCALE}

RUN test -n "$NEXT_PUBLIC_API_ORIGIN" || \
      (echo "NEXT_PUBLIC_API_ORIGIN must be supplied as a build argument." && exit 1) && \
    pnpm exec nx build core-web --skip-nx-cache

# The standalone output names its dependencies by symlink rather than carrying
# the files, because that is how they are installed. Dereferencing here is what
# makes the tree actually stand alone.
#
# A traced tree can also name a link whose target was never copied. Such a link
# resolves to nothing either way, and it is what makes a dereferencing copy
# fail — so they go first, and anything genuinely missing surfaces as a server
# that will not start rather than as a build that will not finish. Written the
# long way because the shell in this image is BusyBox, whose `find` has no
# `-xtype`.
RUN set -eu; \
    find apps/core/web/.next/standalone -type l -exec sh -c 'for link; do [ -e "$link" ] || rm -f "$link"; done' _ {} +; \
    cp -rL apps/core/web/.next/standalone /standalone; \
    cp -r apps/core/web/.next/static /standalone/apps/core/web/.next/static; \
    if [ -d apps/core/web/public ]; then \
      cp -r apps/core/web/public /standalone/apps/core/web/public; \
    fi; \
    test -f /standalone/apps/core/web/server.js

# --- runtime ----------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine@${NODE_DIGEST} AS runtime

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
# Otherwise the server binds loopback inside the container and nothing outside
# it can connect — the container looks healthy and answers nobody.
ENV HOSTNAME=0.0.0.0
ENV PORT=4200

WORKDIR /app

COPY --from=build --chown=node:node /standalone ./

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

EXPOSE 4200

HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4200/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/core/web/server.js"]
