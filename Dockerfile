# Build stage: compile TypeScript and install dependencies
#
# Base image pinned by digest for a reproducible supply chain (clears the OpenSSF
# Scorecard Pinned-Dependencies Docker finding). The tag is kept inline (not just
# in a trailing comment) so Dependabot's docker ecosystem can read the semantic
# version and apply the "don't chase Current majors" ignore rule in
# .github/dependabot.yml — a bare `node@sha256:…` pin would otherwise track `latest`.
# Node 24 "Krypton" is the Active LTS (node 22 is Maintenance, node 26 is Current).
FROM node:24-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS build

WORKDIR /app

# Enable pnpm via corepack (bundled with Node 24)
RUN corepack enable

# Install dependencies first (layer caching — deps change less often than src).
# Copy all workspace manifests so pnpm installs the full workspace in one shot.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/console/package.json ./apps/console/
RUN pnpm install --frozen-lockfile

# Build backend
COPY src/ ./src/
COPY tsconfig.json ./
# Skip --dts: type declarations are for library consumers, not the runtime image.
# tsup's DTS build also trips a TS 6.0 deprecation error on any tsconfig with baseUrl.
RUN pnpm exec tsup src/index.ts --format esm --no-dts

# Build console frontend — output lands in apps/console/dist/
COPY apps/console/ ./apps/console/
RUN pnpm --filter @curia/console run build

# Production stage: minimal runtime image.
# Same node:24-slim digest pin as the build stage above (see that comment for the
# Scorecard / Dependabot rationale). Both stages must stay on the same digest.
FROM node:24-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203

# curl is needed for the HEALTHCHECK command
# Copy uv/uvx binaries from the official signed image (Astral's recommended
# Docker pattern — no curl|sh, cryptographically signed, version-pinned).
# uvx is needed to spawn workspace-mcp as an MCP stdio subprocess.
COPY --from=ghcr.io/astral-sh/uv:0.6.3 /uv /uvx /usr/local/bin/

# apt-get upgrade pulls the latest Debian 12 security patches for packages baked
# into the node:24-slim base layer (e.g. libgnutls30, libgcrypt20). Without it the
# image ships whatever versions were frozen when the base image was built, which
# Trivy flags as known CVEs even though Debian has already published fixes.
# Run upgrade before installing curl so curl is installed from the patched lists.
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# Create a non-root system user/group for the runtime process.
# UIDs/GIDs are pinned (not dynamic) so docker-compose tmpfs uid= options
# and any external tooling can reference a stable, known value.
# --no-create-home: HOME=/tmp is set below; no home dir on disk is needed.
RUN groupadd --system --gid 1001 curia \
 && useradd --system --uid 1001 --gid 1001 --no-create-home curia

WORKDIR /app

RUN corepack enable

# Copy manifest and lockfile, then install production deps only
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# tsx is needed at runtime: skill handlers are .ts files loaded via dynamic
# import(), and they use ESM .js extension mapping (e.g., import from './foo.js'
# resolving to foo.ts). Node's --experimental-strip-types doesn't handle this;
# tsx does, and it's already used for dev (pnpm dev).
RUN pnpm add tsx

# Copy compiled output from build stage
COPY --from=build /app/dist ./dist

# Copy console static bundle — served by Fastify at runtime
COPY --from=build /app/apps/console/dist ./apps/console/dist

# Copy runtime data files loaded at startup
# Full src/ is needed because skill handlers import from src/ (e.g., bus/events.ts)
# and tsx resolves these at runtime
COPY agents/ ./agents/
COPY skills/ ./skills/
COPY config/ ./config/
# JSON Schemas consumed by src/startup/validator.ts at boot. tsup bundles every
# source file into a single dist/index.js, so the file-relative path that used
# to compute schemasDir from `import.meta.dirname` would land at /schemas in
# the container. The validator now takes schemasDir as an explicit parameter
# computed from src/index.ts (../schemas), which resolves to /app/schemas here.
COPY schemas/ ./schemas/
COPY src/ ./src/

# node_modules were installed as root above, so we chown the entire /app tree
# to the non-root user before dropping privileges. /usr/local/bin/uv,
# /usr/local/bin/uvx, and /usr/bin/curl are world-executable (no chown needed).
RUN chown -R curia:curia /app

# Pre-create the tmpfs mount point so Docker's runtime tmpfs mount inherits
# curia ownership. Without this, Docker mounts the tmpfs as root:root with
# mode=0700, making it inaccessible to the curia user at runtime.
RUN mkdir -p /run/curia-tempfiles \
 && chown curia:curia /run/curia-tempfiles \
 && chmod 0700 /run/curia-tempfiles

# Pre-create the OAuth token directory for workspace-mcp. Without this,
# Docker's copy-up creates the directory as root when the named volume is
# first mounted, making it unwritable by the curia user at runtime.
RUN mkdir -p /tmp/.google_workspace_mcp \
 && chown curia:curia /tmp/.google_workspace_mcp

EXPOSE 3000

# Health check matches the Fastify /api/health route.
# start_period bumped 15s → 60s to cover the realistic cold-boot cost:
# JIT, agent loading, KG migrations check, scheduler init can take 20-30s
# on small hosts. The previous 15s window flapped the container as "unhealthy"
# before it had finished starting up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

# Drop to non-root before starting the process.
# HOME=/tmp: --no-create-home leaves /etc/passwd pointing at /home/curia (which
# does not exist on disk). Tools like tsx and uv write cache files to $HOME; with
# a missing home they would get ENOENT. /tmp is world-writable and always exists.
# USER and LOGNAME are not set automatically by Docker when using exec-form CMD
# (no shell login), so we set them explicitly for MCP subprocess environments.
#
# NODE_ENV=production switches the pino logger to stdout JSON (default branch in
# src/logger.ts). Without it, pino-pretty writes to `curia.log` *inside* the
# container — invisible to `docker logs` and lost when the container exits.
# That made #805 bug 3 effectively undebuggable: every fatal startup error
# vanished before anyone could see it. File-based logging is an anti-pattern
# inside containers; production-mode logging is the only sane default for the
# Docker image.
#
# COREPACK_ENABLE_DOWNLOAD_PROMPT=0 is defence-in-depth: the CMD below invokes
# tsx directly (no pnpm/corepack at runtime), but if anyone changes CMD back to
# go through pnpm, modern corepack would prompt non-interactively and exit 1
# silently. Keeping the env var means future corepack invocations don't block.
ENV HOME=/tmp \
    USER=curia \
    LOGNAME=curia \
    NODE_ENV=production \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
USER curia

# Invoke tsx directly rather than going through `pnpm exec tsx ...`. The pnpm
# route triggers corepack at runtime, which in turn looks for a pnpm tarball
# in /tmp/.cache/corepack (HOME=/tmp for the curia user). That cache is empty
# at runtime because the build-stage pnpm install ran as root and populated
# /root/.cache/corepack, and corepack then prompts before downloading. In a
# non-TTY container the prompt sees EOF and the process exits 1 silently —
# exactly the failure mode that took two hours to debug in #805.
#
# tsx is needed because dist/index.js dynamically imports raw .ts skill handlers
# at runtime via ESM .js→.ts extension resolution. node alone cannot do that.
# The .bin shim is created by `pnpm add tsx` above and is the documented way
# to call tsx without a package manager wrapper.
CMD ["./node_modules/.bin/tsx", "dist/index.js"]
