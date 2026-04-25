# KG Sensitivity Visualization — Design Spec

**Issue:** josephfung/curia#200
**Date:** 2026-04-25
**Status:** Approved for implementation

---

## Context

Sensitivity classification on KG nodes is already fully implemented on the storage side:

- Migration `024_add_kg_node_sensitivity.sql` added `sensitivity TEXT NOT NULL DEFAULT 'internal'` with CHECK constraint and index to `kg_nodes`
- `SensitivityClassifier` is instantiated at startup from `config/default.yaml` and injected into `EntityMemory`
- `storeFact()` and `createEntity()` auto-classify sensitivity from node label + properties using configurable keyword rules
- `memory.store` bus events include the `sensitivity` field (required in `MemoryStorePayload`)
- The coordinator system prompt includes exfiltration-aware directives

The remaining gap is entirely in the KG web explorer UI. The `/api/kg/nodes` and `/api/kg/graph` routes do not select or return `sensitivity` (or `properties`), so there is nothing for the browser to display.

Existing nodes in the DB have `sensitivity = 'internal'` (the column default applied when the migration ran). No backfill is planned — `'internal'` is the correct safe default.

---

## Scope

1. **API** — expose `sensitivity` and `properties` from both KG routes
2. **Color toggle** — let the user switch node color encoding between Type and Sensitivity
3. **Detail drawer** — a right-side panel that shows all node attributes when a node is selected
4. **Unit tests** — cover the two unchecked AC items from the issue

---

## 1. API Changes (`src/channels/http/routes/kg.ts`)

### `KgNodeRow` interface

Add `sensitivity` and ensure `properties` is typed:

```typescript
interface KgNodeRow {
  id: string;
  type: string;
  label: string;
  properties: Record<string, unknown>;  // already selected, was silently dropped in response
  confidence: number;
  decay_class: string;
  source: string;
  created_at: string;
  last_confirmed_at: string;
  sensitivity: string;                  // NEW
}
```

### SQL — both `/api/kg/nodes` and `/api/kg/graph`

Add `sensitivity` to every `SELECT` list. Example for the fallback (no `node_id`) query:

```sql
SELECT id, type, label, properties, confidence, decay_class, source,
       created_at, last_confirmed_at, sensitivity          -- sensitivity added
FROM kg_nodes
...
```

All three queries in the file need this: the flat `/api/kg/nodes` query, the recursive traversal query, and the fallback recent-nodes query.

### Response mapping

Add both fields to every `.map()` that serialises node rows:

```typescript
nodes: result.rows.map((row) => ({
  id: row.id,
  type: row.type,
  label: row.label,
  properties: row.properties,          // was selected but dropped — now included
  confidence: row.confidence,
  decayClass: row.decay_class,
  source: row.source,
  createdAt: row.created_at,
  lastConfirmedAt: row.last_confirmed_at,
  sensitivity: row.sensitivity,        // NEW
})),
```

---

## 2. Frontend — Color Toggle

### Placement

A `Color by:` button group sits in a thin toolbar strip above the Cytoscape canvas, left-aligned. Two buttons: **Type** (default, active on load) and **Sensitivity**.

### Sensitivity color palette

| Level | Hex | Rationale |
|---|---|---|
| `public` | `#5E9E6B` | Green — no restrictions |
| `internal` | `#4174C8` | Blue-grey — neutral default (matches existing base node color) |
| `confidential` | `#C9874A` | Amber — elevated caution |
| `restricted` | `#E86040` | Red — matches `--destructive` token |

### Technical implementation

`sensitivity` is added to each Cytoscape element's `data` object in `nodeToElement()`:

```javascript
function nodeToElement(n) {
  return {
    data: {
      id: n.id,
      label: n.label,
      type: n.type,
      confidence: n.confidence != null ? n.confidence : 0.5,
      decayClass: n.decayClass || 'permanent',
      sensitivity: n.sensitivity || 'internal',   // NEW
      properties: n.properties || {},              // NEW (used by drawer)
      source: n.source || '',                      // NEW (used by drawer)
      createdAt: n.createdAt || '',                // NEW (used by drawer)
      lastConfirmedAt: n.lastConfirmedAt || '',    // NEW (used by drawer)
    },
  };
}
```

