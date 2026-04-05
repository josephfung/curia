# Design: Relationship Edge Extraction & Entity Linking

**Date:** 2026-04-05
**Issue:** josephfung/curia#128
**Status:** Approved

---

## Background

The `kg_nodes` and `kg_edges` tables exist and the persistence layer (`KnowledgeGraphStore.createEdge`, `EntityMemory.link`) is implemented and tested. The entity-context enrichment pipeline (spec 11 / `EntityContextAssembler`) already reads first-degree edges to assemble context for the coordinator — but with zero edges in the database, that assembly is always empty.

No production code path creates edges between entity nodes. Every relationship mentioned in conversation ("Xiaopu Fung is my wife", "Ada is the lead on Project Orion") is silently lost.

---

## Scope

This spec covers:

1. Extended edge type vocabulary in `EDGE_TYPES`
2. The `extract-relationships` skill (self-classifying, idempotent)
3. Coordinator integration (unconditional invocation)
4. Unit and integration tests

**Out of scope:**
- Automatic fact extraction (attributes of a single entity — see josephfung/curia#151)
- Edge decay / expiry (memory decay engine — issue #27)
- Bulk import of relationships from external sources
- UI for manually editing edges

---

## Section 1 — Edge Type Vocabulary

Add 12 new types to `EDGE_TYPES` in `src/memory/types.ts`:

**Personal relationships:**
- `spouse`
- `parent`
- `child`
- `sibling`

**Professional relationships:**
- `reports_to`
- `manages`
- `collaborates_with`
- `advises`
- `represents`

**Organisational membership:**
- `member_of`
- `founded`
- `invested_in`

The 7 existing types (`works_on`, `decided`, `attended`, `relates_to`, `belongs_to`, `authored`, `mentioned_in`) remain unchanged. `relates_to` is the generic fallback used when no specific type fits.

**No edge type is exclusive.** A person can have multiple `spouse` edges (ex-spouses, polyamorous situations) and multiple `reports_to` edges (multiple jobs). There are no cardinality constraints — this simplifies the model and avoids false conflicts.

---

## Section 2 — The `extract-relationships` Skill

### Location

```
skills/extract-relationships/
  skill.json
  handler.ts
  handler.test.ts
```

### Manifest (`skill.json`)

```json
{
  "name": "extract-relationships",
  "description": "Extract entity-to-entity relationships from a passage of text and persist them as knowledge graph edges. Self-classifies internally — always safe to call; exits early if no relationships are found.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "action_risk": "low",
  "infrastructure": true,
  "inputs": {
    "text": "string (the message or turn text to extract relationships from)",
    "source": "string (provenance string, e.g. 'agent:coordinator/task:abc123/channel:cli')"
  },
  "outputs": {
    "extracted": "number (new edges created)",
    "confirmed": "number (existing edges re-asserted and updated)",
    "skipped": "boolean (true if the classifier gate determined no relationships were present)"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 15000
}
```

### Internal Flow

#### Step 1 — Classifier gate

A cheap haiku call with a binary prompt:

> "Does the following text assert a relationship or connection between two or more people or organisations? Answer only 'yes' or 'no'.\n\n{text}"

If the answer is `no`, return immediately:
```json
{ "extracted": 0, "confirmed": 0, "skipped": true }
```

This gate keeps the skill cost-neutral on the vast majority of coordinator turns (scheduling, email, etc.).

#### Step 2 — Extraction prompt

A sonnet call with the full `EDGE_TYPES` vocabulary in the prompt. The prompt instructs the model to return a JSON array of triples:

```typescript
interface ExtractedTriple {
  subject: string;           // name or label of the source entity
  subjectType: NodeType;     // 'person', 'organization', 'project', etc.
  predicate: EdgeType;       // from EDGE_TYPES; use 'relates_to' if no specific type fits
  object: string;            // name or label of the target entity
  objectType: NodeType;      // 'person', 'organization', 'project', etc.
  confidence: number;        // 0–1, how confident the model is in this extraction
}
```

The prompt explicitly instructs the model to **ignore facts** (attributes of a single entity, e.g. "Joseph lives in Toronto" — those are for a future `extract-facts` skill).

#### Step 3 — Node resolution

For each triple's `subject` and `object`:

1. Call `store.findNodesByLabel(name)` (case-insensitive)
2. If found: use the existing node ID
3. If not found: call `entityMemory.createEntity()` with:
   - `type`: taken directly from `subjectType` / `objectType` in the extracted triple (the LLM provides this)
   - `confidence: 0.6` (lower than a manually confirmed entity)
   - `decayClass: 'slow_decay'`
   - `source`: the skill's `source` input

#### Step 4 — Idempotency check + edge upsert

For each resolved triple:

1. Query `kg_edges` for an existing edge matching `type` where either:
   - `source_node_id = A AND target_node_id = B`, OR
   - `source_node_id = B AND target_node_id = A`

   Checking both directions prevents bidirectional duplicates (e.g. extracting "Joseph and Xiaopu are married" twice from different phrasings doesn't create two `spouse` edges).

2. If found: `UPDATE kg_edges SET last_confirmed_at = now(), confidence = $newConfidence WHERE id = $edgeId` — count as `confirmed`
3. If not found: call `EntityMemory.link()` to insert the new edge — count as `extracted`

The updated confidence on confirmation is `max(existing_confidence, extracted_confidence)` — re-assertion can only raise confidence, never lower it.

---

## Section 3 — Coordinator Integration

### System prompt addition

Add a new block to `agents/coordinator.yaml` after the "Contact Awareness" section:

```
## Relationship Extraction
After every message, call `extract-relationships` with the full message text and
your current task source string. You do not need to decide whether the message
contains relationships — the skill handles that internally and exits immediately
if there is nothing to extract. Always call it; never skip it.
```

**Rationale for "always call it":** Making extraction unconditional avoids silent misses and keeps the instruction simple. The haiku gate inside the skill keeps the cost to a single cheap API call on unrelated messages. This design is also easy to improve later — the haiku gate can be replaced by a local LLM without changing the coordinator or skill interface.

### Entity context — no changes needed

`EntityContextAssembler` already queries `kg_edges` for first-degree relationships. Once edges start being created, the coordinator will automatically receive richer entity context on subsequent turns. No wiring changes required.

---

## Section 4 — Testing

### Unit tests (`skills/extract-relationships/handler.test.ts`)

Uses the in-memory KG backend (no Postgres required).

| Test | Assertion |
|---|---|
| Classifier gate fires on unrelated text | Returns `{ skipped: true, extracted: 0, confirmed: 0 }` |
| Single relationship extracted | Edge persisted, `extracted: 1` |
| Idempotency — same triple twice | Second call: `confirmed: 1, extracted: 0`; `lastConfirmedAt` updated |
| Unknown subject/object creates new nodes | Two new `person` nodes created alongside the edge |
| Acceptance criterion | "Xiaopu Fung is Joseph's wife" → `spouse` edge between two person nodes |
| Generic fallback | Ambiguous relationship uses `relates_to` edge type |

### Integration test (`tests/integration/extract-relationships.test.ts`)

Uses real Postgres (Docker, same pattern as existing integration tests).

Full round-trip:
1. Call skill with "Xiaopu Fung is Joseph's wife"
2. Assert edge exists in `kg_edges` with type `spouse`
3. Call `entity-context` skill for Joseph's KG node ID
4. Assert the response includes Xiaopu as a relationship

This verifies the end-to-end acceptance criterion from josephfung/curia#128.

---

## Acceptance Criteria (from issue)

- [ ] `EDGE_TYPES` extended with personal, professional, and organisational relationship types
- [ ] `extract-relationships` skill: LLM-powered, takes text, returns typed triples, resolves to existing nodes (or creates new ones), calls `EntityMemory.link()`
- [ ] Skill is idempotent — duplicate triple confirms existing edge, does not insert
- [ ] Coordinator prompt updated to invoke extraction after every message
- [ ] Integration test: full round-trip — message in → edges in DB → entity context includes relationship on next turn
- [ ] "Xiaopu Fung is Joseph's wife" creates a `spouse` edge between their two person nodes
