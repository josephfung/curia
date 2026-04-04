# Knowledge Graph Web Explorer

## Goal

Provide a secure browser-based UI for inspecting Curia's knowledge graph directly from the existing Postgres schema (`kg_nodes`, `kg_edges`) without changing storage architecture.

## Visualization layer choice

We selected **Cytoscape.js** as the visualization layer and wrapped it in Curia's Node/Fastify HTTP channel, serving the asset locally from `node_modules`.

Why Cytoscape.js:
- Mature open-source project (MIT licensed, long maintenance history).
- Designed for interactive graph analysis (layout, styling, neighborhood-focused exploration).
- Lightweight to embed in a single-page internal tool.
- Works with plain JSON node/edge payloads, mapping directly to the Postgres-backed model Curia already has.

## Security model

The web explorer is gated by `WEB_APP_BOOTSTRAP_SECRET` from `.env`:
- `GET /kg` serves the UI shell (no graph data).
- `GET /api/kg/nodes` requires `x-web-bootstrap-secret`.
- `GET /api/kg/graph` requires `x-web-bootstrap-secret`.

If `WEB_APP_BOOTSTRAP_SECRET` is missing, the feature is intentionally disabled.

## API surface

- `GET /api/kg/nodes`
  - Query params: `query`, `type`, `limit`
  - Purpose: label/property text search and browsing.

- `GET /api/kg/graph`
  - Query params: `node_id`, `depth`, `limit`
  - Purpose: neighborhood traversal for a selected node; falls back to recent nodes when no `node_id` is provided.

## Notes

This design intentionally keeps dependencies minimal and uses the existing Node.js runtime so operational dependencies stay aligned with Curia's current deployment profile.
