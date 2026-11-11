# curia-browser: the Chromium the web-browser skill drives, in its own container (#2541).
#
# Curia attaches to it over CDP (BROWSER_CDP_URL). Keeping Chrome here rather than in the
# core image keeps the core image browser-free, and keeps page code away from Curia's
# secrets and database: this container gets neither, and docker-compose.yml puts it on a
# network shared only with Curia.
#
# The Chromium is the one Patchright downloads for the patchright version in
# pnpm-lock.yaml, so an image built from the same commit as the core image matches the
# driver inside Curia. docker-publish.yml builds both from one commit under one tag.

ARG COREPACK_VERSION=0.36.0
ARG COREPACK_SHA256=9128cfe26aee0c99f4fc68c15c6b8b12309a68be0de2c012cdfea2a463cb722f

# Build stage: same node:26-slim digest as the root Dockerfile (keep them in step).
FROM node:26-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39 AS build

WORKDIR /app

# Corepack, as in the root Dockerfile (see the ARGs there).
ARG COREPACK_VERSION
ARG COREPACK_SHA256
ADD --checksum=sha256:${COREPACK_SHA256} https://registry.npmjs.org/corepack/-/corepack-${COREPACK_VERSION}.tgz /tmp/corepack.tgz
RUN set -e; \
    mkdir -p /usr/local/lib/node_modules/corepack; \
    tar -xzf /tmp/corepack.tgz -C /usr/local/lib/node_modules/corepack --strip-components=1 --no-same-owner; \
    rm /tmp/corepack.tgz; \
    ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack; \
    corepack enable

# Install from the lockfile so the patchright version, and so the Chromium build, is the
# one the core image ships. --ignore-scripts: nothing here needs an install script.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/console/package.json ./apps/console/
COPY apps/antfarm/package.json ./apps/antfarm/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY docker/pnpm-retry.sh /usr/local/bin/pnpm-retry
RUN pnpm-retry pnpm install --frozen-lockfile --prod --ignore-scripts

# Download Chromium (no headless shell: this container runs it headful under Xvfb) and
# copy out patchright-core, which has no dependencies, so the runtime stage can run its
# install-deps without node_modules. `chrome` is linked to a fixed path because the
# download's directory name differs by architecture.
RUN set -eu; \
    core="$(node -e "const p=require('path'),f=require('fs');const d=f.realpathSync('node_modules/patchright');console.log(p.dirname(require.resolve('patchright-core/package.json',{paths:[d]})))")"; \
    cp -rL "$core" /opt/patchright-core; \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright pnpm-retry node /opt/patchright-core/cli.js install --no-shell chromium; \
    chrome="$(find /ms-playwright -path '*/chromium-*' -type f -name chrome -perm -u+x | head -n 1)"; \
    test -n "$chrome"; \
    ln -s "$chrome" /ms-playwright/chrome

# Runtime stage. Debian slim rather than node: nothing here runs Node.
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2

# Chromium's system libraries and fonts, from Patchright's own list for this Debian
# release (install-deps), so the list moves with the Chromium build. Node and
# patchright-core are bind-mounted for this one step and never land in a layer.
# xvfb comes with that list; openbox and tint2 give Xvfb a work area so
# screen.availHeight is not screen.height (#2221); socat exposes DevTools (see the
# entrypoint). `upgrade` pulls Debian security fixes into the base layer's packages.
# libatomic1 is the one library the Node binary needs that Debian slim lacks.
RUN --mount=type=bind,from=build,source=/usr/local/bin/node,target=/usr/local/bin/node \
    --mount=type=bind,from=build,source=/opt/patchright-core,target=/opt/patchright-core \
    set -eu; \
    apt-get -o Acquire::Retries=3 update; \
    apt-get -o Acquire::Retries=3 upgrade -y; \
    apt-get -o Acquire::Retries=3 install -y --no-install-recommends libatomic1; \
    node /opt/patchright-core/cli.js install-deps chromium; \
    apt-get -o Acquire::Retries=3 install -y --no-install-recommends openbox tint2 socat; \
    rm -rf /var/lib/apt/lists/*

# Non-root: Chrome refuses its sandbox as root. The UID matches the core image's curia
# user only by convention; the two containers share no files.
RUN groupadd --system --gid 1001 browser \
 && useradd --system --uid 1001 --gid 1001 --no-create-home browser \
 && mkdir -p /profile \
 && chown browser:browser /profile \
 && chmod 0700 /profile

COPY --from=build /ms-playwright /ms-playwright
COPY docker/browser-entrypoint.sh /usr/local/bin/browser-entrypoint

# Fail the build, not the boot: Chrome must start and report its version here.
RUN /ms-playwright/chrome --version

# The persistent profile (cookies and sign-ins). docker-compose.yml mounts a volume here.
VOLUME /profile

# HOME on the /tmp tmpfs that docker-compose.yml mounts over a read-only root.
ENV HOME=/tmp \
    USER=browser \
    LOGNAME=browser
USER browser

# DevTools, forwarded from Chrome's loopback-only port. Never publish it: it has no
# authentication.
EXPOSE 9222

# A DevTools answer means Chrome is up, not just the forwarder. Bash's /dev/tcp, so the
# image carries no curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/9222 && printf 'GET /json/version HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nConnection: close\\r\\n\\r\\n' >&3 && grep -q webSocketDebuggerUrl <&3"]

ENTRYPOINT ["/usr/local/bin/browser-entrypoint"]
