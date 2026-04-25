# KG Sensitivity Visualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose sensitivity classification in the KG web explorer via a node detail drawer and a color-by toggle.

**Architecture:** All changes land in two areas: (1) the KG HTTP routes file (`kg.ts`) which owns both the API layer and the embedded single-page UI, and (2) two test files that cover the already-implemented storage behavior. The API changes expose `sensitivity` and `properties` from the DB; the UI changes add a right-side detail drawer and a `Color by` toggle that hot-swaps Cytoscape node color rules.

**Tech Stack:** TypeScript, Node.js, Fastify, Postgres, Cytoscape.js (browser), Vitest

---

> **Worktree required.** Per CLAUDE.md, all development must happen in a git worktree:
> ```bash
> git worktree add ../curia-kg-sensitivity -b feat/kg-sensitivity-visualization
> WORKTREE=/path/to/curia-kg-sensitivity MAIN=/path/to/repos/curia
> for item in .env; do if [ -e "$MAIN/$item" ]; then ln -sf "$MAIN/$item" "$WORKTREE/$item"; fi; done
> npm --prefix $WORKTREE install
> ```

---

## File Map

| File | Action | What changes |
|---|---|---|
| `src/memory/sensitivity.test.ts` | **Create** | Unit tests for `SensitivityClassifier` |
| `src/memory/knowledge-graph.upsert.test.ts` | **Modify** | Add default-sensitivity test |
| `src/channels/http/routes/kg.ts` | **Modify** | API types, SQL, response mapping, UI (toggle + drawer) |
| `CHANGELOG.md` | **Modify** | Add entry under `[Unreleased]` |
| `package.json` | **Modify** | Patch version bump (`0.20.0` → `0.20.1`) |

---

## Task 1: Unit test — SensitivityClassifier classification rules

**Files:**
- Create: `src/memory/sensitivity.test.ts`

- [ ] **Step 1.1: Create the test file**

```typescript
// src/memory/sensitivity.test.ts
import { describe, it, expect } from 'vitest';
import { SensitivityClassifier } from './sensitivity.js';

describe('SensitivityClassifier', () => {
  it('classifies financial content as confidential based on keyword rule', () => {
    const classifier = SensitivityClassifier.fromRules([
      { category: 'financial', sensitivity: 'confidential', patterns: ['revenue'] },
    ]);
    expect(classifier.classify('Q3 revenue forecast', {})).toBe('confidential');
  });

  it('defaults to internal when no rule matches', () => {
    const classifier = SensitivityClassifier.fromRules([
      { category: 'financial', sensitivity: 'confidential', patterns: ['revenue'] },
    ]);
    expect(classifier.classify('team standup notes', {})).toBe('internal');
  });

  it('matches keywords in property values, not just the label', () => {
    const classifier = SensitivityClassifier.fromRules([
      { category: 'financial', sensitivity: 'confidential', patterns: ['salary'] },
    ]);
    expect(classifier.classify('employee record', { details: 'salary adjustment' })).toBe('confidential');
  });

  it('category hint bypasses keyword scanning', () => {
    const classifier = SensitivityClassifier.fromRules([
      { category: 'hr', sensitivity: 'confidential', patterns: ['performance'] },
    ]);
    // Label doesn't contain 'performance' but the category hint matches
    expect(classifier.classify('annual review', {}, 'hr')).toBe('confidential');
  });

  it('most restrictive rule wins when multiple patterns match', () => {
    const classifier = SensitivityClassifier.fromRules([
      { category: 'financial', sensitivity: 'confidential', patterns: ['revenue'] },
      { category: 'board', sensitivity: 'restricted', patterns: ['board'] },
    ]);
    // Both match — restricted wins
    expect(classifier.classify('board revenue discussion', {})).toBe('restricted');
  });
});
```

- [ ] **Step 1.2: Run the tests**

```bash
npm --prefix /path/to/worktree test src/memory/sensitivity.test.ts
```

Expected: all 5 tests **PASS** (the classifier is already implemented — these tests document existing behaviour).

- [ ] **Step 1.3: Commit**

```bash
git -C /path/to/worktree add src/memory/sensitivity.test.ts
git -C /path/to/worktree commit -m "test: add SensitivityClassifier unit tests (#200)"
```

