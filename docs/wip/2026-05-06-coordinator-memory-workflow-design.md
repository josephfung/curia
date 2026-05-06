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

A secondary code issue compounds the first: the handler's `action: 'rejected'` conflates
two unrelated outcomes — rate limit exceeded and entity not found — making it impossible
for the agent to act appropriately on each.

## Scope

**In scope:**
- `## Memory` section added to `agents/coordinator.yaml`
- `action: 'rejected'` split into `action: 'entity_not_found'` and `action: 'rate_limited'`
  in handler, validator, types, and manifest

**Out of scope (tracked in #467):**
- Entity creation for non-contact entities (organizations, venues, concepts)
- Semantic search fallback in `resolveEntity` for fuzzy name matching

---

## Design

### 1. Coordinator Memory Section

The `## Memory` section covers three areas: storing facts, proactive recall, and
entity resolution. It sits alongside other workflow sections (Email, Calendar, etc.)
in `coordinator.yaml`.

#### 1a. Storing facts

Trigger: the CEO explicitly asks to remember something ("remember that…", "note that…",
"keep in mind that…").

Workflow:
1. Identify the subject entity (who or what the fact is about).
2. Resolve the entity to a `kg_node_id` via contact-lookup:
   - **0 matches** — create a minimal contact with `contact-create` (name only), use
     the returned `kg_node_id`.
   - **1 match** — use its `kg_node_id` directly.
   - **2+ matches** — ask the CEO to disambiguate before storing anything. Do not guess.
3. Call `memory-store` with `entity=kg_node_id`, appropriate `field`, `value`, and
   `decay_class`:
   - `permanent` — deeply stable facts unlikely to ever change (birthday, legal name)
   - `slow_decay` — preferences and standing facts that change occasionally (default)
   - `fast_decay` — current-situation facts that change frequently (active project,
     this week's priority)
4. Handle outcomes:
   - `stored: true` — confirm naturally ("Got it, I have that on file.")
   - `entity_not_found` — this shouldn't happen after step 2; if it does, retry
     contact-lookup and report if still unresolved.
   - `rate_limited` — inform the CEO that the write limit was reached for this task.
   - `conflict` — surface the contradiction: "I already have [field] as [existing value]
     — which is correct?"
   - `ambiguous` — ask to disambiguate (same as 2+ contact matches above).

Note: `memory-store` only works for entities that exist in the contact system. For
facts about businesses, venues, or other non-person entities, see issue #467.

#### 1b. Proactive recall

Memory is not consulted only when the CEO asks directly about stored facts. It should
inform any task that involves a known person or entity:

- **Explicit recall** — "what's my preferred airline?", "what did I tell you about
  Xiaopu?" → always call `memory-query` before answering.
- **Task enrichment** — drafting an email to someone, scheduling a meeting, preparing
  a briefing → call `memory-query` for the relevant people and surface any stored
  context that affects the task (communication preferences, relationship notes, standing
  instructions).
- **Preference-sensitive decisions** — any task where a stored preference would change
  the output (formatting, channel choice, tone, logistics) → check memory first.

Query discipline: use descriptive natural-language queries that capture the intent
("preferred communication style for Xiaopu", "standing travel preferences"), not
just bare names. The search is semantic — specificity improves recall precision.

If `memory-query` returns results, use them silently to inform the response. Do not
announce "I checked my memory" unless the CEO asks how you knew something. If no
results, answer from other available context and do not fabricate stored preferences.

#### 1c. Entity resolution summary

| Entity | How to resolve |
|---|---|
| "me / my / I" (CEO) | `contact-lookup` by CEO's name from sender context |
| Named person | `contact-lookup` by name; disambiguate if 2+ results |
| Not in contacts (0 results) | `contact-create` with name only, then use `kg_node_id` |
| Non-person entity (org, venue) | Out of scope — see issue #467 |

---

### 2. `memory-store` Output Split

#### Current behaviour

Both "rate limit exceeded" and "entity not found" produce the same output:
```json
{ "success": true, "data": { "stored": false, "action": "rejected", "reason": "..." } }
```

This forces the agent to parse the `reason` string to decide what to do — fragile and
easy to miss.

#### New behaviour

| Situation | `action` value |
|---|---|
| Entity label/ID not found (handler-level `resolveEntity`) | `entity_not_found` |
| Entity node gone at write time (validator-level race guard) | `entity_not_found` |
| Rate limit exceeded | `rate_limited` |

`success: true` is preserved for both — these are expected business outcomes, not
infrastructure failures. `success: false` remains reserved for unexpected exceptions.

#### Files changed

| File | Change |
|---|---|
| `src/memory/types.ts` | Add `entity_not_found` and `rate_limited` to `ValidationResult` union; deprecate bare `rejected` |
| `src/memory/validation.ts` | Emit `entity_not_found` (entity gone at write time) vs `rate_limited` (rate limit) |
| `skills/memory-store/handler.ts` | Emit `entity_not_found` from `resolveEntity` not-found path; map validator results to new action names |
| `skills/memory-store/skill.json` | Update `outputs.action` documentation to list all valid values |

---

## Testing

### Coordinator prompt (manual / integration)

- Store a fact about the CEO → fact appears in a subsequent `memory-query`
- Store a fact about a named third party → fact appears in a subsequent `memory-query`
- Store when 2+ contacts share a name → agent asks to disambiguate, does not write
- Store when entity not in contacts → agent creates contact, then stores
- Ask a preference question in a new session → agent calls `memory-query` before answering
- Draft an email to someone with stored preferences → stored context surfaces in draft

### `memory-store` output split (unit)

- `resolveEntity` not-found → `action: 'entity_not_found'` in response
- Rate limit exceeded → `action: 'rate_limited'` in response
- Validator entity-gone race → `action: 'entity_not_found'` in response
- Existing tests continue to pass (no regression on `conflict`, `ambiguous`, `created`, `updated`)
