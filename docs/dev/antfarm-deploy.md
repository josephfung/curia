# Ant Farm — production deploy (`curia-deploy`)

Ant Farm ships in the **public `curia` repo** (AF-6: Dockerfile + `antfarm-static` route).
Production VPS builds use the **private [`curia-deploy`](https://github.com/josephfung/curia-deploy)**
image (`deploy/compose/Dockerfile.curia`), which must mirror the same build steps.

Ready-to-copy companion files live in [`deploy/curia-deploy/`](../../deploy/curia-deploy/).

## What to change in `curia-deploy`

### 1. `deploy/compose/Dockerfile.curia`

Mirror the Ant Farm steps from [`curia/Dockerfile`](../../Dockerfile) (build stage + runtime copy).

**Dependency install** — add workspace manifests before `pnpm install --frozen-lockfile`:

```dockerfile
COPY apps/antfarm/package.json ./apps/antfarm/
COPY packages/shared-types/package.json ./packages/shared-types/
```

**Backend build** — copy shared-types source (interpreter + API depend on it):

```dockerfile
COPY packages/ ./packages/
```

**Ant Farm build** — layer licensed art, then Vite build:

```dockerfile
# Licensed LimeZu art from curia-deploy (optional; CC0 placeholders if empty)
COPY custom/assets/antfarm/ ./apps/antfarm/public/assets/limezu/
COPY apps/antfarm/ ./apps/antfarm/
RUN pnpm --filter @curia/antfarm run build
```

Place the `COPY custom/assets/antfarm/` line **after** `apps/antfarm/package.json` is
on disk but **before** `pnpm --filter @curia/antfarm run build` so Vite bundles the sheets.

**Runtime stage** — copy the static bundle (after the console dist copy):

```dockerfile
COPY --from=build /app/apps/antfarm/dist ./apps/antfarm/dist
```

Apply the unified patch from `deploy/curia-deploy/patches/Dockerfile.curia.antfarm.patch`
if your `Dockerfile.curia` still matches the `curia/Dockerfile` layout. If your deploy
Dockerfile prefixes paths with `curia/` (some `deploy.sh` layouts do), adjust:

| Patch path | With `curia/` prefix |
|------------|----------------------|
| `COPY apps/antfarm/...` | `COPY curia/apps/antfarm/...` |
| `COPY packages/...` | `COPY curia/packages/...` |
| `COPY custom/assets/antfarm/` | unchanged (always from deploy repo) |

### 2. `custom/assets/antfarm/`

Add the directory from `deploy/curia-deploy/custom/assets/antfarm/`:

- `SOURCE.md` — pack URLs, layout, license notes
- `limezu/` — drop licensed sprite sheets here (gitignored in public curia)

See [`apps/antfarm/public/assets/README.md`](../../apps/antfarm/public/assets/README.md)
and [`apps/antfarm/CREDITS.md`](../../apps/antfarm/CREDITS.md).

### 3. No compose / proxy changes

Ant Farm is served by the existing `curia` service on port 3000:

- SPA: `/antfarm/`
- API: `/api/antfarm/timeline`, `/api/antfarm/stream`

Caddy (or your reverse proxy) should already forward all paths to Curia. No new container
or route block is required unless you intentionally restrict paths.

### 4. `deploy.sh`

No change expected if it already runs `docker compose build` against `Dockerfile.curia`
with the deploy repo as build context (including `custom/`).

## Verify after deploy

1. Sign in via the console (session cookie).
2. Open `https://<host>/antfarm/` — SPA loads, no 404 from console wildcard.
3. Scrub/play a window or switch to live mode — timeline API and SSE connect.
4. DevTools → Network: assets load under `/antfarm/assets/...` (Vite `base: '/antfarm/'`).

## Curia version pin

Deploy the Ant Farm-capable Curia release (epic #1313 / AF-1–AF-6 merged). The production
image must include `src/channels/http/routes/antfarm-static.ts` and the antfarm API routes.