---

## Task 2: Unit test — KnowledgeGraphStore sensitivity default

**Files:**
- Modify: `src/memory/knowledge-graph.upsert.test.ts`

- [ ] **Step 2.1: Add the test**

Open `src/memory/knowledge-graph.upsert.test.ts`. After the last `describe` block, add a new describe block at the end of the file:

```typescript
describe('KnowledgeGraphStore sensitivity defaults', () => {
  it('defaults sensitivity to internal when not specified on createNode', async () => {
    const store = makeStore();
    const node = await store.createNode({
      type: 'fact',
      label: 'quarterly target',
      properties: {},
      source: 'test',
    });
    expect(node.sensitivity).toBe('internal');
  });

  it('preserves explicit sensitivity when provided', async () => {
    const store = makeStore();
    const node = await store.createNode({
      type: 'fact',
      label: 'board minutes',
      properties: {},
      source: 'test',
      sensitivity: 'restricted',
    });
    expect(node.sensitivity).toBe('restricted');
  });
});
```

- [ ] **Step 2.2: Run the tests**

```bash
npm --prefix /path/to/worktree test src/memory/knowledge-graph.upsert.test.ts
```

Expected: all tests **PASS**.

- [ ] **Step 2.3: Commit**

```bash
git -C /path/to/worktree add src/memory/knowledge-graph.upsert.test.ts
git -C /path/to/worktree commit -m "test: add KG node sensitivity default tests (#200)"
```

---

## Task 3: API — expose sensitivity and properties from KG routes

**Files:**
- Modify: `src/channels/http/routes/kg.ts`

This task has three sub-changes: update the `KgNodeRow` interface, add `sensitivity` to SQL, and include both fields in response mappings.

- [ ] **Step 3.1: Update the `KgNodeRow` interface**

Find the `interface KgNodeRow` block (near the top of the file, before the `createUiHtml` function). Replace it:

```typescript
interface KgNodeRow {
  id: string;
  type: string;
  label: string;
  properties: Record<string, unknown>;
  confidence: number;
  decay_class: string;
  source: string;
  created_at: string;
  last_confirmed_at: string;
  sensitivity: string;
}
```

- [ ] **Step 3.2: Add `sensitivity` to the `/api/kg/nodes` query**

Find the `app.get('/api/kg/nodes', ...)` handler. The SQL query selects specific columns — add `sensitivity` to the end of the `SELECT` list:

```sql
SELECT id, type, label, properties, confidence, decay_class, source, created_at, last_confirmed_at, sensitivity
FROM kg_nodes
WHERE ($1::text IS NULL OR type = $1)
  AND (
    $2::text IS NULL
    OR label ILIKE '%' || $2 || '%'
    OR properties::text ILIKE '%' || $2 || '%'
  )
ORDER BY last_confirmed_at DESC
LIMIT $3
```

Then update the response mapping in the same handler to include both new fields:

```typescript
return reply.send({
  nodes: result.rows.map((row) => ({
    id: row.id,
    type: row.type,
    label: row.label,
    properties: row.properties,
    confidence: row.confidence,
    decayClass: row.decay_class,
    source: row.source,
    createdAt: row.created_at,
    lastConfirmedAt: row.last_confirmed_at,
    sensitivity: row.sensitivity,
  })),
});
```

- [ ] **Step 3.3: Add `sensitivity` to both `/api/kg/graph` queries**

Find the `app.get('/api/kg/graph', ...)` handler. It has two queries — the recursive traversal (used when `node_id` is provided) and the fallback recent-nodes query. Both need `sensitivity` added.

**Traversal query** — find the `DISTINCT n.id, n.type, n.label ...` SELECT inside the `WITH RECURSIVE traversal AS (...)` query and add `n.sensitivity` to it:

```sql
SELECT DISTINCT n.id, n.type, n.label, n.properties, n.confidence, n.decay_class, n.source, n.created_at, n.last_confirmed_at, n.sensitivity
FROM traversal t
JOIN kg_nodes n ON n.id = t.id
ORDER BY n.last_confirmed_at DESC
LIMIT $3
```

