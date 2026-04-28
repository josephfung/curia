# Executive Profile Skills — Design

**Date:** 2026-04-27
**Status:** Draft

## Overview

Two skills that let the coordinator read and update the executive writing
voice profile at runtime. Enables conversational profile setup ("read my
last month of emails and extract my voice patterns") and iterative
refinement ("make it less formal") without editing YAML or redeploying.

## Skills

### `executive-profile-get`

Returns the current structured profile as JSON.

| Field | Value |
|-------|-------|
| `action_risk` | `"none"` |
| `sensitivity` | `"normal"` |
| `infrastructure` | `true` |
| `inputs` | `{}` (none) |
| `outputs` | `{ profile, summary }` |

The `summary` field is a human-readable rendering of the profile for
display in conversation. The `profile` field is the raw structured data.

### `executive-profile-update`

Accepts a partial update — only the fields being changed — merged onto
the current profile before validation and persistence.

| Field | Value |
|-------|-------|
| `action_risk` | `"medium"` |
| `sensitivity` | `"elevated"` (CEO-only) |
| `infrastructure` | `true` |
| `inputs` | `{ writing_voice }` — partial WritingVoice fields |
| `outputs` | `{ profile, summary, changes }` |

Partial input example — only changes formality:
```json
{ "writing_voice": { "formality": 30 } }
```

The handler reads the current profile via `service.get()`, deep-merges
the incoming fields, validates the merged result, and calls
`service.update()`. The `changes` field in the output is a human-readable
diff summary.

## Service Injection

Follows the name-scoped injection pattern established by `autonomyService`:

1. Add `executiveProfileService?` to `SkillContext` (types.ts)
2. Add to `ExecutionLayer` constructor options and store as private field
3. Inject only for skills named `executive-profile-get` or
   `executive-profile-update` (same gating pattern as autonomy skills)
4. Pass the service from `index.ts` into the `ExecutionLayer` constructor

## Coordinator Integration

Both skills are added to the coordinator's `pinned_skills` list so
they're always available as tools without discovery.

## Files

| Path | Change |
|------|--------|
| `skills/executive-profile-get/skill.json` | New — manifest |
| `skills/executive-profile-get/handler.ts` | New — read handler |
| `skills/executive-profile-update/skill.json` | New — manifest |
| `skills/executive-profile-update/handler.ts` | New — write handler |
| `src/skills/types.ts` | Add `executiveProfileService?` to `SkillContext` |
| `src/skills/execution.ts` | Add service to constructor + name-scoped injection |
| `src/index.ts` | Pass service into `ExecutionLayer` |
| `agents/coordinator.yaml` | Add both skills to `pinned_skills` |
| `tests/unit/skills/executive-profile-get.test.ts` | New — unit tests |
| `tests/unit/skills/executive-profile-update.test.ts` | New — unit tests |
