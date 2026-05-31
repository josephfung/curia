# 12 — Knowledge Graph Web Explorer

## Goal

Provide a secure browser-based UI for inspecting Curia's knowledge graph directly from the existing Postgres schema (`kg_nodes`, `kg_edges`) without changing storage architecture.

## Implementation approach

The original design used a hand-rolled Cytoscape.js SPA served directly by Fastify from `node_modules`. This was migrated to the React console (`apps/console/`) as part of the framework migration (#753). The console is now the sole UI; the legacy SPA has been removed.

The KG view in the React console uses the same `/api/kg/*` API routes, now rendered via React and Cytoscape.js bundled through Vite.

## Security model

The web explorer is gated by `WEB_APP_BOOTSTRAP_SECRET` from `.env`:
- `GET /` serves the React console shell (session cookie required for data).
- All `/api/kg/*` routes require either `x-web-bootstrap-secret` header or a valid `curia_session` cookie.

If `WEB_APP_BOOTSTRAP_SECRET` is missing, the KG API routes are not registered at all (intentional 404, not 503).

## API surface

- `GET /api/kg/nodes`
  - Query params: `query`, `type`, `limit`
  - Purpose: label/property text search and browsing.

- `GET /api/kg/graph`
  - Query params: `node_id`, `depth`, `limit`
  - Purpose: neighborhood traversal for a selected node; falls back to recent nodes when no `node_id` is provided.

---

## Implementation Status

| Item | Status |
|---|---|
| `GET /api/kg/nodes` — text search with `query`, `type`, `limit` params | Done |
| `GET /api/kg/graph` — neighborhood traversal with `node_id`, `depth`, `limit` params | Done |
| `WEB_APP_BOOTSTRAP_SECRET` gating on all data API routes | Done |
| KG view ported to React console (`apps/console/src/pages/KgPage.tsx`) | Done |
| Legacy Cytoscape SPA (`/old`) removed | Done |