**Fallback query** — find the simple `SELECT id, type, label ...` query and add `sensitivity`:

```sql
SELECT id, type, label, properties, confidence, decay_class, source, created_at, last_confirmed_at, sensitivity
FROM kg_nodes
ORDER BY last_confirmed_at DESC
LIMIT $1
```

Then update the response mapping in `/api/kg/graph` (the `return reply.send({ nodes: ..., edges: ... })`) to include both new fields on nodes:

```typescript
return reply.send({
  nodes: nodeResult.rows.map((row) => ({
    id: row.id,
    type: row.type,
    label: row.label,
    properties: row.properties,
    confidence: row.confidence,
    decayClass: row.decay_class,
    source: row.source,
    createdAt: row.created_at,
    lastConfirmedAt: row.last_confirmed_at,
    sensitivity: row.sensitivity,
  })),
  edges: edgeResult.rows.map((row) => ({
    id: row.id,
    sourceNodeId: row.source_node_id,
    targetNodeId: row.target_node_id,
    type: row.type,
    confidence: row.confidence,
    decayClass: row.decay_class,
    source: row.source,
    createdAt: row.created_at,
    lastConfirmedAt: row.last_confirmed_at,
  })),
});
```

- [ ] **Step 3.4: Run the full test suite to confirm no regressions**

```bash
npm --prefix /path/to/worktree test
```

Expected: all tests pass. (There are no dedicated route tests — the type changes are compile-time safety only. The SQL changes are straightforward additive column selections.)

- [ ] **Step 3.5: Commit**

```bash
git -C /path/to/worktree add src/channels/http/routes/kg.ts
git -C /path/to/worktree commit -m "feat: expose sensitivity and properties from KG API routes (#200)"
```

---

## Task 4: Frontend — pass new fields through nodeToElement()

**Files:**
- Modify: `src/channels/http/routes/kg.ts` (the embedded JS inside `createUiHtml()`)

- [ ] **Step 4.1: Update `nodeToElement()`**

Find the `function nodeToElement(n)` function inside the `createUiHtml()` template literal. Replace its body:

```javascript
function nodeToElement(n) {
  return {
    data: {
      id: n.id,
      label: n.label,
      type: n.type,
      confidence: n.confidence != null ? n.confidence : 0.5,
      decayClass: n.decayClass || 'permanent',
      sensitivity: n.sensitivity || 'internal',
      properties: n.properties || {},
      source: n.source || '',
      createdAt: n.createdAt || '',
      lastConfirmedAt: n.lastConfirmedAt || '',
      degree: 0,  // updated by updateDegrees() after elements are added
    },
  };
}
```

- [ ] **Step 4.2: Run the test suite**

```bash
npm --prefix /path/to/worktree test
```

Expected: all tests pass.

- [ ] **Step 4.3: Commit**

```bash
git -C /path/to/worktree add src/channels/http/routes/kg.ts
git -C /path/to/worktree commit -m "feat: pass sensitivity and full node metadata through nodeToElement"
```

---

## Task 5: Frontend — color tokens, stylesheet encoding changes, and Cytoscape styles

**Files:**
- Modify: `src/channels/http/routes/kg.ts` (CSS `:root` block and Cytoscape `initCytoscape()` styles)

- [ ] **Step 5.1: Add color tokens to CSS `:root`**

Inside the `<style>` block, find the `:root { ... }` section. Add these CSS variables after the existing `--chart-*` tokens:

```css
/* Sensitivity level colours */
--sens-public:       #5E9E6B;   /* green   — no restrictions */
--sens-internal:     #4174C8;   /* blue    — neutral default */
--sens-confidential: #C9874A;   /* amber   — elevated caution */
--sens-restricted:   #E86040;   /* red     — matches --destructive */

/* Decay class colours */
--decay-permanent:  #5E9E6B;   /* green — stable, no decay */
--decay-slow:       #4174C8;   /* blue  — fading slowly */
--decay-fast:       #E86040;   /* red   — fading quickly, needs reconfirmation */
```

- [ ] **Step 5.2: Update `initCytoscape()` stylesheet — replace type-size and decay-opacity rules**

Two sets of existing rules in the `style: [...]` array inside `cy = cytoscape({ ... })` need to be replaced.

