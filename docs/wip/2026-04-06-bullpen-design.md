# Bullpen Design — Inter-Agent Discussion (Tier 2 Memory)

**Issue:** [josephfung/curia#25](https://github.com/josephfung/curia/issues/25)
**Spec reference:** `docs/specs/01-memory-system.md` lines 24–44
**Date:** 2026-04-06

---

## Overview

The Bullpen is a shared, threaded workspace for inter-agent discussion. Agents can open threads, post to them, and reply to each other. The CEO/user can observe discussions via the SSE stream. User participation (intervene, start threads) is explicitly **out of scope** for this phase.

The Bullpen sits between ephemeral working memory (Tier 1) and the knowledge graph (Tier 4). It is the coordination layer where agents work through problems together before producing results visible to the user.

---

## Architecture

```text
agent calls bullpen skill
  → skill writes to DB (BullpenService)
  → skill publishes agent.discuss event (bus, agent layer)
      → BullpenDispatcher subscribes
          → creates agent.task for all thread participants
            (mentioned agents: reply expected; non-mentioned: FYI)
          → each addressed agent processes task, may call bullpen skill to reply
          → cycle continues until thread is closed or message cap hit
      → EventRouter streams agent.discuss to SSE clients (observability)

On any agent.task (channel-originated or bullpen-originated):
  → AgentRuntime queries BullpenService for pending threads
  → injects compact thread context before LLM call
```

---

## Data Model

### Migration: `015_create_bullpen.sql`

```sql
CREATE TABLE bullpen_threads (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  topic             TEXT        NOT NULL,
  creator_agent_id  TEXT        NOT NULL,
  participants      TEXT[]      NOT NULL,    -- all agent IDs in the thread
  status            TEXT        NOT NULL DEFAULT 'open',  -- 'open' | 'closed'
  message_count     INT         NOT NULL DEFAULT 0,       -- enforced cap: 100
  last_message_at   TIMESTAMPTZ,                          -- avoids subquery; updated on every post
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bullpen_messages (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id           UUID        NOT NULL REFERENCES bullpen_threads(id),
  sender_type         TEXT        NOT NULL DEFAULT 'agent',  -- 'agent' only; 'user' reserved
  sender_id           TEXT        NOT NULL,                  -- agent ID
  content             JSONB       NOT NULL,
  mentioned_agent_ids TEXT[]      NOT NULL DEFAULT '{}',     -- empty = broadcast, no reply expected
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast lookups for context injection (pending threads per agent)
CREATE INDEX ON bullpen_threads USING GIN (participants);
CREATE INDEX ON bullpen_messages (thread_id, created_at);
```

**Notes:**
- `last_message_at` is maintained by `BullpenService.postMessage` in the same UPDATE that increments `message_count`, avoiding an expensive subquery in the pending-thread lookup.
- `mentioned_agent_ids` controls FYI vs. reply-expected semantics in `BullpenDispatcher`. The dispatcher fans out `agent.task` events to **all non-sender participants** regardless of this field. Agents listed in `mentioned_agent_ids` receive a task marked with reply-expected intent; all other participants receive an FYI-only task. An empty array is a broadcast: every non-sender participant gets an FYI task, but no specific reply is expected from any of them.
- `sender_type` is stored as a column (not inferred) to make the audit trail self-describing and to support future user participation without schema changes.

---

## Bus Event: `agent.discuss`

Added to `src/bus/events.ts`:

```typescript
interface AgentDiscussPayload {
  threadId: string;
  messageId: string;           // DB row ID — for audit traceability
  topic: string;               // denormalized for SSE display without a DB hit
  senderAgentId: string;
  participants: string[];      // all thread participants
  mentionedAgentIds: string[]; // who gets tasks triggered (may be empty)
  content: string;
}

export interface AgentDiscussEvent extends BaseEvent {
  type: 'agent.discuss';
  sourceLayer: 'agent';
  payload: AgentDiscussPayload;
}
```

Factory follows the required-`parentEventId` pattern (every discuss event traces back to the agent task that triggered it):

```typescript
export function createAgentDiscuss(
  payload: AgentDiscussPayload & { parentEventId: string },
): AgentDiscussEvent { ... }
```

`agent.discuss` is added to the `BusEvent` union and to `src/bus/permissions.ts`:

| Layer      | Permission  |
|------------|-------------|
| `agent`    | publish     |
| `dispatch` | subscribe   |
| `system`   | subscribe   |

---

## BullpenService (`src/memory/bullpen.ts`)

Owns all DB reads and writes for the Bullpen. Injected into the skill, the runtime, and the BullpenDispatcher.

### Types

```typescript
export interface BullpenMessage {
  id: string;
  threadId: string;
  senderType: 'agent';
  senderId: string;
  content: unknown;
  mentionedAgentIds: string[];
  createdAt: Date;
}

export interface BullpenThread {
  id: string;
  topic: string;
  creatorAgentId: string;
  participants: string[];
  status: 'open' | 'closed';
  messageCount: number;
  lastMessageAt: Date | null;
  createdAt: Date;
}

export interface PendingThreadContext {
  threadId: string;
  topic: string;
  totalMessages: number;      // agent knows if it's seeing partial history
  recentMessages: Array<{
    senderAgentId: string;
    content: unknown;
    mentionedAgentIds: string[];
    createdAt: Date;
  }>;
}
```

### Methods

```typescript
openThread(
  topic: string,
  creatorAgentId: string,
  participants: string[],
  initialContent: string,
  mentionedAgentIds: string[],
): Promise<{ thread: BullpenThread; message: BullpenMessage }>
```
Inserts both the thread and the first message in a transaction. Sets `last_message_at` and `message_count = 1`.

```typescript
postMessage(
  threadId: string,
  senderAgentId: string,
  content: string,
  mentionedAgentIds: string[],
): Promise<BullpenMessage>
```
Rejects (throws) if `status = 'closed'` or `message_count >= 100`. Updates `message_count` and `last_message_at` atomically with the INSERT using a CTE.

```typescript
closeThread(threadId: string, requestingAgentId: string): Promise<void>
```
Sets `status = 'closed'`. Enforces that `requestingAgentId` is either the `creator_agent_id` or `'coordinator'`; throws an error otherwise.

```typescript
getThread(threadId: string): Promise<{ thread: BullpenThread; messages: BullpenMessage[] } | null>
```
Returns the full thread + all messages ordered by `created_at ASC`. Returns `null` if not found.

```typescript
getPendingThreadsForAgent(agentId: string, windowMinutes: number): Promise<PendingThreadContext[]>
```
Pending = `status = 'open'` AND `last_message_at` within `windowMinutes` AND the most recent message's `sender_id != agentId` (something unresponded to). Returns max 5 threads, ordered by `last_message_at DESC`. Each thread includes at most 5 most-recent messages. Uses the GIN index on `participants` for the participant filter.

---

## Bullpen Skill (`skills/bullpen/`)

### `skill.json`

```json
{
  "name": "bullpen",
  "description": "Open, reply to, read, or close inter-agent Bullpen discussion threads. Use 'post' to start a new thread, 'reply' to add a message, 'get_thread' to read full history, and 'close' to end a thread.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "action_risk": "low",
  "infrastructure": true,
  "inputs": {
    "action":               "string: 'post' | 'reply' | 'get_thread' | 'close'",
    "topic":                "string: thread topic — required for 'post'",
    "participants":         "string[]: agent IDs to include in the thread — required for 'post'",
    "mentioned_agent_ids":  "string[]: agent IDs to notify (@ mention) — optional for 'post', optional for 'reply'",
    "content":              "string: message content — required for 'post' and 'reply'",
    "thread_id":            "string: thread ID — required for 'reply', 'get_thread', 'close'"
  },
  "outputs": {
    "thread_id":  "string: the thread ID",
    "message_id": "string: the persisted message ID (post/reply)",
    "thread":     "object: full thread + messages (get_thread)",
    "status":     "string: 'closed' (close)"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 10000
}
```

`infrastructure: true` is required because the handler publishes `agent.discuss` to the bus. `action_risk: 'low'` — internal state write, no external communication.

### `handler.ts` — action dispatch

**`post`**: calls `bullpenService.openThread(topic, agentId, participants, content, mentionedAgentIds ?? participants)`. `mentionedAgentIds` defaults to all participants when omitted (you usually want responses when opening a thread). Publishes `agent.discuss` with `parentEventId = ctx.taskEventId`.

**`reply`**: calls `bullpenService.postMessage(threadId, agentId, content, mentionedAgentIds ?? [])`. Fetches the thread to get `participants` for the event payload. Publishes `agent.discuss`.

**`get_thread`**: calls `bullpenService.getThread(threadId)`. Returns the full thread object. Does not publish a bus event.

**`close`**: calls `bullpenService.closeThread(threadId, agentId)`. BullpenService enforces creator/coordinator only; the handler surfaces the error as `{ success: false, error: ... }` if rejected. Does not publish a bus event.

### SkillContext additions

Two fields added to `SkillContext` in `src/skills/types.ts`:

```typescript
/** The calling agent's string ID (e.g. 'coordinator'). Populated by execution layer. */
agentId?: string;
/** The ID of the agent.task event that triggered this skill call. Used for parentEventId on bus events. */
taskEventId?: string;
/** Bullpen service — available to infrastructure skills. */
bullpenService?: import('../memory/bullpen.js').BullpenService;
```

The execution layer already has `agentId` and `taskEventId` at invocation time — they just need to be threaded into `SkillContext`.

---

## BullpenDispatcher (`src/dispatch/bullpen-dispatcher.ts`)

Handles the `agent.discuss` → `agent.task` routing loop. Wired at startup alongside the main `Dispatcher`.

```typescript
export class BullpenDispatcher {
  constructor(private bus: EventBus, private logger: Logger) {}

  register(): void {
    this.bus.subscribe('agent.discuss', 'dispatch', async (event) => {
      await this.handleDiscuss(event as AgentDiscussEvent);
    });
    this.logger.info('BullpenDispatcher registered');
  }
}
```

### Routing logic

For every `agent.discuss` event, create one `agent.task` per thread participant **excluding the sender** (no agent gets notified about its own message):

```typescript
const otherParticipants = event.payload.participants.filter(
  (id) => id !== event.payload.senderAgentId,
);
for (const agentId of otherParticipants) {
  const isMentioned = event.payload.mentionedAgentIds.includes(agentId);
  const task = createAgentTask({
    agentId,
    conversationId: event.payload.threadId,  // thread IS the conversation; preserves working memory
    channelId: 'bullpen',                     // virtual channel identifier
    senderId: event.payload.senderAgentId,
    content: isMentioned
      ? `You've been mentioned in Bullpen thread "${event.payload.topic}" (thread_id: ${event.payload.threadId}). Review the injected thread context and reply using the bullpen skill.`
      : `FYI: New activity in Bullpen thread "${event.payload.topic}" (thread_id: ${event.payload.threadId}). No response required, but reply if you have something to add.`,
    metadata: {
      taskOrigin: 'bullpen',
      threadId: event.payload.threadId,
      mentioned: isMentioned,
    },
    parentEventId: event.id,
  });
  await this.bus.publish('dispatch', task);
}
```

**Message cap check:** Before creating any tasks, BullpenDispatcher reads the thread's `message_count`. If `>= 100`, it logs a warning and skips task creation for all participants. The thread remains open for reading but goes quiet.

**No `agent.response` subscription.** The agent's output returns to the Bullpen entirely via the `bullpen` skill (DB write + new `agent.discuss`). The `agent.response` produced at task completion has no corresponding routing entry in the main Dispatcher's `taskRouting` map — the main Dispatcher's "no routing info" log for these is downgraded from `warn` to `debug` with a comment noting it is expected for multi-dispatcher setups.

**`conversationId = threadId`** means each agent's working memory is scoped to the thread. The agent accumulates context across multiple activations in the same discussion.

---

## Runtime Context Injection (`src/agents/runtime.ts`)

### AgentConfig additions

```typescript
/** Optional Bullpen service for pending thread context injection. */
bullpenService?: BullpenService;
/** How far back to look for active threads (minutes). Default: 60. */
bullpenWindowMinutes?: number;
```

### Injection in `processTask`

After loading conversation history, before the first LLM call:

```typescript
if (this.config.bullpenService) {
  const pending = await this.config.bullpenService.getPendingThreadsForAgent(
    agentId,
    this.config.bullpenWindowMinutes ?? 60,
  );
  if (pending.length > 0) {
    // Inserted at position 1: after system prompt, before conversation history.
    // Matches spec context budget priority: working memory > Bullpen > KG.
    messages.splice(1, 0, {
      role: 'system',
      content: formatBullpenContext(pending),
    });
  }
}
```

### `formatBullpenContext` output

```text
[Bullpen — 2 active threads]

