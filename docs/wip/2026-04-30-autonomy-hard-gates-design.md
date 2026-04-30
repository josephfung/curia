# Autonomy Engine Phase 2 — Hard Gates and action_risk Enforcement

**Issue:** #147
**Status:** Design
**Date:** 2026-04-30

---

## Overview

Phase 1 established the global autonomy score, CEO controls (`get-autonomy` / `set-autonomy`), and system prompt injection. Phase 2 wires hard enforcement gates so the score is not advisory-only. Three gate layers enforce action_risk thresholds at the execution layer and outbound gateway.

The gates are a safety net behind the system prompt. The coordinator already self-governs based on its autonomy band description. These gates catch the case where the LLM fails to self-govern and tries to invoke a skill or send a message it shouldn't at the current score.

## Design Decisions

### Score reading strategy: per-invocation self-read

Each class (ExecutionLayer, OutboundGateway) reads the autonomy score via `AutonomyService.getConfig()` on each call. One single-row PG read per invocation. This avoids coordination between callers, keeps each gate self-contained, and ensures the live score is always used (important if the CEO adjusts autonomy mid-session).

### Fail-open when autonomy service is unavailable

If `AutonomyService` is not wired or `getConfig()` returns `null` (pre-migration), all gates are skipped with a `warn` log. Rationale: autonomy gating is a behavioral guardrail, not a hard security boundary (that role belongs to `sensitivity: elevated`). A DB hiccup silencing the assistant is worse than a momentarily ungated skill call.

### Drafts are not gated

The score < 70 gate applies to `OutboundGateway.send()` only, not `createEmailDraft()`. Drafts are the intended fallback at lower autonomy levels. Gating draft creation would defeat the purpose of the draft-only band.

---

## Changes

### 1. SkillRegistry: make `action_risk` required at runtime

`SkillRegistry.register()` currently wraps its `action_risk` validation in `if (manifest.action_risk !== undefined)`. Change to: reject with an explicit startup error when the field is missing.

The TypeScript type (`SkillManifest.action_risk: ActionRisk`) already declares it required. This change makes the runtime match the type system. All 61 existing local skills and all MCP skills (which inherit `action_risk` from `config/skills.yaml`) already have the field. No skills need patching.

### 2. Execution layer gates

Two gate checks added to `ExecutionLayer.invoke()`, immediately after the existing `sensitivity: elevated` gate and before context construction. The autonomy score is read once per `invoke()` call via `this.autonomyService.getConfig()`.

**Gate order within `invoke()`:**
1. Timestamp normalisation (existing)
2. Elevated-skill gate (existing)
3. **Full restriction gate (new)** — score < 60
4. **Per-skill action_risk gate (new)** — score < threshold
5. Context construction (existing)
6. Handler invocation (existing)

#### Gate A: Full restriction (score < 60)

If the live score is below 60 and `manifest.action_risk !== 'none'`, return `{ success: false, error: "..." }` with an advisory. `action_risk: 'none'` skills (reads, retrieval, summarisation) are always exempt.

This gate fires first because it is the most restrictive. If the agent is in restricted mode, there is no point evaluating per-skill thresholds.

#### Gate B: Per-skill action_risk threshold

Call `AutonomyService.minScoreForActionRisk(manifest.action_risk)` and compare against the live score. If the score is below the threshold, return `{ success: false, error: "..." }` with an advisory that names the current score and what is required (e.g. "current score is 65, skill requires 70").

Note: Gate A is technically a subset of Gate B (since `minScoreForActionRisk('low')` returns 60). Gate A is kept as a separate explicit check because it enforces a blanket policy with a distinct semantic ("all non-read skills blocked") that is clearer in code, audit events, and advisory messages than letting it fall through to the per-skill check.

#### Fail-open

If `this.autonomyService` is undefined or `getConfig()` returns `null`, both gates are skipped. A `warn` log is emitted. The skill proceeds as it does today.

#### Audit event

Both gates emit `autonomy.skill_blocked` on the bus (fire-and-forget on the `execution` layer, same pattern as `secret.accessed`).