**Remove** the seven type-based size rules (they start with `node[type="person"] { width: 44 ...}`):

```javascript
// DELETE these seven rules:
{ selector: 'node[type="person"]',       style: { width: 44, height: 44 } },
{ selector: 'node[type="organization"]',  style: { width: 44, height: 44 } },
{ selector: 'node[type="project"]',       style: { width: 36, height: 36 } },
{ selector: 'node[type="decision"]',      style: { width: 32, height: 32 } },
{ selector: 'node[type="event"]',         style: { width: 28, height: 28 } },
{ selector: 'node[type="concept"]',       style: { width: 24, height: 24 } },
{ selector: 'node[type="fact"]',          style: { width: 14, height: 14, 'font-size': 0 } },
```

**Remove** the two decay-class opacity rules:

```javascript
// DELETE these two rules:
{ selector: 'node[decayClass="fast_decay"]', style: { opacity: 0.45 } },
{ selector: 'node[decayClass="slow_decay"]', style: { opacity: 0.75 } },
```

**Add** two new rules in their place (insert after the base `node` style block, before the type colour rules):

```javascript
// Degree-based size: nodes with more edges are visually larger.
// 'degree' is set as element data by updateDegrees() after every cy.add().
// Range: isolated node (0 edges) = 20px, hub node (15+ edges) = 52px.
{
  selector: 'node',
  style: {
    width:  'mapData(degree, 0, 15, 20, 52)',
    height: 'mapData(degree, 0, 15, 20, 52)',
  },
},
// Confidence-based opacity: lower confidence = more transparent.
// Replaces the old decay-class opacity encoding.
{
  selector: 'node',
  style: {
    opacity: 'mapData(confidence, 0, 1, 0.15, 1.0)',
  },
},
```

Also update the fact-node rule that was hiding labels — since type-based sizes are gone, the fact-node label suppression needs a different approach. Replace the old fact size+label rule with just the label rule:

```javascript
// Facts: hide label at default size; show when selected.
// (Size is now degree-based — the width/height rule above handles all types.)
{ selector: 'node[type="fact"]',          style: { 'font-size': 0 } },
{ selector: 'node[type="fact"]:selected', style: { 'font-size': 9 } },
```

- [ ] **Step 5.3: Add the `setColorMode()` function and `colorMode` variable**

Find the `// ── KG API helpers` comment that precedes the `setStatus` function. Just before that comment, add:

```javascript
// ── Color mode ────────────────────────────────────────────────────────
// Tracks the active node colour encoding: 'type' (default), 'sensitivity',
// or 'decay'.
var colorMode = 'type';

// Color palette maps — kept in sync with CSS tokens added in Step 5.1.
var SENS_COLORS = {
  public:       '#5E9E6B',
  internal:     '#4174C8',
  confidential: '#C9874A',
  restricted:   '#E86040',
};

var DECAY_COLORS = {
  permanent:  '#5E9E6B',
  slow_decay: '#4174C8',
  fast_decay: '#E86040',
};

function setColorMode(mode) {
  if (!cy) return;
  colorMode = mode;

  if (mode === 'sensitivity') {
    cy.nodes().forEach(function(node) {
      var sens = node.data('sensitivity') || 'internal';
      node.style('background-color', SENS_COLORS[sens] || SENS_COLORS.internal);
    });
  } else if (mode === 'decay') {
    cy.nodes().forEach(function(node) {
      var decay = node.data('decayClass') || 'slow_decay';
      node.style('background-color', DECAY_COLORS[decay] || DECAY_COLORS.slow_decay);
    });
  } else {
    // type mode: remove element-level overrides so stylesheet type-colour
    // selectors take effect again automatically.
    cy.nodes().removeStyle('background-color');
  }

  // Update toggle button active state
  document.getElementById('color-btn-type').classList.toggle('active', mode === 'type');
  document.getElementById('color-btn-sensitivity').classList.toggle('active', mode === 'sensitivity');
  document.getElementById('color-btn-decay').classList.toggle('active', mode === 'decay');
}
```

- [ ] **Step 5.4: Add `updateDegrees()` helper**

