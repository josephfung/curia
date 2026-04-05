# Bullpen Phase A — Core Thread Mechanics

**Issue:** #25 — Bullpen (Tier 2 inter-agent discussion)
**Date:** 2026-03-29
**Status:** Design approved, pending implementation
**Depends on:** None (builds on existing bus, agent runtime, and delegate skill)
**Prerequisite for:** Bullpen Phase B (intelligent topic matching)

## Problem

Agents can only collaborate via 1:1 delegation — the coordinator sends a task to one
specialist and waits for a response. There's no way for multiple specialists to discuss
a topic, build on each other's findings, or cross-pollinate insights. The coordinator
must orchestrate everything sequentially, losing the benefit of diverse perspectives
working together.

The architecture spec (01-memory-system.md) describes the Bullpen as Tier 2 memory —
a shared workspace for structured, threaded multi-agent conversations. This is the
foundation for that.

## Design Decisions

### Transport: Existing Bus

All inter-agent discussion flows through the existing `EventBus` as `agent.discuss`
events. This gives us delivery, ordering, audit logging (via the write-ahead hook), and
layer permission enforcement for free. No separate protocol needed.

### Discussion Model: Threads, Not Rooms

Threads are short-lived, task-scoped discussions. The coordinator starts a thread with
specific agents about a specific topic. The thread has a purpose, participants, and it
ends when the question is resolved or a turn limit is hit.

Rooms (persistent, topic-based channels) don't fit the agent model — agents don't
"browse" ambient context. They're dispatched to specific tasks. Threads map naturally
to how the coordinator already delegates.

### Convergence: Coordinator + Turn Limit

The coordinator can close a thread at any time when it has enough information. A
configurable turn limit (default 10) acts as a safety net — if the discussion hasn't
converged, the thread is force-closed and the coordinator must synthesize what it has.
This matches the error budget pattern already in the codebase.

### Turn Order: Round-Robin

Agents participate in round-robin order each round. Agents can't "interrupt" — the
LLM call model is request-response. Agents that have nothing to add can pass. The
coordinator sees the full transcript and synthesizes.

## Architecture

### Bus Event: `agent.discuss`

New event type added to `src/bus/events.ts`:

- **sourceLayer:** `'agent'`
- **payload:**
  - `threadId: string` — which discussion thread
  - `senderId: string` — agent name or `'user'` (for future CEO participation)
  - `senderType: 'agent' | 'user'`
  - `content: string` — the message text
  - `conversationId: string` — links to the originating user conversation

**Permissions:**
- Agent layer: publish + subscribe
- Dispatch layer: publish (for future CEO message routing into threads)
- System layer: publish + subscribe (audit)

### Database Tables

**`bullpen_threads`:**
- `id` UUID (PK)
- `topic` TEXT — what the thread is about
- `conversation_id` TEXT — the originating user conversation
- `participants` TEXT[] — agent names currently in the thread
- `status` TEXT — `'active'` | `'closed'`
- `max_turns` INTEGER — turn limit (default 10)
- `turn_count` INTEGER — current number of messages
- `created_by` TEXT — who started the thread
- `created_at` TIMESTAMPTZ
- `closed_at` TIMESTAMPTZ

**`bullpen_messages`:**
- `id` UUID (PK)
- `thread_id` UUID (FK → bullpen_threads)
- `sender_type` TEXT — `'agent'` | `'user'`
- `sender_id` TEXT — agent name or `'user'`
- `content` TEXT
- `created_at` TIMESTAMPTZ

### BullpenService

New class at `src/bullpen/bullpen-service.ts`. Owns thread lifecycle and message
persistence.

**Methods:**
- `createThread({ topic, conversationId, participants, createdBy, maxTurns? }): Promise<Thread>`
  Creates thread record. Defaults `maxTurns` to 10.
- `addParticipant(threadId, agentName): Promise<void>`
  Appends to participants array.
- `removeParticipant(threadId, agentName): Promise<void>`
  Removes from participants array.