### 3. OutboundGateway gate (score < 70)

`OutboundGateway` receives `autonomyService?: AutonomyService` via `OutboundGatewayConfig`. The gate is added to the top of `send()`, before the blocked-contact check.

If `autonomy_config.score < 70`: emit `autonomy.send_blocked` on the bus, return `{ success: false, blockedReason: "..." }`.

**Why before the blocked-contact check:** The autonomy gate is a broader policy question ("should the agent be sending anything independently?"). Failing fast avoids an unnecessary DB read for a send that will be blocked anyway.

Applies to `send()` only. `createEmailDraft()` is unaffected.

Same fail-open rule: if `autonomyService` is absent or `getConfig()` returns `null`, the gate is skipped with a `warn` log.

### 4. Bus events

Two new event types in `src/bus/events.ts`:

#### `autonomy.skill_blocked`

Published from the execution layer on the `execution` bus layer.

```
{
  type: 'autonomy.skill_blocked'
  skillName: string
  actionRisk: ActionRisk
  currentScore: number
  requiredScore: number
  agentId?: string
  taskEventId?: string
}
```

#### `autonomy.send_blocked`

Published from the outbound gateway on the `dispatch` bus layer.

```
{
  type: 'autonomy.send_blocked'
  channel: string            // 'email' | 'signal' | etc.
  currentScore: number
  requiredScore: number      // always 70 for now
  agentId?: string
  taskEventId?: string
}
```

### 5. Bus permissions (`src/bus/permissions.ts`)

New events must be registered in the publish/subscribe allowlists:

- `autonomy.skill_blocked`: publish from `execution` layer
- `autonomy.send_blocked`: publish from `dispatch` layer
- Both: publish and subscribe from `system` layer (audit logger)

### 6. Wiring (index.ts)

`OutboundGateway` constructor receives `autonomyService` from the same instance already created for the execution layer. One constructor argument added.

---

## Testing

### `src/skills/registry.test.ts`

- `register()` throws when `action_risk` is missing
- `register()` accepts all valid named labels and integers 0-100
- Existing invalid-value tests continue to pass

### `src/skills/execution.test.ts`

- Score below `action_risk` threshold: returns `{ success: false }` with advisory, `autonomy.skill_blocked` event emitted
- Score at or above threshold: skill proceeds normally
- `action_risk: 'none'`: always proceeds regardless of score
- Score < 60: non-`none` skill blocked, `none` skill proceeds
- `autonomyService` not wired: gate skipped, skill proceeds (fail-open)
- `getConfig()` returns `null` (pre-migration): gate skipped, skill proceeds

### `src/skills/outbound-gateway.test.ts`

- Score < 70: `send()` returns `{ success: false }`, `autonomy.send_blocked` emitted
- Score >= 70: send proceeds to existing pipeline
- `autonomyService` not wired: gate skipped
- `createEmailDraft()` unaffected by score gate (explicit test)

---

## Documentation Updates

The following files already document `action_risk` as required or future-required. Update their language from "Phase 2 will reject" / "future" to present tense ("rejects at startup") as part of the implementation PR:

1. **`docs/dev/adding-a-skill.md`** — primary skill creation guide; sections: "The Manifest", "`action_risk` (required)", "Picking the Right `action_risk`", and the PR checklist
2. **`docs/specs/03-skills-and-execution.md`** — architecture spec, skill manifest section
3. **`docs/specs/14-autonomy-engine.md`** — autonomy spec, "Skill `action_risk` Declaration" section; update Phase 2 status from "future" to "implemented"
4. **`CLAUDE.md`** — "Autonomy Awareness" section under "Adding Things > New Skill"
5. **`CONTRIBUTING.md`** — "Adding a New Skill" section

These are minor wording changes (tense updates, status labels), not structural doc rewrites.

---

## Out of Scope

- **Inline CEO approval (Issue #147, Item 5):** A mechanism for the CEO to approve a specific pending action without changing the global score. Deferred to a follow-on issue.
- **Automatic score adjustment (Issue #148, Phase 3):** Self-adjusting score based on an action log. Separate issue.
