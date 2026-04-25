# KG Sensitivity Visualization — Design Spec

**Issue:** josephfung/curia#350
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
2. **Color toggle** — let the user switch node color encoding between Type, Sensitivity, and Decay class
3. **Visual encodings** — node size encodes edge degree (more connections = larger); opacity encodes confidence (lower confidence = more transparent)
4. **Detail drawer** — a right-side panel that shows all node attributes when a node is selected
5. **Unit tests** — cover the two unchecked AC items from the issue

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

A `Color by:` button group sits in a thin toolbar strip above the Cytoscape canvas, left-aligned. Three buttons: **Type** (default, active on load), **Sensitivity**, and **Decay**.

### Sensitivity color palette

| Level | Hex | Rationale |
|---|---|---|
| `public` | `#5E9E6B` | Green — no restrictions |
| `internal` | `#4174C8` | Blue-grey — neutral default (matches existing base node color) |
| `confidential` | `#C9874A` | Amber — elevated caution |
| `restricted` | `#E86040` | Red — matches `--destructive` token |

### Decay class color palette

| Class | Hex | Rationale |
|---|---|---|
| `permanent` | `#5E9E6B` | Green — never expires |
| `slow_decay` | `#4174C8` | Blue — fades slowly |
| `fast_decay` | `#E86040` | Red/orange — fades quickly |

### Technical implementation

`sensitivity`, `degree`, and other new fields are added to each Cytoscape element's `data` object in `nodeToElement()`:

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
      degree: 0,                                   // NEW — populated by updateDegrees() after cy.add()
    },
  };
}
```

Switching color mode uses per-element `node.style('background-color', color)` overrides (not stylesheet rebuilding). All other styles (size, opacity, edge width) are untouched. A JS variable `colorMode` ('type' | 'sensitivity' | 'decay') tracks the active mode. Reverting to type mode calls `nodes().removeStyle('background-color')` to restore the type stylesheet rules.

Color maps:

```javascript
const SENS_COLORS = {
  public: '#5E9E6B', internal: '#4174C8',
  confidential: '#C9874A', restricted: '#E86040',
};
const DECAY_COLORS = {
  permanent: '#5E9E6B', slow_decay: '#4174C8', fast_decay: '#E86040',
};
```

In `'sensitivity'` mode each node gets `SENS_COLORS[node.data('sensitivity')]`; in `'decay'` mode each node gets `DECAY_COLORS[node.data('decayClass')]`; in `'type'` mode all per-element overrides are cleared.

---

## 3. Frontend — Visual Encodings (Size and Opacity)

Two additional channels encode node attributes independently of color, so all three color modes remain informative simultaneously.

### Node size — edge degree

Node size encodes the number of edges touching each node (its degree in the graph). More-connected nodes are visually larger, making structural hubs immediately apparent regardless of which color mode is active.

After every `cy.add()` call (both initial render and neighborhood expansion), an `updateDegrees()` helper stores the computed degree back into each node's data:

```javascript
function updateDegrees() {
  cy.nodes().forEach((node) => {
    node.data('degree', node.degree());
  });
}
```

The Cytoscape stylesheet uses `mapData` to scale size continuously:

```javascript
{ selector: 'node', style: { width: 'mapData(degree, 0, 15, 20, 52)',
                              height: 'mapData(degree, 0, 15, 20, 52)' } }
```

This replaces the previous type-based size rules (which assigned different fixed sizes to `Person`, `Organization`, etc.).

### Node opacity — confidence

Node opacity encodes the classifier's confidence score. Low-confidence nodes are semi-transparent; high-confidence nodes are fully opaque. This lets the user visually filter out uncertain nodes without hiding them entirely.

```javascript
{ selector: 'node', style: { opacity: 'mapData(confidence, 0, 1, 0.15, 1.0)' } }
```

This replaces the previous decay-class-based opacity rules (which used two fixed levels for `slow_decay` and `fast_decay`).

---

## 4. Frontend — Detail Drawer  <!-- was §3 before visual-encodings section was added -->

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

## 5. Unit Tests

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
| `src/channels/http/routes/kg.ts` | Add `sensitivity` to `KgNodeRow`, all SQL SELECTs, all response mappings, `nodeToElement()`; add degree-based sizing, confidence opacity, three-button color toggle (type/sensitivity/decay), `updateDegrees()` helper, and detail drawer UI |
| `src/memory/knowledge-graph.upsert.test.ts` | Add default-sensitivity unit test |
| `src/memory/sensitivity.test.ts` | New file — add financial auto-classification unit test |
| `CHANGELOG.md` | Add entry under `[Unreleased]` |
| `package.json` | Patch version bump (completing a partially-shipped spec) |

No other files need to change — the storage layer is complete.
