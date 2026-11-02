# 12 — Knowledge Graph Web Explorer

## Goal

Provide a secure browser-based UI for inspecting Curia's knowledge graph directly from the existing Postgres schema (`kg_nodes`, `kg_edges`) without changing storage architecture.

## Implementation approach

The original design used a hand-rolled Cytoscape.js SPA served directly by Fastify from `node_modules`. This was migrated to the React console (`apps/console/`) as part of the framework migration (#753). The console is now the sole UI; the legacy SPA has been removed.

The KG view in the React console uses `/api/kg/*` for graph primitives (nodes, graph, node merge), rendered via React and Cytoscape.js bundled through Vite. Console task/contact/chat CRUD lives under `/api/tasks`, `/api/contacts`, and `/api/chat` (#872).

## Security model

The web explorer is gated by `WEB_APP_BOOTSTRAP_SECRET` from the vault:
- `GET /` serves the React console shell (session cookie required for data).
- Console routes, including `/api/kg/*`, require either `x-web-bootstrap-secret` or a valid `curia_session` cookie.
- `POST /auth` exchanges the access key for that cookie. The cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` when `APP_ORIGIN` is `https://`.
- A session lasts **90 days from last use**. An authenticated request slides `expires_at` forward, at most once an hour, and updates `last_seen_at`. A session idle longer than 90 days is rejected and the console sends the operator to `/login`.
- Sessions are stored hashed in Postgres and reloaded at boot, so a restart or deploy does not end them.
- `POST /auth/logout` ends the current session. Settings → System → Devices (`/system/devices`) lists every live session (name, kind, last seen, created, this device, notification status) and can rename, revoke, or sign out every other device. Revoking removes the row from memory and from Postgres. Push subscriptions, once they exist, are removed with the session by a foreign key. The same page mints a phone pairing code. The phone opens `/pair#c=…` or types the short code. Each credential works once and creates a `paired_device` session. Once that session is recorded, the unused credential expires within two minutes. The desktop shows each redemption. The session lives in the cookie only.
- `POST /auth` is audited as `operator.session` action `login`. A successful pair is audited as `operator.session` action `pair` (`stage: completed`). `secondCredential: true` is set when the other credential on the same code was already redeemed. `invitation: true` is set when the phone used an invitation link. Minting and stopping an invitation link are audited as `invite` and `cancel_invite` (#2412). Revoke, logout, and sign-out-all are audited in two stages (`requested`, then `completed` or `failed`) and name the acting session. With the bootstrap-secret header and no cookie, sign-out-others ends every live session, not only the others.

If `WEB_APP_BOOTSTRAP_SECRET` is missing, the KG API routes are not registered at all (intentional 404, not 503).

## API surface

- `GET /api/kg/nodes`
  - Query params: `query`, `type`, `limit`, `exclude_facts`
  - Purpose: label, alias and property text search and browsing. Merge tombstones are excluded; decayed archived nodes still appear, as they do in `/graph`; `exclude_facts=true` also drops `fact` nodes. Each node carries `aliases` and `identitySource`.

- `GET /api/kg/graph`
  - Query params: `node_id`, `depth`, `limit`
  - Purpose: neighborhood traversal for a selected node; falls back to recent nodes when no `node_id` is provided.
  - A well-formed `node_id` that names no `kg_nodes` row → `404 { error: "Node not found: <id>" }`. An isolated node (exists, no edges) → `200` with that node in `nodes` and `edges: []` (#1881).
  - A `node_id` that is an archived merge tombstone → `404 { error, code: "node_merged", mergedInto, label }` (#2233). Merge tombstones and their edges never appear in graph results or traversal. Each graph node carries `aliases` and `archived`.

- `GET /api/kg/nodes/:id/merge-candidates`
  - Query params: `limit` (default 8, max 20)
  - Purpose: likely duplicates of a node, for the merge dialog. See *Merging nodes*.

- `POST /api/kg/nodes/merge`
  - Body: `survivorId`, `absorbedId`, `dryRun` (default `true`), `planToken`, `resolutions`
  - Purpose: preview or apply a node merge. See *Merging nodes*.

## Graph layout

The graph view uses a **physics-aware layout** so the structure of the graph is legible rather than a uniform hairball:

- **Per-type node repulsion** — node types repel at different strengths (facts ~3,000; project/decision/concept ~12,000; person/org/event ~20,000), so high-level entities spread out while their facts cluster near them.
- **Per-edge ideal length** — edges have type-dependent rest lengths (facts ~70px; strong relationships ~110px; other edges ~150px), sized against the label width so neighbouring labels don't collide.
- **Label-aware spacing** — node footprints include their labels and gravity is low (0.1), so labels don't overlap and components spread out.
- **Per-edge elasticity** — edge stiffness scales with the edge's strength/confidence, so stronger relationships pull their endpoints closer.
- **Degree-based node sizing** — more-connected nodes render larger.
- **Viewport centering** — the view centers on the focal node.

## Filter panel

The left sidebar has a **filter panel** with two checklist axes, populated from the nodes on the canvas (#351):

- **Type** — every node type present, with counts.
- **Sensitivity** — `public`, `internal`, `confidential`, `restricted`, always listed.

Values are OR'd within an axis and AND'd across axes; an axis with nothing checked is unconstrained. Filtering is client-side: non-matching nodes and their edges are hidden without re-fetching, nodes added by neighborhood expansion are filtered immediately, and the sidebar search results only list matching nodes. **Clear filters** resets to show-all.

On default mount, the explorer loads the **principal's 2-hop neighborhood** so the most relevant subgraph is visible without a manual search.

## Merging nodes

The graph accumulates duplicates: two `person` nodes for one human, or an `event` called "Acme" that is really the organization. The node detail drawer has a **Merge…** button (hidden for `fact` nodes, disabled for the agent node) that merges the open node with a second one. The decision record is [ADR-052](../adr/052-knowledge-graph-node-merge.md); the design is `docs/wip/2026-10-21-kg-node-merge-design.md`.

### User flow

1. **Pick a node.** The dialog lists *likely duplicates* from `merge-candidates` (reason chips: same name, alias, similar) and a debounced search. Candidates may be of any type, because cross-type duplicates are the point.
2. **Review.** Two cards show **Keep** (the survivor, initially the node the user started from) and **Merge in** (the absorbed node), with a **Swap** button. The survivor's type is the result type. A cross-type merge says so ("‘Acme Summit’ (Event) will become part of ‘Acme’ (Organization)"), and the preview may suggest a swap when the direction would lose information (the absorbed node is the principal's, or has contacts the survivor's type cannot take, or is a person with a contact merged into a contactless node of another type).
   - **Blockers** disable Merge. **Warnings** that require acknowledgement (for example the principal-identity transfer, which lists every identity that will become a principal identity) each need a ticked checkbox.
   - **Conflicts** are shown only when present, each with a pre-selected default the user can change: the name, properties, conflicting facts (keep either or both), possible duplicate facts (combine or keep both), contact field conflicts and auth-override conflicts.
   - A plain-language **What happens** summary lists the counts (facts moved, duplicates combined, connections moved, and so on).
3. **Apply.** The dialog is the confirmation. On success the console selects the survivor, drops the absorbed node from the sidebar and shows "Merged ‘X’ into ‘Y’". If the graph changed during review (409 `stale_preview`), the console re-previews and keeps the user's still-valid choices.

A deep link to the absorbed node's id receives `404 node_merged`; the console follows `mergedInto` and notes that the node was merged.

### `POST /api/kg/nodes/merge`

`dryRun` defaults to `true` and returns a `NodeMergePreview`: conflicts, blockers, warnings, the contact plan, a summary and a `planToken` (a SHA-256 over the canonical snapshot of both nodes). `dryRun: false` requires the `planToken` and applies the merge, optionally with `resolutions` (answers to conflicts by deterministic id, plus `acknowledgements`), and returns a `NodeMergeResult`. Apply recomputes the token under row locks and refuses if anything changed.

| Status | `code` | Meaning |
|---|---|---|
| 200 | | Preview, or the applied result |
| 400 | `invalid_request`, `ack_required`, `unknown_resolution` | Bad body, a required acknowledgement is missing, or a resolution names no conflict |
| 404 | `node_not_found` | A node is missing or archived |
| 409 | `stale_preview` | The plan token no longer matches |
| 422 | `blocked` | One or more blockers (`blockers` lists them) |
| 503 | `unavailable` | The merge service is not wired on this server |

`GET /api/kg/nodes/:id/merge-candidates` returns `{ candidates: [{ node, score, reasons }] }` for live non-fact nodes of any type: a case-insensitive label or alias match scores 1.0, and an embedding cosine at or above the embedding profile's fuzzy ambiguity floor scores the similarity. Only vectors from the live model are compared, and with entity memory off no embedding candidates are offered. The comparison is an exact scan rather than the HNSW index, which returns its 40 nearest nodes before facts are filtered out, so facts close to the node could hide a duplicate.

### Survivorship (summary)

- **Node.** The survivor keeps its id and type. The label is the user's choice (the other becomes an alias); aliases are unioned and capped at `MAX_ALIASES_PER_ENTITY`; properties are unioned, and a key with different values is a conflict (default: newer `last_confirmed_at`, survivor on a tie). Confidence, `last_confirmed_at` and `sensitivity` take the max (sensitivity never goes down), `decay_class` the most durable, `created_at` the min.
- **Facts.** Attribute facts with the same value collapse; different values are a conflict (survivor, absorbed or both; a dropped value is appended to `previous_values`, and the kept fact takes the higher sensitivity of the two). A deleted fact node's own `previous_values` history moves to the kept fact, and so do its edges to other nodes (an edge the kept fact already has is dropped). Exact and near-duplicate (cosine at least the embedding profile's fact-dedup threshold, between vectors from the live model) non-attribute facts collapse. Every other absorbed fact moves to the survivor unchanged, with no re-embedding.
- **Edges.** An edge between the two nodes is dropped, an edge that collides with a survivor edge is collapsed, and the rest are re-pointed.
- **Contacts.** By survivor type: a `person` survivor folds all contacts into one (see spec 09, *Merging contacts*); an `organization` survivor re-points the absorbed contacts without merging them; any other type refuses an absorbed node that has contacts. When several folded contacts disagree and the survivor has no value, a denied override beats a grant and the earliest contact wins a field; a `contacts_disagree` warning lists each case.
- **Guards.** The agent node blocks a merge on either side; the principal's node cannot be the absorbed side; as survivor it needs the identity-transfer acknowledgement.
- **Absorbed node.** Archived as a tombstone with `properties.merged_into` and `merged_at`, not deleted.

The whole apply is one Postgres transaction. Known limitation: a concurrent writer that resolved the absorbed node before the lock can attach an edge to the tombstone after the commit; the tombstone's `merged_into` makes it visible (ADR-052).

### Audit

A successful apply publishes `kg.nodes_merged` (survivor and absorbed id, type and label, the result label, `crossType`, contact merge ids, summary counts, chosen resolutions, the console `actor`, and `principalIdentitiesTransferred` and `principalPrimaryFieldsFilled`, which record the identities that became principal identities and the primary email or phone filled on the principal, and are empty unless the survivor's contact is the principal). The audit row targets the survivor (`target_type='kg_node'`).
