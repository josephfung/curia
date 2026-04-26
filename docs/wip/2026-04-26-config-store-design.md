# Config Store — Design

**Date:** 2026-04-26
**Status:** Approved
**Repo:** `curia`
**Supersedes:** `knowledge-writing-config` (removed from PR #356 before merge)
**Deprecates (future):** `knowledge-company-overview`, `knowledge-meeting-links`, `knowledge-loyalty-programs`, `knowledge-travel-preferences` — tracked in #357

---

## Problem

Every agent workflow that needs persistent configuration has been getting its own
bespoke `knowledge-*` skill. Each one is near-identical boilerplate: find or create
a named anchor node, store facts against it, retrieve them. The only variation is the
anchor label and field names. This does not scale — a new agent means a new skill.

---

## Solution

A single generic `config-store` skill. Agents declare their namespace at authoring
time (baked into their system prompt); the skill writes to and reads from that
namespace in the KG. No new skill is needed when a new agent or workflow requires
persistent config.

The coordinator does not need to know about namespaces. Specialist agents own their
domain config entirely.

---

## Interface

### Inputs

| Field | Required | Description |
|---|---|---|
| `action` | always | `store \| retrieve \| list_namespaces` |
| `namespace` | store, retrieve | Logical grouping, e.g. `writing_config`, `travel`, `company` |
| `key` | store; optional on retrieve | Config key, e.g. `writing_guide_url`, `aeroplan_number` |
| `value` | store only | String value, max 2000 characters |

### Outputs

**`store`**
```json
{ "stored": true, "namespace": "writing_config", "key": "writing_guide_url" }
```

**`retrieve` with `key`**
```json
{ "found": true, "key": "writing_guide_url", "value": "https://..." }
// or:
{ "found": false, "key": "writing_guide_url" }
```

**`retrieve` without `key`** (all entries in namespace)
```json
{ "entries": [{ "key": "writing_guide_url", "value": "https://..." }, ...] }
// Empty namespace:
{ "entries": [], "message": "No config stored in namespace 'writing_config' yet." }
```

**`list_namespaces`**
```json
{ "namespaces": ["writing_config", "travel", "company"] }
// Nothing stored yet:
{ "namespaces": [] }
```

---

## KG Storage Model

### Per-namespace anchor nodes

Each namespace gets one anchor node:

```
type:    concept
label:   config:{namespace}          e.g. "config:writing_config"
properties: { category: "config", namespace: "{namespace}" }
source:  skill:config-store
```

Each key-value pair is stored as a fact on the anchor:

```
entityNodeId: <anchor id>
label:        {key}                  e.g. "writing_guide_url"
properties:   { key, value, namespace }
decayClass:   permanent              config values are stable by design
confidence:   1.0
source:       skill:config-store
```

`store` is idempotent: calling it with an existing key overwrites the previous value
(last write wins — no conflict detection needed for configuration).

### Meta-index node

A single meta-index node tracks which namespaces have been written to:

```
type:    concept
label:   config-store-index
properties: { category: "config-meta" }
```

Each namespace is stored as a fact on the index:

```
label:       {namespace}
properties:  { namespace }
decayClass:  permanent
```

Updated automatically on every new namespace's first `store` call. This makes
`list_namespaces` a single KG read rather than a label-scan across all entities.

---

## Error Handling

| Condition | Behaviour |
|---|---|
| Missing `action` or unrecognised value | `success: false`, validation error |
| `namespace` missing for store/retrieve | `success: false`, validation error |
| `key` missing for store | `success: false`, validation error |
| `value` missing for store | `success: false`, validation error |
| `namespace` > 100 chars | `success: false`, validation error |
| `key` > 200 chars | `success: false`, validation error |
| `value` > 2000 chars | `success: false`, validation error |
| Namespace not found on retrieve | `success: true`, empty entries (not an error) |
| Key not found on retrieve-single | `success: true`, `found: false` (not an error) |
| No namespaces on list_namespaces | `success: true`, `namespaces: []` (not an error) |
| `entityMemory` not available | `success: false`, hard error on all actions |
| KG write/read throws | `success: false`, error message with context |

---

## Migration

### `knowledge-writing-config` (not yet in production)
Remove from PR #356 before merge. Update `essay-editor.yaml` in `curia-deploy` to
use `config-store` with `namespace: writing_config`. No data migration needed —
the skill never shipped.

### Existing `knowledge-*` skills (in production)
Left in place for now. Tracked for deprecation in #357. When that work is done, the
coordinator's system prompt will be updated to use `config-store` with the appropriate
namespaces and the old skill directories deleted.

---

## Impact on Other Repos

**`curia-deploy` — `custom/agents/essay-editor.yaml`:**
- Remove `knowledge-writing-config` from `pinned_skills`
- Add `config-store`
- Step 1 updated to call `config-store { action: retrieve, namespace: writing_config }`
  instead of `knowledge-writing-config { action: retrieve }`

---

## Testing

Unit tests mock `entityMemory`. Coverage:

**Validation**
- Missing/invalid action → error
- Missing namespace on store/retrieve → error
- Missing key on store → error
- Missing value on store → error
- Namespace too long → error
- Key too long → error
- Value too long → error
- entityMemory unavailable → error on all actions

**store**
- Creates anchor node + registers namespace in meta-index on first write
- Reuses existing anchor on subsequent writes
- Overwrites existing key with new value (idempotent)
- Returns `{ stored: true, namespace, key }`

**retrieve (with key)**
- Returns `{ found: true, value }` when key exists
- Returns `{ found: false }` when key does not exist
- Returns empty entries when namespace does not exist

**retrieve (without key)**
- Returns all entries in namespace
- Returns empty entries with guidance message when namespace does not exist

**list_namespaces**
- Returns all registered namespace names
- Returns empty array when nothing stored yet

---

## Files

### `curia` — this PR

| File | Change |
|---|---|
| `skills/config-store/skill.json` | New — manifest |
| `skills/config-store/handler.ts` | New — handler |
| `skills/config-store/handler.test.ts` | New — unit tests |
| `agents/coordinator.yaml` | Add `config-store` to `pinned_skills` |
| `docs/specs/03-skills-and-execution.md` | Document `config-store`; remove `knowledge-writing-config` entry |
| `docs/dev/adding-an-agent.md` | Add `config-store` to the built-in skills table; add guidance section on using it for agent-level persistent config |
| `docs/dev/adding-a-skill.md` | Add a note in the skills guide: do not write a new `knowledge-*` skill for persistent config — use `config-store` instead |
| `CHANGELOG.md` | Add entry under `[Unreleased]` |
| `package.json` | Minor version bump (new skill) |

### `schemas/` — review only, no changes expected

The existing schemas already cover `config-store` without modification:
- `skill-manifest.schema.json` — `capabilities` accepts any string array; `entityMemory` is valid without a schema change. Valid capability names are enforced by the allowlist in `src/skills/loader.ts`, not the JSON schema.
- `agent-config.schema.json` — `pinned_skills` is an untyped string array; adding `config-store` requires no schema change.

If during implementation the loader's capability allowlist is found to be missing `entityMemory` (unlikely — it's used by all existing knowledge skills), add it there, not in the schema.

### `curia-deploy` — separate PR against curia-deploy#18

| File | Change |
|---|---|
| `custom/agents/essay-editor.yaml` | Replace `knowledge-writing-config` with `config-store` in `pinned_skills` and system prompt |

### `curia` PR #356 — cleanup before merge

| File | Change |
|---|---|
| `skills/knowledge-writing-config/` | Delete entire directory |
| `agents/coordinator.yaml` | Remove `knowledge-writing-config` from `pinned_skills` |
| `CHANGELOG.md` | Remove `knowledge-writing-config` bullet |