`mapData(degree, ...)` in the stylesheet reads from `node.data('degree')`. Since degree is not part of the API payload (it's a graph-topology property), it must be computed client-side after every `cy.add()` call.

Just after the `setColorMode` function, add:

```javascript
// Computes the edge-count (degree) for every node and stores it as element
// data so the mapData(degree, ...) stylesheet rule can size nodes correctly.
// Must be called after every cy.add() — degree changes as edges are added.
function updateDegrees() {
  if (!cy) return;
  cy.nodes().forEach(function(node) {
    node.data('degree', node.degree());
  });
}
```

- [ ] **Step 5.5: Hook `updateDegrees()` and `setColorMode()` into render functions**

Find `function renderGraph(payload)`. Replace the whole function body:

```javascript
function renderGraph(payload) {
  if (!cy) return;
  var elements = payload.nodes.map(nodeToElement).concat(payload.edges.map(edgeToElement));
  cy.elements().remove();
  cy.add(elements);
  updateDegrees();          // must run before layout so sizes are correct
  cy.resize();
  cy.layout(FCOSE_OPTS_FULL).run();
  setColorMode(colorMode);  // re-apply active color mode to new nodes
}
```

Find `function expandNeighborhood(nodeId)`. Inside its `.then()` callback, after `cy.add(newElements)` and the layout call, add both calls:

```javascript
updateDegrees();          // recalculate all degrees now that edges changed
setColorMode(colorMode);  // re-apply active color mode to newly added nodes
```

- [ ] **Step 5.6: Commit**

```bash
git -C /path/to/worktree add src/channels/http/routes/kg.ts
git -C /path/to/worktree commit -m "feat: add color-by toggle (type/sensitivity/decay), degree-based sizing, confidence opacity"
```

---

## Task 6: Frontend — color toggle toolbar HTML and CSS

**Files:**
- Modify: `src/channels/http/routes/kg.ts` (HTML structure and CSS inside `createUiHtml()`)

- [ ] **Step 6.1: Add CSS for the toolbar and toggle buttons**

Inside the `<style>` block, find the `/* ── Cytoscape canvas */` comment. Just above it, add:

```css
/* ── Graph toolbar (color-by toggle, sits above the canvas) ─────────── */
.graph-toolbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--card);
}
.graph-toolbar-label {
  font-size: 0.75rem;
  color: var(--fg-muted);
  font-weight: 500;
  white-space: nowrap;
}
.toggle-btn-group {
  display: flex;
  gap: 2px;
}
.toggle-btn {
  padding: 3px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: none;
  color: var(--fg-muted);
  font-family: inherit;
  font-size: 0.75rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.1s, color 0.1s, border-color 0.1s;
}
.toggle-btn:hover  { background: var(--accent); color: var(--fg); }
.toggle-btn.active { background: var(--muted); color: var(--fg); border-color: var(--teal); }
```

- [ ] **Step 6.2: Update the KG view HTML to add the toolbar**

In the HTML, find the KG view section — the area containing `<div id="cy">`. It is currently inside a `position: relative` wrapper that holds the Cytoscape canvas. The KG view is identified by `id="view-kg"` or similar.

The current structure looks roughly like:

```html
<div id="view-kg" ...>
  <div style="position:relative; flex:1; ...">
    <div id="cy"></div>
  </div>
</div>
```

Wrap the canvas wrapper in a column flex container and insert the toolbar above:

```html
<!-- Canvas column: toolbar + cytoscape -->
<div style="flex:1; display:flex; flex-direction:column; overflow:hidden;">
  <!-- Color-by toolbar -->
  <div class="graph-toolbar">
    <span class="graph-toolbar-label">Color by:</span>
    <div class="toggle-btn-group">
      <button id="color-btn-type" class="toggle-btn active" onclick="setColorMode('type')">Type</button>
      <button id="color-btn-sensitivity" class="toggle-btn" onclick="setColorMode('sensitivity')">Sensitivity</button>
      <button id="color-btn-decay" class="toggle-btn" onclick="setColorMode('decay')">Decay</button>
    </div>
  </div>
  <!-- Cytoscape canvas -->
  <div style="position:relative; flex:1; overflow:hidden;">
    <div id="cy"></div>
  </div>
</div>
```

- [ ] **Step 6.3: Commit**

```bash
git -C /path/to/worktree add src/channels/http/routes/kg.ts
git -C /path/to/worktree commit -m "feat: add color-by toolbar above KG graph canvas (#200)"
```

---

## Task 7: Frontend — detail drawer HTML, CSS, and JS

**Files:**
- Modify: `src/channels/http/routes/kg.ts`

- [ ] **Step 7.1: Add CSS for the detail drawer**

Inside the `<style>` block, after the `.graph-toolbar` rules added in Task 6, add:

```css
/* ── Node detail drawer ──────────────────────────────────────────────── */
.node-detail-drawer {
  flex: none;
  width: 320px;
  border-left: 1px solid var(--border);
  background: var(--card);
  display: none;   /* hidden until a node is tapped */
  flex-direction: column;
  overflow: hidden;
}
.node-detail-drawer.open { display: flex; }

.drawer-header {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.drawer-title {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.drawer-close {
  background: none;
  border: none;
  color: var(--fg-muted);
  cursor: pointer;
  font-size: 1.1rem;
  line-height: 1;
  padding: 2px 4px;
  border-radius: var(--radius-sm);
  transition: color 0.1s, background 0.1s;
}
.drawer-close:hover { color: var(--fg); background: var(--accent); }

.drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.drawer-node-label {
  font-family: 'Lora', Georgia, serif;
  font-size: 1.125rem;
  font-weight: 500;
  color: var(--fg);
  line-height: 1.3;
  word-break: break-word;
}
.drawer-badges {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 99px;
  font-size: 0.6875rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #fff;
}
.badge-type-person       { background: #478189; }
.badge-type-organization { background: #6BAED6; color: #111; }
.badge-type-project      { background: #7E6BA8; }
.badge-type-decision     { background: #C9874A; }
.badge-type-event        { background: #5E9E6B; }
.badge-type-concept      { background: #888888; }
.badge-type-fact         { background: #444444; }
.badge-sens-public       { background: #5E9E6B; }
.badge-sens-internal     { background: #4174C8; }
.badge-sens-confidential { background: #C9874A; }
.badge-sens-restricted   { background: #E86040; }

.drawer-fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.drawer-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.drawer-field-label {
  font-size: 0.6875rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-muted);
}
.drawer-field-value {
  font-size: 0.8125rem;
  color: var(--fg);
  word-break: break-all;
}
.drawer-field-value.mono {
  font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
  font-size: 0.75rem;
}

.drawer-props-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.75rem;
}
.drawer-props-table td {
  padding: 3px 0;
  vertical-align: top;
}
.drawer-props-table td:first-child {
  color: var(--fg-muted);
  padding-right: 10px;
  white-space: nowrap;
  font-weight: 500;
}
.drawer-props-table td:last-child {
  color: var(--fg);
  word-break: break-all;
}
```

- [ ] **Step 7.2: Add drawer HTML to the KG view**

In the HTML, find the KG view section where you added the canvas column wrapper in Task 6. The full KG view content area (inside `id="view-kg"`) now becomes a flex row of three elements: the existing sidebar panel (search + results), the canvas column, and the new detail drawer.

Add the drawer element as the last child of the KG view's flex row:

```html
<!-- Node detail drawer (right panel, hidden until node tap) -->
<div id="node-detail-drawer" class="node-detail-drawer">
  <div class="drawer-header">
    <span class="drawer-title">Node detail</span>
    <button class="drawer-close" onclick="closeNodeDrawer()" title="Close">&times;</button>
  </div>
  <div class="drawer-body" id="drawer-body-content">
    <!-- populated by openNodeDrawer() -->
  </div>
</div>
```

- [ ] **Step 7.3: Add `openNodeDrawer()` and `closeNodeDrawer()` functions**

Inside the `<script>` block, after the `setColorMode()` function added in Task 5, add:

```javascript
// ── Node detail drawer ────────────────────────────────────────────────

function closeNodeDrawer() {
  document.getElementById('node-detail-drawer').classList.remove('open');
}

// Sensitivity badge CSS class lookup
var SENS_BADGE_CLASS = {
  public:       'badge-sens-public',
  internal:     'badge-sens-internal',
  confidential: 'badge-sens-confidential',
  restricted:   'badge-sens-restricted',
};

// Type badge CSS class lookup — mirrors the type colour palette
var TYPE_BADGE_CLASS = {
  person:       'badge-type-person',
  organization: 'badge-type-organization',
  project:      'badge-type-project',
  decision:     'badge-type-decision',
  event:        'badge-type-event',
  concept:      'badge-type-concept',
  fact:         'badge-type-fact',
};

function openNodeDrawer(data) {
  var drawer = document.getElementById('node-detail-drawer');
  var body   = document.getElementById('drawer-body-content');

  body.replaceChildren();

  // ── Label ────────────────────────────────────────────────────────────
  var labelEl = document.createElement('div');
  labelEl.className = 'drawer-node-label';
  labelEl.textContent = data.label || '(no label)';
  body.appendChild(labelEl);

  // ── Type + Sensitivity badges ─────────────────────────────────────────
  var badges = document.createElement('div');
  badges.className = 'drawer-badges';

  var typeBadge = document.createElement('span');
  typeBadge.className = 'badge ' + (TYPE_BADGE_CLASS[data.type] || 'badge-type-fact');
  typeBadge.textContent = data.type || 'unknown';
  badges.appendChild(typeBadge);

  var sensBadge = document.createElement('span');
  var sens = data.sensitivity || 'internal';
  sensBadge.className = 'badge ' + (SENS_BADGE_CLASS[sens] || 'badge-sens-internal');
  sensBadge.textContent = sens;
  badges.appendChild(sensBadge);

  body.appendChild(badges);

  // ── Scalar fields ─────────────────────────────────────────────────────
  var fields = document.createElement('div');
  fields.className = 'drawer-fields';

  function addField(labelText, valueText, mono) {
    var field = document.createElement('div');
    field.className = 'drawer-field';

    var lbl = document.createElement('div');
    lbl.className = 'drawer-field-label';
    lbl.textContent = labelText;

    var val = document.createElement('div');
    val.className = 'drawer-field-value' + (mono ? ' mono' : '');
    val.textContent = valueText || '\u2014'; // em-dash for empty values
    field.append(lbl, val);
    fields.appendChild(field);
  }

  addField('Confidence', data.confidence != null ? data.confidence.toFixed(3) : '—');
  addField('Decay class', data.decayClass || '—');
  addField('Source', data.source || '—', true);

  function fmtDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString(); } catch (_) { return iso; }
  }
  addField('Created', fmtDate(data.createdAt));
  addField('Last confirmed', fmtDate(data.lastConfirmedAt));

  body.appendChild(fields);

  // ── Properties table (omitted if empty) ───────────────────────────────
  var props = data.properties;
  if (props && typeof props === 'object') {
    var keys = Object.keys(props);
    if (keys.length > 0) {
      var propSection = document.createElement('div');
      propSection.className = 'drawer-field';

      var propLabel = document.createElement('div');
      propLabel.className = 'drawer-field-label';
      propLabel.textContent = 'Properties';
      propSection.appendChild(propLabel);

      var table = document.createElement('table');
      table.className = 'drawer-props-table';

      keys.forEach(function(key) {
        var tr = document.createElement('tr');
        var tdKey = document.createElement('td');
        tdKey.textContent = key;
        var tdVal = document.createElement('td');
        var raw = props[key];
        tdVal.textContent = (raw !== null && raw !== undefined)
          ? (typeof raw === 'object' ? JSON.stringify(raw) : String(raw))
          : '—';
        tr.append(tdKey, tdVal);
        table.appendChild(tr);
      });

      propSection.appendChild(table);
      body.appendChild(propSection);
    }
  }

  drawer.classList.add('open');
}
```

- [ ] **Step 7.4: Extend the node tap handler to open the drawer**

Find the `cy.on('tap', 'node', function(evt) {` handler. It currently only calls `expandNeighborhood(evt.target.id())`. Extend it to also open the drawer:

```javascript
cy.on('tap', 'node', function(evt) {
  expandNeighborhood(evt.target.id());
  openNodeDrawer(evt.target.data());
});
```

- [ ] **Step 7.5: Run the test suite**

```bash
npm --prefix /path/to/worktree test
```

Expected: all tests pass. (The JS changes are in the embedded HTML template, not in TypeScript, so the test suite won't catch UI bugs — that requires a manual smoke test in the browser.)

- [ ] **Step 7.6: Commit**

```bash
git -C /path/to/worktree add src/channels/http/routes/kg.ts
git -C /path/to/worktree commit -m "feat: add node detail drawer and sensitivity color toggle to KG explorer (#200)"
```

---

## Task 8: Manual smoke test

Before writing the changelog, verify the features work in the browser.

- [ ] **Step 8.1: Start the app**

```bash
npm --prefix /path/to/worktree run dev
```

Open the KG explorer (typically `http://localhost:PORT/kg`).

- [ ] **Step 8.2: Verify the color toggle**

1. Confirm the `Color by: [Type] [Sensitivity]` button group appears above the graph.
2. Click **Sensitivity** — all nodes should change colour. Nodes with `sensitivity = 'internal'` become blue (#4174C8), which is the same as the default, so the graph may look similar if all nodes are `internal` (expected — the migration defaulted everything to `internal`).
3. Click **Type** — nodes should revert to their type-based colours.

- [ ] **Step 8.3: Verify the detail drawer**

1. Tap any node in the graph.
2. Confirm the detail drawer slides in on the right and the canvas shrinks.
3. Verify all fields show correct values: label, type badge (correct colour), sensitivity badge, confidence, decay class, source, dates.
4. If the node has properties, verify the key–value table renders.
5. Click the × to close — drawer should hide and canvas should expand back.
6. Tap a second node while the drawer is open — content should update in place without closing.

---

## Task 9: CHANGELOG and version bump

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 9.1: Add CHANGELOG entry**

Open `CHANGELOG.md`. Under `## [Unreleased]`, add to the `### Added` section:

```markdown
- **KG explorer: sensitivity visualization** — node detail drawer shows all node attributes (label, type, sensitivity, confidence, decay class, source, timestamps, properties) when a node is tapped; color-by toggle lets the user switch node colour encoding between Type and Sensitivity (#200)
- **KG API: `sensitivity` and `properties` fields** — `/api/kg/nodes` and `/api/kg/graph` now return both fields on every node response
```

- [ ] **Step 9.2: Bump the version**

Open `package.json`. Change the version from `0.20.0` to `0.20.1` (patch bump — completing a partially-shipped spec per CLAUDE.md versioning rules).

- [ ] **Step 9.3: Commit**

```bash
git -C /path/to/worktree add CHANGELOG.md package.json
git -C /path/to/worktree commit -m "chore: changelog and version bump for KG sensitivity visualization (0.20.1) (#200)"
```

---

## Task 10: Open PR

- [ ] **Step 10.1: Run full test suite one final time**

```bash
npm --prefix /path/to/worktree test
```

Expected: all tests pass.

- [ ] **Step 10.2: Create PR**

```bash
gh pr create \
  --title "feat: KG sensitivity visualization — detail drawer and color toggle (#200)" \
  --body "$(cat <<'EOF'
## Summary

- Exposes `sensitivity` and `properties` from `/api/kg/nodes` and `/api/kg/graph` (both were in the DB but not returned by the API)
- Adds a right-side detail drawer to the KG explorer that shows all node attributes when a node is tapped (label, type, sensitivity, confidence, decay class, source, timestamps, properties)
- Adds a `Color by: Type | Sensitivity` toggle above the graph canvas that hot-swaps Cytoscape node colour rules
- Adds unit tests for `SensitivityClassifier` keyword classification and KG node sensitivity defaults (closes the two unchecked ACs from #200)

## Test plan

- [ ] Run `npm test` — all tests pass
- [ ] Open KG explorer, verify color toggle switches node colours between type-based and sensitivity-based palettes
- [ ] Tap a node, verify detail drawer opens with all fields populated correctly
- [ ] Tap a second node while drawer is open — content updates in place
- [ ] Click × — drawer closes, canvas expands
EOF
)"
```

- [ ] **Step 10.3: Confirm CI started**

```bash
gh run list --branch feat/kg-sensitivity-visualization --limit 1
```

Expected: one run in `queued` or `in_progress` state.