Switching color mode calls `cy.style()` to hot-swap only the node background-color rules. All other styles (size, opacity, edge width) are untouched. A JS variable `colorMode` ('type' | 'sensitivity') tracks the active mode.

Sensitivity-mode selectors added to the stylesheet:

```javascript
{ selector: 'node[sensitivity="public"]',       style: { 'background-color': '#5E9E6B' } },
{ selector: 'node[sensitivity="internal"]',     style: { 'background-color': '#4174C8' } },
{ selector: 'node[sensitivity="confidential"]', style: { 'background-color': '#C9874A' } },
{ selector: 'node[sensitivity="restricted"]',   style: { 'background-color': '#E86040' } },
```

These are applied only when the mode is `'sensitivity'`; in `'type'` mode the existing type selectors apply.

---

## 3. Frontend — Detail Drawer

### Layout

The canvas area (`#main-canvas-area`) becomes a flex row. The canvas (`#cy` container) takes `flex: 1`. The drawer (`#node-detail-drawer`) is `320px` wide, hidden by default (`display: none`), and sits to the right of the canvas. When visible, the canvas genuinely shrinks — the drawer is not overlaid.

```
┌─────────────┬──────────────────────────────┬──────────────────┐
│  Left       │                              │  #node-detail    │
│  Sidebar    │   Cytoscape Canvas (flex:1)  │  -drawer         │
│  (220px)    │                              │  (320px, hidden  │
│             │                              │   until node tap)│
└─────────────┴──────────────────────────────┴──────────────────┘
```

### Drawer content

| Field | Display |
|---|---|
| Label | Large heading (`font-family: Lora`) |
| Type | Coloured pill using the existing type palette |
| Sensitivity | Coloured pill using the sensitivity palette above |
| Confidence | Decimal, e.g. `0.85` |
| Decay class | Plain text: `permanent` / `slow_decay` / `fast_decay` |
| Source | Monospace text, full provenance string |
| Created at | Formatted local date/time |
| Last confirmed | Formatted local date/time |
| Properties | Key–value table; omitted entirely if `properties` is empty or `{}` |

A close button (×) in the drawer header sets `display: none` and restores the canvas to full width. Tapping a different node replaces the content without closing.

### Tap handler change

The existing `cy.on('tap', 'node', ...)` already calls `expandNeighborhood()`. The handler is extended to also call `openNodeDrawer(node.data())` — a new function that populates and shows the drawer.

---

## 4. Unit Tests

Two tests to close the remaining AC items from the issue:

**Test 1** — in `src/memory/knowledge-graph.upsert.test.ts` (alongside the existing upsert tests):

- Create a node via `KnowledgeGraphStore.createNode()` without passing `sensitivity`; assert the returned node has `sensitivity === 'internal'`.

**Test 2** — in a new `src/memory/sensitivity.test.ts` (alongside `sensitivity.ts`):

- Instantiate `SensitivityClassifier.fromRules()` with a rule `{ category: 'financial', sensitivity: 'confidential', patterns: ['revenue'] }`; call `classify('Q3 revenue forecast', {})` and assert the result is `'confidential'`.

The second test exercises the classifier directly — no database required, fast unit test.

---

## Files Changed

| File | Change |
|---|---|
| `src/channels/http/routes/kg.ts` | Add `sensitivity` to `KgNodeRow`, all SQL SELECTs, all response mappings, `nodeToElement()`, color-toggle UI, and detail drawer UI |
| `src/memory/knowledge-graph.upsert.test.ts` | Add default-sensitivity unit test |
| `src/memory/sensitivity.test.ts` | New file — add financial auto-classification unit test |
| `CHANGELOG.md` | Add entry under `[Unreleased]` |
| `package.json` | Patch version bump (completing a partially-shipped spec) |

No other files need to change — the storage layer is complete.
