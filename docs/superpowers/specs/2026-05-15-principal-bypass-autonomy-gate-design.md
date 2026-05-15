# Principal Bypass for Autonomy Gates A and B

**Date:** 2026-05-15
**Status:** Approved
**Discovered via:** approval request `39afde15` (2026-05-15)
**Branch:** fix/principal-bypass-autonomy-gate

---

## Problem

The autonomy gate in `src/skills/execution.ts` blocks skill invocations based solely on the
numeric autonomy score, with no consideration for who originated the task. When the CEO
directly instructs Curia to take an action (e.g. via email), the gate fires and generates an
approval request — requiring the CEO to approve their own explicit instruction. This is
friction without benefit.

The recent principal identity work (`2499a48`) added an `isPrincipalOriginated()` check to
the **elevated-skill gate** (for `sensitivity: 'elevated'` skills), but did not extend the
same bypass to the **autonomy score gates** (Gate A and Gate B). This was an oversight.

**Root cause confirmed from production:**
- Autonomy score: 74 | `calendar-create-event` requires 80 (`action_risk: 'high'`)
- Task `1f101d86` was principal-originated (CEO email) → Gate B fired → approval request `39afde15` sent

---

## Design

### Scope

Single file edit: `src/skills/execution.ts`. No schema changes, no new types, no new files.

`isPrincipalOriginated` is already imported at line 24. No new imports needed.

### Change

Within the autonomy gate block (currently lines 336–412), after reading `autonomyConfig` and
confirming it is non-null, add a principal-originated check **before** Gate A and Gate B. If
the check passes, log at `info` level and fall through to skill execution. Otherwise, proceed
to the existing gate logic unchanged.

```ts
// Principal bypass — if the task was originated by the principal (CEO), skip gates A and B.
// The autonomy gate governs *autonomous* behavior; a direct CEO instruction overrides it by intent.
// Log at info level so bypasses are visible in production logs.
if (isPrincipalOriginated(options?.taskMetadata)) {
  skillLogger.info(
    { skillName, currentScore },
    'autonomy gate: skipped — task originated by principal',
  );
  // fall through to skill execution
} else {
  // Gate A: Full restriction — score < 60 blocks all non-read skills.
  // ...existing Gate A logic...

  // Gate B: Per-skill action_risk threshold.
  // ...existing Gate B logic...
}
```

### Why not reuse `humanApproved`

`humanApproved` is set exclusively by `approve-action` to re-execute a previously blocked
skill after explicit CEO approval. Reusing it here would blur the semantics — principal
origination is a task-level signal established at dispatch time, not a post-hoc re-execution
flag. Keeping them separate makes each signal's meaning clear and avoids coupling the two
code paths.

### Logging

Log at `info` with `skillName` and `currentScore` when the bypass fires. This makes principal
bypasses searchable in production (`"autonomy gate: skipped"`) and provides the same
traceability as the `humanApproved` log at line 322.

No bus event is emitted for the bypass (there is no `autonomy.skill_bypassed` event type).
The existing `skill.invoke` event provides sufficient audit coverage.

---

## Test Plan

Additions to `src/skills/execution.test.ts`:

1. **Principal bypass — Gate B territory:**
   Task metadata has `originator.systemRole === 'principal'`, autonomy score is 74,
   skill has `action_risk: 'high'` (requires 80). Skill should run successfully.

2. **Principal bypass — Gate A territory:**
   Same originator metadata, autonomy score is 50 (below Gate A threshold of 60),
   skill has `action_risk: 'low'`. Skill should run successfully.

3. **Regression — non-principal still gated:**
   Task metadata has no originator (or `systemRole !== 'principal'`), same low score.
   Skill should be blocked by the gate (return `{ success: false }`).

---

## Out of Scope

- Changes to `approve-action` or the `humanApproved` flag
- Changes to the elevated-skill gate (already uses `isPrincipalOriginated`)
- Any schema or bus event changes
