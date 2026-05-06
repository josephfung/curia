# Coordinator Memory Workflow Design

**Date:** 2026-05-06
**Branch:** feat/memory-workflow
**Related issue:** josephfung/curia#467 (non-contact entity creation — out of scope here)

## Problem

The coordinator has `memory-store` and `memory-query` pinned but no instructions on
how or when to use them. Two failure modes are confirmed in v0.25.0 testing:

1. **Silent store failure.** When the CEO says "remember that my favourite book is
   Les Misérables", the agent calls `memory-store` with an entity name (e.g. "Joseph")
   that doesn't exist in the KG. `findNodesByLabel` does case-insensitive exact match
   and finds nothing. The handler returns `{ success: true, data: { stored: false,
   action: 'rejected' } }`. Seeing `success: true`, the agent tells the CEO "Got it —
   on file permanently." Nothing was written.

2. **No proactive recall.** In a subsequent session the CEO asks "what's my favourite
   book?" The agent answers from training knowledge rather than querying stored memory,
   or calls `memory-query` but finds nothing (because the store failed silently).

A secondary code issue compounds the first: `action: 'rejected'` conflates two unrelated
outcomes — rate limit exceeded and entity not found — making it impossible for the agent
to respond appropriately to each.

A third issue, discovered during design: `memory-store` and `extract-facts` both resolve
entities via `findNodesByLabel` but duplicate the logic independently, and `memory-store`
fails hard on not-found while `extract-facts` creates the entity automatically. This
divergence makes `memory-store` fragile and harder to maintain.

## Scope

**In scope:**
- `## Memory` section added to `agents/coordinator.yaml`
- `EntityMemory.resolveOrCreate()` — shared method extracted from `extract-facts`,
  used by both `extract-facts` and `memory-store`
- `action: 'rejected'` split into `action: 'entity_not_found'` and `action: 'rate_limited'`
  in handler, validator, types, and manifest