Thread "Q2 venue planning" (thread_id: abc-123, 8 total messages — showing last 5):
  coordinator [10:23]: "Can you check availability for Thursday?"
  calendar-agent [10:24]: "Thursday is clear, Friday has a conflict."
  coordinator [10:25]: "@research-agent can you find alternatives?"
  research-agent [10:27]: "Found two venues with Thursday availability."
  calendar-agent [10:28]: "Confirmed the first option works."
  → Call bullpen get_thread for full history.

Thread "Vendor research" (thread_id: def-456, 3 total messages):
  research-agent [09:15]: "@coordinator Found 3 relevant vendors."
```

The `totalMessages` count signals when the agent is seeing partial history, so it knows to call `get_thread` if it needs more context.

This injection runs for **all** agent tasks — both channel-originated and Bullpen-originated. For Bullpen-triggered tasks, the thread that triggered the task appears in the injected context alongside the task's `content` field, giving the agent full situational awareness.

---

## SSE Observability

One new subscription added to `EventRouter.setupSubscriptions` in `src/channels/http/event-router.ts`, using `'system'` layer (same pattern as `skill.invoke` / `skill.result`):

```typescript
bus.subscribe('agent.discuss', 'system', (event: BusEvent) => {
  if (event.type !== 'agent.discuss') return;
  const sseData = JSON.stringify({
    type: 'agent.discuss',
    thread_id: event.payload.threadId,
    topic: event.payload.topic,
    sender_agent_id: event.payload.senderAgentId,
    mentioned_agent_ids: event.payload.mentionedAgentIds,
    participants: event.payload.participants,
    timestamp: event.timestamp,
  });
  // System-wide broadcast — not filtered by conversationId
  this.broadcastToSseClients(sseData);
});
```

Dashboard clients see inter-agent discussions in real-time on the same `/api/messages/stream` endpoint they already use for `skill.invoke` and `skill.result`.

---

## Amplification Controls

The design avoids exponential message runaway through two mechanisms:

**1. Explicit mention targeting.** The `mentioned_agent_ids` field controls who gets a reply-expected task. A broadcast reply (empty mentions) creates FYI tasks for all participants but does not create reply pressure. Agents are guided by their system prompts to mention specifically who needs to respond.

**2. Hard message cap.** Threads are capped at 100 messages. Once the cap is hit, BullpenDispatcher stops creating new tasks for that thread and logs a warning. The thread stays readable but goes quiet naturally.

---

## Bootstrapping

In `src/index.ts`, alongside the existing Dispatcher:

```typescript
const bullpenService = new BullpenService(pool);
const bullpenDispatcher = new BullpenDispatcher(bus, logger);
bullpenDispatcher.register();
```

`bullpenService` is injected into:
- Each `AgentRuntime` config (`bullpenService`, `bullpenWindowMinutes`)
- The execution layer's `SkillContext` (for infrastructure skills)

---

## Out of Scope

- **User participation** — CEO observing, intervening in, or starting Bullpen threads. Deferred to a future phase.
- **Entity extraction from Bullpen messages** — agents may call `extract-relationships` explicitly if they discover something worth storing, but there is no automatic extraction pipeline for Bullpen content.
- **Thread summarization** — long threads are capped at 100 messages; no summarization of closed threads in this phase.
- **Rate-limiting FYI tasks** — if task churn from non-mentioned FYI tasks becomes a concern in production, a per-agent/per-thread rate limiter can be added. Deferred.