- `postMessage(threadId, senderType, senderId, content): Promise<{ message: BullpenMessage; forceClosed: boolean }>`
  Persists message, increments `turn_count`. If `turn_count >= max_turns`, auto-closes
  the thread and returns `forceClosed: true`.
- `closeThread(threadId): Promise<void>`
  Sets status to `'closed'`, records `closed_at`.
- `getThread(threadId): Promise<Thread | undefined>`
- `getMessages(threadId): Promise<BullpenMessage[]>`
  All messages in chronological order.
- `getActiveThreadsForAgent(agentName): Promise<Thread[]>`
  Active threads where the agent is a participant.

**Backend pattern:** follows `InMemoryBackend` / `PostgresBackend` pattern from
`ContactService` and `WorkingMemory` — private constructor, static factory methods
(`createWithPostgres`, `createForTesting`).

### bullpen-discuss Skill

New infrastructure skill at `skills/bullpen-discuss/`.

**Inputs:**
- `topic: string` — what to discuss
- `participants: string` — comma-separated agent names
- `conversation_id: string` — originating conversation
- `initial_message: string` — coordinator's opening message/question
- `max_turns?: number` — override default turn limit

**Flow:**
1. Create thread via `BullpenService.createThread()`
2. Post coordinator's `initial_message` as first message
3. Publish `agent.discuss` event to the bus
4. Enter discussion loop (round-robin):
   - For each participant, publish `agent.task` with the full thread history
     formatted as a conversation transcript
   - Wait for `agent.response` (90s timeout per agent, matching delegate)
   - Post response as `bullpen_message`, publish `agent.discuss` event
   - If `postMessage` returns `forceClosed: true`, exit loop
   - If agent response is empty or very short (under 20 chars), skip them in
     subsequent rounds. The agent's system prompt should instruct it to respond
     with an empty string or "No additional input." when it has nothing to add.
5. Close thread if not already force-closed
6. Return full thread transcript to coordinator for synthesis

**Thread context format** sent to each agent:

```
[Bullpen Thread: "What do we know about this vendor?"]
coordinator: We received a proposal from Acme Corp. What can everyone find?
research-analyst: I found three press releases from 2025...
expense-tracker: (your turn to respond)
```

The agent runtime doesn't need modification — it processes the task content as-is.

**Sensitivity:** `normal` — no external side effects.

### Coordinator System Prompt Update

Add instructions for when to use `bullpen-discuss` vs `delegate`:
- Use `delegate` for focused questions to a single specialist
- Use `bullpen-discuss` when the task benefits from multiple perspectives, when
  specialists might build on each other's findings, or when the CEO explicitly asks
  for group input

### CEO Observability

- **Audit log** captures all `agent.discuss` events automatically (write-ahead hook)
- **Coordinator** synthesizes discussion results and reports to the CEO
- **Future UI** can query `bullpen_threads` and `bullpen_messages` directly

CEO direct participation in threads (posting messages) is deferred — it requires
dispatcher routing changes. For Phase A, the CEO observes and the coordinator manages.

## Scope

### In scope

- `agent.discuss` bus event type with layer permissions
- Database migration for `bullpen_threads` and `bullpen_messages` tables
- `BullpenService` with thread lifecycle and message persistence
- `bullpen-discuss` infrastructure skill with round-robin discussion loop
- Coordinator system prompt update
- Bootstrap wiring
- Tests for service, skill, and integration

### Out of scope (Phase B or later)

- Intelligent topic matching (semantic expertise embeddings)
- Automatic roster suggestions from BullpenMonitor
- Agent relevance polling and threshold self-tuning
- CEO direct participation in threads (posting messages into active threads)
- Thread summarization for context management

## Testing Strategy

- **Unit tests** for BullpenService: thread creation, message posting, turn limit
  enforcement, participant management, force-close behavior
- **Unit tests** for bullpen-discuss skill: round-robin execution, timeout handling,
  thread transcript formatting, early exit on "nothing to add"
- **Integration test**: coordinator invokes bullpen-discuss, two specialists respond,
  coordinator synthesizes result
- **Turn limit test**: thread force-closes at max_turns, coordinator receives
  forceClosed signal
