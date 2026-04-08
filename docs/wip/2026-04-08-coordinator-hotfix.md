# Coordinator Relationship Extraction Hotfix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `extract-relationships` from the coordinator's LLM tool loop to fix the Signal and web chat confabulation bugs.

**Architecture:** The coordinator's system prompt currently instructs the LLM to call `extract-relationships` as a background housekeeping tool after every message. This causes the LLM to return an empty text turn (tool call only), triggering the runtime's recovery mechanism, which confabulates "I already provided my response." Removing it from the tool list and system prompt eliminates the trigger entirely. Relationship extraction will be wired through the conversation checkpoint pipeline in a follow-up PR.

**Tech Stack:** YAML (coordinator config), TypeScript (runtime.ts recovery comment), Vitest (existing tests)

---

### Task 1: Remove `extract-relationships` from coordinator.yaml

**Files:**
- Modify: `agents/coordinator.yaml` (lines 44–54 system prompt block, line 261 pinned_skills list)

The coordinator.yaml has two places referencing `extract-relationships`:
1. A "Relationship Extraction" system prompt block (lines 44–54) that instructs the LLM to call the skill
2. A `pinned_skills` list entry (line 261) that makes the skill available as a tool

Both must be removed together — leaving one without the other would either confuse the LLM (prompt references a tool it can't call) or waste a tool slot silently.

- [ ] **Step 1: Open the file and locate the two sections**

Read `agents/coordinator.yaml`. Confirm:
- Lines ~44–54: the `## Relationship Extraction` block ends with "The user must always receive a non-empty text response from you."
- Line ~261: `- extract-relationships` in the `pinned_skills` list

- [ ] **Step 2: Remove the Relationship Extraction system prompt block**

Delete this entire block from `agents/coordinator.yaml`:

```yaml
  ## Relationship Extraction
  After every message, call `extract-relationships` with the full message text
  and your current task source string. You do not need to decide whether the
  message contains relationships — the skill handles that internally and exits
  immediately if there is nothing to extract. Always call it; never skip it.

  IMPORTANT: `extract-relationships` is a silent background housekeeping task.
  It must never replace your text response to the user. Always write your reply
  to the user first, then call `extract-relationships` as a follow-up step.
  If you have nothing else to say, write a brief acknowledgement before calling it.
  The user must always receive a non-empty text response from you.
```

Leave the `## Relationship Management` block (query-relationships, delete-relationship) intact — that is user-facing functionality, not background housekeeping.

- [ ] **Step 3: Remove `extract-relationships` from pinned_skills**

In the `pinned_skills` list, delete the line:
```yaml
  - extract-relationships
```

- [ ] **Step 4: Verify no other coordinator references remain**

```bash
grep -n "extract-relationships" agents/coordinator.yaml
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git -C /path/to/worktree add agents/coordinator.yaml
git -C /path/to/worktree commit -m "fix: remove extract-relationships from coordinator tool loop

Caused the LLM to return an empty-text tool-call turn, triggering the
empty-response recovery mechanism, which confabulated 'I already provided
my response' to the user. Extraction will move to the conversation
checkpoint pipeline (feat/conversation-checkpoint)."
```

---

### Task 2: Update the recovery mechanism comment in runtime.ts

**Files:**
- Modify: `src/agents/runtime.ts` (lines ~448–455, the warning comment block)

The recovery mechanism itself is still valid for other tools that legitimately produce empty turns. But its comment currently names `extract-relationships` as the canonical example — that example is now incorrect and will confuse future readers.

- [ ] **Step 1: Update the inline comment**

Find this block in `src/agents/runtime.ts` (around line 448):

```typescript
      if (response.content.trim() === '') {
        // The LLM returned end_turn with no text — this happens when the model considers
        // its tool calls (e.g. extract-relationships) to be the full response and produces
        // an empty content array. Attempt one recovery: append the empty turn + a nudge,
        // then call the LLM again without tools to force it to write the text reply.
```

Replace with:

```typescript
      if (response.content.trim() === '') {
        // The LLM returned end_turn with no text — this happens when the model considers
        // its tool calls to be the full response and produces an empty content array.
        // Attempt one recovery: append the empty turn + a nudge, then call the LLM again
        // without tools to force it to write the text reply.
```

- [ ] **Step 2: Commit**

```bash
git -C /path/to/worktree add src/agents/runtime.ts
git -C /path/to/worktree commit -m "chore: update recovery comment — extract-relationships no longer a coordinator tool"
```

---

### Task 3: Run the test suite

**Files:** none (verification only)

- [ ] **Step 1: Run all tests**

```bash
npm --prefix /path/to/worktree test
```

Expected: all tests pass. The coordinator's pinned_skills change reduces the tool list but no test asserts on that specific list, so no test changes are needed.

- [ ] **Step 2: If any test fails**

Check whether the failure references `extract-relationships` in a coordinator context. If so, update the test to remove that assertion — it was testing the (now-removed) broken behaviour.

---

### Task 4: Update CHANGELOG and bump version

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

This is a bug fix, so a patch bump applies.

- [ ] **Step 1: Add CHANGELOG entry under `## [Unreleased]`**

```markdown
### Fixed
- **Coordinator confabulation bug** — removed `extract-relationships` from the coordinator's LLM tool loop. The per-message tool call caused empty-text turns that triggered the empty-response recovery mechanism, which confabulated "I already provided my response" in Signal group chats and the web UI. Relationship extraction moves to the conversation checkpoint pipeline.
```

- [ ] **Step 2: Bump patch version in package.json**

Find the `"version"` field in `package.json` and increment the patch component
(`x.y.Z` → `x.y.(Z+1)`). Patch bumps apply to bug fixes, small improvements,
and doc-only changes — see the versioning table in `CLAUDE.md`.

- [ ] **Step 3: Commit**

```bash
git -C /path/to/worktree add CHANGELOG.md package.json
git -C /path/to/worktree commit -m "chore: release 0.18.1 — fix coordinator confabulation bug"
```
