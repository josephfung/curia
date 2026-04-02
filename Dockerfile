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
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN corepack enable

# Copy manifest and lockfile, then install production deps only
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Copy compiled output from build stage
COPY --from=build /app/dist ./dist

# Copy runtime data files loaded at startup (agents, skills, config, migrations)
COPY agents/ ./agents/
COPY skills/ ./skills/
COPY config/ ./config/
COPY src/db/migrations/ ./src/db/migrations/

EXPOSE 3000

# Health check matches the Fastify /api/health route
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

# --experimental-strip-types: skill handlers are .ts files loaded via dynamic import()
CMD ["node", "--experimental-strip-types", "dist/index.js"]