**Out of scope (tracked in #467):**
- Semantic search / fuzzy matching within `resolveOrCreate` for near-name variants
- Disambiguation or creation for non-contact entities (organizations, venues, concepts)

---

## Design

### 1. `EntityMemory.resolveOrCreate()`

A new method on `EntityMemory` that encapsulates the find-or-create pattern that
`extract-facts` currently implements inline. Both `extract-facts` and `memory-store`
will call this instead of duplicating the logic.

```typescript
interface ResolveOrCreateOptions {
  label: string;
  type: NodeType;
  source: string;
  confidence?: number; // defaults to 0.6, matching extract-facts behaviour
}

type ResolveOrCreateResult =
  | { kind: 'found' | 'created'; node: KgNode }
  | { kind: 'ambiguous'; candidates: KgNode[] };
```

**Resolution logic (in order):**

1. Call `findNodesByLabel(label)` — case-insensitive exact match, all node types.
2. **0 matches** → create via `createEntity(...)`, return `{ kind: 'created', node }`.
3. **1 match** → return `{ kind: 'found', node }`.
4. **2+ matches, one has the expected `type`** → return `{ kind: 'found', node: typeMatch }`.
5. **2+ matches, no type match** → return `{ kind: 'ambiguous', candidates }`.

**How callers handle `ambiguous`:**

- `extract-facts` — takes `candidates[0]` (existing behaviour: accepts any match rather
  than stalling a background batch job).
- `memory-store` — returns the candidates to the agent so it can ask the CEO to
  disambiguate. Never silently picks one for an agent-directed write.

**File:** `src/memory/entity-memory.ts`

---

### 2. `memory-store` Handler

Replace the current `resolveEntity` local function with a call to
`entityMemory.resolveOrCreate()`.

**Before:** `resolveEntity` calls `findEntities` + `getEntity` (UUID fallback). Returns
`not_found` if both miss. Handler returns `entity_not_found`. Nothing is created.

**After:** calls `entityMemory.resolveOrCreate()`. If the entity doesn't exist, it is
created automatically (type inferred from context or defaulting to `'concept'`; caller
can pass `entity_type` input to override). If ambiguous, candidates are returned and
the agent asks the CEO to choose.

This means the coordinator prompt no longer needs to orchestrate contact-lookup →
contact-create → memory-store as a multi-step sequence for unknown entities. Passing
a plain name to `memory-store` now reliably finds or creates the entity. Contact-lookup
is still recommended when the entity is a known contact (ensures the KG node matches
the contact system's `kg_node_id`), but is no longer required for correctness.

**New optional input added to the skill manifest:**

```json
"entity_type": "string? (optional node type hint for auto-creation if the entity does
  not exist yet — one of: person, organization, project, decision, event, concept.
  Defaults to 'concept'. Has no effect if the entity already exists.)"
```

**File:** `skills/memory-store/handler.ts`, `skills/memory-store/skill.json`

---

### 3. `action` Code Split

Both "rate limit exceeded" and "entity not found" currently produce the same output:
```json
{ "success": true, "data": { "stored": false, "action": "rejected", "reason": "..." } }
```

After this change, the agent sees distinct, actionable codes:

| Situation | `action` |
|---|---|
| Entity label/ID not found (pre-`resolveOrCreate`, e.g. UUID lookup miss) | `entity_not_found` |
| Entity node gone at write time (validator race guard) | `entity_not_found` |
| Rate limit exceeded (validator) | `rate_limited` |

`success: true` is preserved for both — these are expected business outcomes, not
infrastructure failures.

Note: with `resolveOrCreate` in place, `entity_not_found` at the handler level becomes
a much rarer path (only hit when the caller passes a UUID that no longer exists). The
validator-level `entity_not_found` remains a valid race-condition guard.

**Files:** `src/memory/types.ts`, `src/memory/validation.ts`,
`skills/memory-store/handler.ts`, `skills/memory-store/skill.json`

---

### 4. `extract-facts` Refactor

Replace the inline find-or-create logic with a call to `entityMemory.resolveOrCreate()`.
No behaviour change — the `ambiguous` case maps to `candidates[0]`, preserving the
existing "accept any type match, else first candidate" logic.

This is the mechanical change that actually links the code rather than duplicating it.

**File:** `skills/extract-facts/handler.ts`

---

### 5. Coordinator `## Memory` Section

The new section covers three areas: storing, proactive recall, and entity resolution.

#### 5a. Storing facts

Trigger: CEO explicitly asks to remember something ("remember that…", "note that…",
"keep in mind that…", "make a note that…").

Workflow:
1. Identify the subject entity (who or what the fact is about).
2. If the entity is a **known contact**, call `contact-lookup` first to get their
   `kg_node_id` and pass it as `entity` — this ensures the stored fact is anchored to
   the same node the contact system uses, keeping entity context enrichment coherent.
   - **0 matches** — call `contact-create` (name only), use the returned `kg_node_id`.
   - **1 match** — use `kg_node_id` directly.
   - **2+ matches** — ask the CEO to disambiguate. Do not guess.
3. If the entity is **not a contact** (a business, venue, concept, etc.), pass the name
   directly as `entity` — `memory-store` will find or create the KG node automatically.
   Note: non-contact entity support is limited (see issue #467).
4. Choose `decay_class`:
   - `permanent` — deeply stable facts (birthday, legal name)
   - `slow_decay` — preferences and standing facts that change occasionally (default)
   - `fast_decay` — current-situation facts (active project, this week's priority)
5. Handle outcomes:
   - `stored: true` — confirm naturally ("Got it, I have that on file.")
   - `ambiguous` — candidates returned; ask CEO to clarify which entity they meant.
   - `conflict` — surface the contradiction: "I already have [field] as [existing value]
     — which is correct?"
   - `rate_limited` — inform the CEO that the write limit was reached for this task.
   - `entity_not_found` — entity UUID no longer exists; retry with the entity name
     directly.

#### 5b. Proactive recall

Memory should inform any task that involves a known person or entity — not only when
the CEO asks explicitly.

- **Explicit recall** — "what's my preferred airline?", "what did I tell you about
  Xiaopu?", "what do you have on file about the Darlise meeting?" → always call
  `memory-query` before answering.
- **Task enrichment** — drafting an email, scheduling a meeting, preparing a briefing,
  booking travel → call `memory-query` for the relevant people and entity, and let any
  stored context shape the output (communication preferences, relationship notes,
  standing instructions, dietary restrictions, etc.).
- **Preference-sensitive decisions** — any task where a stored preference would change
  the output (tone, format, channel, logistics choices) → check memory first.

Query discipline: use descriptive natural-language queries that capture intent
("preferred communication style for Xiaopu", "standing travel preferences"), not bare
names. The search is semantic — specificity improves precision.

Surface stored context silently in the output. Do not announce "I checked my memory"
unless the CEO asks how you knew something. If no results, answer from other available
context; never fabricate a stored preference.

#### 5c. Entity resolution quick reference

| Who | How |
|---|---|
| "me / my / I" (CEO) | `contact-lookup` by CEO name from sender context → `kg_node_id` |
| Named person in contacts | `contact-lookup` by name → `kg_node_id`; disambiguate if 2+ |
| Named person not in contacts | `contact-create` name only → `kg_node_id` |
| Non-person entity (org, venue, concept) | Pass name directly to `memory-store`; skill auto-creates |

---

## Testing

### `EntityMemory.resolveOrCreate` (unit)

- 0 KG matches → entity created, `kind: 'created'`
- 1 KG match → entity returned, `kind: 'found'`
- 2+ matches, one has the right type → that node returned, `kind: 'found'`
- 2+ matches, no type match → `kind: 'ambiguous'` with all candidates

### `memory-store` handler (unit)

- Entity name resolves to existing node → fact stored, `stored: true`
- Entity name not found → auto-created, fact stored, `stored: true`
- Entity name ambiguous → `ambiguous: true` with candidates, nothing written
- Rate limit exceeded → `action: 'rate_limited'`
- UUID entity param that no longer exists (validator race) → `action: 'entity_not_found'`
- Existing tests continue to pass (`conflict`, `created`, `updated`)

### `extract-facts` (unit)

- Existing tests pass without behaviour change

### Coordinator prompt (manual / integration)

- Store a fact about the CEO → appears in `memory-query` in a new session
- Store a fact about a named third party → appears in `memory-query` in a new session
- Store when 2+ contacts share a name → agent disambiguates, does not write
- Ask a preference question in a new session → agent calls `memory-query` before answering
- Draft an email to someone with stored preferences → stored context surfaces in draft
