# Intent Anchor — Design

**Date:** 2026-04-09
**Issue:** josephfung/curia#233
**Status:** Approved

## Problem

Agents drift from their original goal during extended multi-burst operations. This was observed in Zora's ASI gaps: an agent may evolve its approach over multiple scheduler bursts to the point where it has lost track of *why* it was originally invoked.

Additionally, `agent_tasks` records (which carry the `intent_anchor`) are only created when the coordinator explicitly passes `intent_anchor` to `scheduler-create`. The coordinator currently has no guidance on when or how to do this, so in practice no `agent_tasks` records are created for dynamically-scheduled jobs.

## Solution

Two complementary changes:

1. **Runtime injection** — when a scheduler burst fires for a persistent task (one with a linked `agent_tasks` record), the intent anchor is appended to `effectiveSystemPrompt` so it carries the same authority as a behavioral instruction. The agent can evolve its approach, but cannot wholesale abandon its original mandate.

2. **Coordinator guidance** — explicit rules in `agents/coordinator.yaml` telling the coordinator when to provide `intent_anchor` to `scheduler-create`, what to put in it, and when not to use it.

## What Already Exists

- `agent_tasks` table with `intent_anchor TEXT NOT NULL` column (migration 008)
- `scheduler-service.ts` creates an `agent_tasks` record when `intentAnchor` is passed to `createJob()`
- `scheduler.ts` reads `intent_anchor` via a `LEFT JOIN agent_tasks` when polling due jobs
- `scheduler-create` skill accepts `intent_anchor` as an optional input and forwards it to `createJob()`
- Tests cover the existing content-bundle injection path

## What This Design Changes

### 1. `src/bus/events.ts` — Add `intentAnchor` to event payload

Add `intentAnchor?: string` to `AgentTaskPayload`. This is the channel that carries the anchor from the scheduler into the runtime.

```ts
interface AgentTaskPayload {
  agentId: string;
  conversationId: string;
  channelId: string;
  senderId: string;
  content: string;
  metadata?: Record<string, unknown>;
  senderContext?: ...;
  intentAnchor?: string;  // ← new: present only for persistent tasks
}
```

### 2. `src/scheduler/scheduler.ts` — Pass anchor in payload, clean up content

In `fireJob()`, move `intent_anchor` from the content JSON bundle into the event payload. The content for persistent tasks becomes `{progress, task_payload}` only — intent belongs in the system prompt, not the conversation.

Before:
```ts
if (job.agentTaskId && job.intentAnchor) {
  content = JSON.stringify({
    intent_anchor: job.intentAnchor,  // ← remove this
    progress: job.progress ?? {},
    task_payload: job.taskPayload,
  });
}
```

After:
```ts
if (job.agentTaskId) {
  content = JSON.stringify({
    progress: job.progress ?? {},
    task_payload: job.taskPayload,
  });
}
```

And pass `intentAnchor` in the `createAgentTask()` call:
```ts
const taskEvent = createAgentTask({
  agentId: job.agentId,
  conversationId: `scheduler:${job.id}`,
  channelId: 'scheduler',
  senderId: 'scheduler',
  content,
  intentAnchor: job.intentAnchor ?? undefined,  // ← new
  parentEventId: firedEvent.id,
});
```

### 3. `src/agents/runtime.ts` — Inject anchor into system prompt

Following the same pattern as the autonomy block and time context block, append the anchor to `effectiveSystemPrompt` before the LLM call. Inject only when `intentAnchor` is present.

```ts
if (taskEvent.payload.intentAnchor) {
  effectiveSystemPrompt += '\n\n## Original Task Intent\n' + taskEvent.payload.intentAnchor;
}
```

The anchor is injected **before** the context budget assembly (history, entity memory, bullpen) — it is non-negotiable, like the system prompt itself. It is injected **after** the autonomy block and time block so those remain closest to the base persona.

No error handling needed here beyond what's implicit — `intentAnchor` is a plain string with no external calls, so there's nothing to fail.

### 4. `agents/coordinator.yaml` — Guidance on intent anchors

Add a new section to the coordinator's scheduling guidance:

**Always provide `intent_anchor` when using `scheduler-create` for a recurring (`cron_expr`) job.**

- Write one or two sentences describing what the task is supposed to accomplish and why — the original mandate
- Describe *intent*, not *implementation*: what should be achieved, not which tools to call
- Good: `"Run weekly contacts dedup scan and present any probable/certain duplicate pairs to Joseph for review."`
- Bad: `"Call contact-find-duplicates with min_confidence probable then loop through pairs calling contact-merge dry_run: true."`

**Do not provide `intent_anchor` for one-shot (`run_at`) jobs** — a one-shot job fires once and is done; there is no multi-burst drift risk.

**The anchor should be stable.** If the CEO fundamentally changes what a recurring task should do, cancel the old job and create a new one with a fresh anchor. Do not treat it as an update to the existing job.

**Declarative jobs (defined in agent YAML files) do not need `intent_anchor`.** Their task description is canonically defined in the YAML and cannot drift — the scheduler fires exactly what the YAML says on every restart.

## What This Does NOT Change

- The `agent_tasks` DB schema — `intent_anchor` column already exists and is correct
- `scheduler-service.ts` — already creates `agent_tasks` records when `intentAnchor` is provided
- `scheduler-create` skill manifest/handler — already accepts and forwards `intent_anchor`
- Declarative job upsert path — `upsertDeclarativeJob()` never creates `agent_tasks`, and that remains correct by design
- The Anthropic provider — anchor injection uses `effectiveSystemPrompt` string concatenation, which is provider-neutral

## Injection Order in `effectiveSystemPrompt`

```
[base system prompt]
[office identity block — substituted via placeholder]

[autonomy block — appended if autonomy service configured]

[time context block — appended if timezone configured]

[intent anchor block — appended if intentAnchor present]  ← new
```

The anchor is appended last so it sits closest to the conversation, making it maximally salient to the model.

## Tests

New unit tests required:

| Test | Location |
|---|---|
| Anchor stored in `agent_tasks` at job creation | `tests/unit/scheduler/scheduler-service.test.ts` (already exists, verify coverage) |
| Anchor passed in event payload when `agentTaskId` is set | `tests/unit/scheduler/scheduler.test.ts` |
| Anchor NOT in content bundle | `tests/unit/scheduler/scheduler.test.ts` |
| Anchor injected into system prompt at burst start | `tests/unit/agents/runtime.test.ts` |
| One-shot tasks (no `intentAnchor`) do not get anchor injected | `tests/unit/agents/runtime.test.ts` |
| Declarative jobs (no `agentTaskId`) do not pass anchor in payload | `tests/unit/scheduler/scheduler.test.ts` |

## Versioning

Patch bump (`0.x.Y`) — this completes infrastructure that was already partially in place. No new user-facing capability; the `scheduler-create` skill interface is unchanged (adding coordinator guidance to use an existing optional field is not a schema change).
