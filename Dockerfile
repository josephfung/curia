# Build stage: compile TypeScript and install dependencies
FROM node:22-slim AS build

WORKDIR /app

# Enable pnpm via corepack (ships with Node 22)
RUN corepack enable

# Install dependencies first (layer caching — deps change less often than src)
COPY package.json pnpm-lock.yaml ./
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
# --system: no login shell, UID/GID in the system range.
# --no-create-home: no home directory needed; /app is the working dir.
RUN groupadd --system curia && useradd --system --gid curia --no-create-home curia

WORKDIR /app

RUN corepack enable

# Copy manifest and lockfile, then install production deps only
COPY package.json pnpm-lock.yaml ./
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

EXPOSE 3000

# Health check matches the Fastify /api/health route
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

# Drop to non-root before starting the process.
# HOME=/tmp gives tools (e.g. tsx's disk cache) a writable location;
# system users created with --no-create-home otherwise have HOME=/ (read-only).
ENV HOME=/tmp
USER curia

# tsx handles dynamic .ts skill imports with ESM .js→.ts extension resolution.
# The compiled dist/index.js is the entrypoint, but it dynamically imports
# raw .ts skill handlers at runtime.
CMD ["pnpm", "exec", "tsx", "dist/index.js"]
