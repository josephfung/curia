# curia-deploy — Ant Farm companion changes

Production builds use `curia-deploy/deploy/compose/Dockerfile.curia`, not `curia/Dockerfile`.
These files are the **curia-deploy half** of Ant Farm AF-6 (#1319).

## Apply

1. Copy `custom/assets/antfarm/` into your `curia-deploy` checkout.
2. Apply `patches/Dockerfile.curia.antfarm.patch` to `deploy/compose/Dockerfile.curia`:
   ```bash
   cd /path/to/curia-deploy
   patch -p1 < /path/to/curia/deploy/curia-deploy/patches/Dockerfile.curia.antfarm.patch
   ```
   If hunks fail (path prefix differs), follow the manual steps in `docs/dev/antfarm-deploy.md`.
3. Drop licensed LimeZu sprite sheets into `custom/assets/antfarm/limezu/` (see `SOURCE.md`).
4. Rebuild and deploy as usual (`deploy.sh` / `docker compose build curia`).

## No compose / Caddy changes expected

Ant Farm is served by the existing `curia` container on `:3000` under `/antfarm/`.
The reverse proxy should already forward all paths to Curia; no new service or route is required.

## Verify

- `GET https://<host>/antfarm/` returns the SPA (session cookie from console login).
- `GET https://<host>/api/antfarm/timeline?from=...&to=...` returns JSON after auth.
- Browser network tab shows assets under `/antfarm/assets/...` (Vite base path).
