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

## Graph layout

The graph view uses a **physics-aware layout** so the structure of the graph is legible rather than a uniform hairball:

- **Per-type node repulsion** — node types repel at different strengths (facts ~1,000; person/org/event ~7,500), so high-level entities spread out while their facts cluster near them.
- **Per-edge ideal length** — edges have type-dependent rest lengths (facts ~40px; strong relationships ~60px).
- **Per-edge elasticity** — edge stiffness scales with the edge's strength/confidence, so stronger relationships pull their endpoints closer.
- **Degree-based node sizing** — more-connected nodes render larger.
- **Viewport centering** — the view centers on the focal node.

On default mount, the explorer loads the **principal's 2-hop neighborhood** so the most relevant subgraph is visible without a manual search.

---

## Implementation Status

| Item | Status |
|---|---|
| `GET /api/kg/nodes` — text search with `query`, `type`, `limit` params | Done |
| `GET /api/kg/graph` — neighborhood traversal with `node_id`, `depth`, `limit` params | Done |
| `WEB_APP_BOOTSTRAP_SECRET` gating on all data API routes | Done |
| KG view ported to React console (`apps/console/src/pages/KgPage.tsx`) | Done |
| Legacy Cytoscape SPA (`/old`) removed | Done |
| Physics-aware layout — per-type repulsion, per-edge ideal length & elasticity, degree-based sizing, focal-node centering | Done |
| Default mount loads the principal's 2-hop neighborhood | Done |
