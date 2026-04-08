# Design: Conversation Checkpoint Pipeline

**Date:** 2026-04-08
**Status:** Draft

---

## Background

Two production bugs were traced to a single root cause: `extract-relationships` is wired as an LLM tool call inside the coordinator's turn loop. Because the skill is declared as a background housekeeping task that must always run, the coordinator calls it with no text preamble — returning an empty content string. The agent runtime's empty-response recovery mechanism then fires, appending a nudge prompt to a message array that still contains the tool_use/tool_result blocks. The recovery LLM call sees its own prior tool call and confabulates "I already provided my response," delivering that text to the user instead of a real reply.

Beyond the bug, the per-message invocation pattern is the wrong granularity for relationship and entity extraction. Individual messages are often fragments of thought. Extraction across a full conversational exchange yields richer, more accurate triples. Running the classifier gate on every message also wastes tokens on the majority of turns (scheduling, lookups, email drafts) that contain no relationship signal.

`extract-entities` (issue #151) will need exactly the same invocation pattern. Encoding each new extraction skill as a coordinator tool call repeats the same fragile design.

---

## Goals

1. Fix the Signal and web chat confabulation bugs by removing `extract-relationships` from the LLM tool loop entirely.
2. Establish a **conversation checkpoint pipeline** — a System Layer mechanism that fires when a conversation goes quiet, fetches new turns since the last checkpoint, and fans out to all registered checkpoint skills.
3. Support incremental processing via a per-conversation **watermark**, so re-opening a quiet conversation triggers extraction on only the new turns.
4. Make adding future checkpoint skills (e.g. `extract-entities`, `extract-facts`) a self-contained change — no modifications to Dispatch or the runtime required.

---

## Out of Scope

- Working memory expiry / TTL cleanup (noted as future work — `expires_at` column exists but is unpopulated)
- The `extract-entities` skill implementation (covered by issue #151; this spec wires the pipeline it will plug into)
- The `extract-facts` skill
- Tuning the debounce window
- Per-channel or per-agent checkpoint configuration

---

## Architecture

```
[Dispatch Layer]
  agent.response received
      │
      ▼
  reset debounce timer (conversationId + agentId)
      │
      │  (N minutes of inactivity)
      ▼
  publish conversation.checkpoint
      │
[System Layer]
      ▼
  ConversationCheckpointProcessor
      │
      ├─ fetch turns from working_memory WHERE created_at > last_checkpoint_at
      │
      ├─ fire-and-forget: extract-relationships(transcript, source)
      ├─ fire-and-forget: extract-entities(transcript, source)        ← future
      └─ fire-and-forget: extract-facts(transcript, source)           ← future
      │
      ▼
  upsert conversation_checkpoints (advance watermark)
```

The checkpoint processor is a **System Layer** subscriber — it has full bus access and is trusted infrastructure, following the same pattern as the audit logger and scheduler.

---

## Section 1 — Coordinator Change

Remove the "Relationship Extraction" block from `agents/coordinator.yaml`. `extract-relationships` is no longer a tool the LLM calls. The skill manifest (`skill.json`) and handler are unchanged.

This is the minimal fix for the production bugs. Everything else in this spec builds on top of it.

---

## Section 2 — New Bus Event: `conversation.checkpoint`

Add to `src/bus/events.ts`:

```typescript
// Fired by Dispatch when a conversation has been quiet for the checkpoint
// debounce window. The payload includes the turns since the last watermark
// so the processor does not need to re-query working memory.
export interface ConversationCheckpointPayload {
  conversationId: string;
  agentId: string;
  channelId: string;
  // ISO timestamp — only turns created after this point are included in `turns`.
  // Empty string on the first checkpoint (no prior watermark).
  since: string;
  // Ordered chronologically (oldest first). Contains only turns since `since`.
  turns: Array<{ role: 'user' | 'assistant'; content: string }>;
}
```

Add `'conversation.checkpoint'` to the `BusEvent` discriminated union and the `createConversationCheckpoint` factory, following the same pattern as existing event factories.

**Permissions:** `dispatch` layer may publish `conversation.checkpoint`. System Layer subscribers may consume it. Add to `src/bus/permissions.ts`.

---

## Section 3 — New Database Table: `conversation_checkpoints`

```sql
-- Migration: 016_create_conversation_checkpoints.sql

CREATE TABLE conversation_checkpoints (
  conversation_id   TEXT        NOT NULL,
  agent_id          TEXT        NOT NULL,
  last_checkpoint_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, agent_id)
);
```

The primary key enforces one watermark row per (conversation, agent) pair. Upsert advances it; there is no delete path.

---

## Section 4 — Dispatch: Debounce Timer

In `src/dispatch/dispatcher.ts`, maintain an in-memory debounce timer map:

```typescript
// Key: `${conversationId}:${agentId}`
private checkpointTimers = new Map<string, ReturnType<typeof setTimeout>>();
```

In the `agent.response` handler (after routing the outbound message), reset the debounce:

```typescript
private scheduleCheckpoint(conversationId: string, agentId: string, channelId: string): void {
  const key = `${conversationId}:${agentId}`;
  const existing = this.checkpointTimers.get(key);
  if (existing) clearTimeout(existing);

  const debounceMs = this.config.dispatch?.conversationCheckpointDebounceMs ?? 600_000; // 10 min default

  const timer = setTimeout(async () => {
    this.checkpointTimers.delete(key);
    await this.fireCheckpoint(conversationId, agentId, channelId);
  }, debounceMs);

  this.checkpointTimers.set(key, timer);
}
```

`fireCheckpoint` queries `conversation_checkpoints` for the last watermark, reads turns from `working_memory` since that watermark, and publishes `conversation.checkpoint`. If working memory returns no turns (e.g. a timer that fired after the conversation was already fully processed), it publishes nothing.

**On shutdown:** In the `close()` method, iterate `checkpointTimers` and `clearTimeout` each — prevents dangling timers in tests and clean process exit.

---

## Section 5 — System Layer: ConversationCheckpointProcessor

New file: `src/checkpoint/processor.ts`

```typescript
export class ConversationCheckpointProcessor {
  constructor(
    private bus: Bus,
    private skillRunner: SkillRunner,
    private pool: DbPool,
    private logger: Logger,
  ) {}

  register(): void {
    this.bus.subscribe('conversation.checkpoint', 'system', async (event) => {
      await this.handleCheckpoint(event);
    });
  }

  private async handleCheckpoint(event: BusEvent & { type: 'conversation.checkpoint' }): Promise<void> {
    const { conversationId, agentId, channelId, turns } = event.payload;

    if (turns.length === 0) return;

    // Concatenate turns into a single transcript string for skills that take `text`.
    const transcript = turns
      .map(t => `${t.role === 'user' ? 'User' : 'Curia'}: ${t.content}`)
      .join('\n\n');

    const source = `system:checkpoint/conversation:${conversationId}/agent:${agentId}/channel:${channelId}`;

    // Fire all checkpoint skills concurrently, fire-and-forget.
    // Errors are logged but do not block watermark advancement.
    const skills: Array<{ name: string; input: Record<string, string> }> = [
      { name: 'extract-relationships', input: { text: transcript, source } },
      // extract-entities goes here when built (issue #151)
    ];

    await Promise.allSettled(
      skills.map(skill =>
        this.skillRunner.run(skill.name, skill.input)
          .catch(err => this.logger.error({ err, skill: skill.name, conversationId }, 'checkpoint skill failed')),
      ),
    );

    // Advance watermark — upsert so first checkpoint creates the row.
    await this.pool.query(
      `INSERT INTO conversation_checkpoints (conversation_id, agent_id, last_checkpoint_at)
       VALUES ($1, $2, now())
       ON CONFLICT (conversation_id, agent_id)
       DO UPDATE SET last_checkpoint_at = now()`,
      [conversationId, agentId],
    );
  }
}
```

Register in `src/index.ts` alongside the audit logger and scheduler, passing it the bus, skill runner, pool, and logger.

**Why `Promise.allSettled` and not `Promise.all`:** A failure in one checkpoint skill (e.g. network error in extract-relationships) must not prevent the watermark from advancing. Silently swallowing skill errors is intentional here — the logger call ensures observability.

---

## Section 6 — Config

Add to `config/default.yaml` under `dispatch:`:

```yaml
dispatch:
  conversationCheckpointDebounceMs: 600000   # 10 minutes
```

Typed in the config schema (`src/config.ts`) as `number | undefined` with a documented default.

---

## Section 7 — Testing

### Unit: Dispatcher debounce (`tests/unit/dispatch/dispatcher-checkpoint.test.ts`)

Use fake timers (Vitest's `vi.useFakeTimers()`).

| Test | Assertion |
|---|---|
| Timer fires after debounce window | `fireCheckpoint` called once |
| Incoming message resets the timer | Only one `fireCheckpoint` call after the second debounce elapses |
| Shutdown clears all timers | No `fireCheckpoint` calls after `close()` |
| No turns since watermark | `conversation.checkpoint` not published |

### Unit: ConversationCheckpointProcessor (`tests/unit/checkpoint/processor.test.ts`)

Use an in-memory skill runner stub and in-memory working memory.

| Test | Assertion |
|---|---|
| Both skills called with concatenated transcript | Skill runner receives correct `text` and `source` |
| Skill failure does not block watermark | Watermark advanced even when skill throws |
| Watermark upserted after first checkpoint | Row created in `conversation_checkpoints` |
| Watermark upserted after subsequent checkpoint | Row updated, not duplicated |
| Empty turns list | No skills called, no watermark update |

### Integration: Full round-trip (`tests/integration/checkpoint.test.ts`)

Real Postgres (Docker), real skill runner.

1. Insert two working_memory turns for a test conversationId
2. Publish `conversation.checkpoint` event directly (bypass debounce)
3. Assert `extract-relationships` ran: check `kg_edges` table for expected edge
4. Assert `conversation_checkpoints` row exists with `last_checkpoint_at` > test start
5. Insert two more turns, publish another checkpoint
6. Assert only the two new turns were passed to the skill (watermark respected)

---

## Section 8 — Migration Sequence

1. Deploy coordinator.yaml without the `extract-relationships` tool instruction (bug fix — no schema changes required)
2. Run migration `016_create_conversation_checkpoints.sql`
3. Deploy updated dispatcher + checkpoint processor

Step 1 can ship independently as a fast hotfix for the production bugs.

---

## Open Questions

- **Debounce window:** 10 minutes is a reasonable default for async extraction but may feel long if the KG is used for context in the same session. Accept for now; revisit when entity context enrichment is in production and latency matters.
- **Bullpen conversations:** Bullpen threads use `conversationId = threadId`. The same checkpoint pipeline applies — inter-agent discussions may contain relationship signal worth extracting. No special case needed.
- **Multi-agent:** Each `(conversationId, agentId)` pair gets its own timer and watermark. If the coordinator and a sub-agent both respond in the same conversation, each fires its own checkpoint. This is correct — their working memory histories are independent.
