# Build stage: compile TypeScript and install dependencies
FROM node:22-slim AS build

WORKDIR /app

# Enable pnpm via corepack (ships with Node 22)
RUN corepack enable

# Install dependencies first (layer caching — deps change less often than src)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY src/ ./src/
COPY tsconfig.json ./
# Skip --dts: type declarations are for library consumers, not the runtime image.
# tsup's DTS build also trips a TS 6.0 deprecation error on any tsconfig with baseUrl.
RUN pnpm exec tsup src/index.ts --format esm --no-dts

# Production stage: minimal runtime image
FROM node:22-slim

# curl is needed for the HEALTHCHECK command
# Copy uv/uvx binaries from the official signed image (Astral's recommended
# Docker pattern — no curl|sh, cryptographically signed, version-pinned).
# uvx is needed to spawn workspace-mcp as an MCP stdio subprocess.
COPY --from=ghcr.io/astral-sh/uv:0.6.3 /uv /uvx /usr/local/bin/

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

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

# Copy runtime data files loaded at startup
# Full src/ is needed because skill handlers import from src/ (e.g., bus/events.ts)
# and tsx resolves these at runtime
COPY agents/ ./agents/
COPY skills/ ./skills/
COPY config/ ./config/
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

# Health check matches the Fastify /api/health route
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

# Drop to non-root before starting the process.
# HOME=/tmp: --no-create-home leaves /etc/passwd pointing at /home/curia (which
# does not exist on disk). Tools like tsx and uv write cache files to $HOME; with
# a missing home they would get ENOENT. /tmp is world-writable and always exists.
# USER and LOGNAME are not set automatically by Docker when using exec-form CMD
# (no shell login), so we set them explicitly for MCP subprocess environments.
ENV HOME=/tmp \
    USER=curia \
    LOGNAME=curia
USER curia

# tsx handles dynamic .ts skill imports with ESM .js→.ts extension resolution.
# The compiled dist/index.js is the entrypoint, but it dynamically imports
# raw .ts skill handlers at runtime.
CMD ["pnpm", "exec", "tsx", "dist/index.js"]
