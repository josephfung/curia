# Bullpen Phase B — Intelligent Topic Matching

**Issue:** #25 — Bullpen (Tier 2 inter-agent discussion)
**Date:** 2026-03-29
**Status:** Design approved, pending implementation
**Depends on:** Bullpen Phase A (core thread mechanics)

## Problem

In Phase A, the coordinator manually picks which agents participate in each discussion.
This works for obvious cases ("research this company" → research-analyst), but fails
when relevance emerges mid-conversation. A discussion about a conference might not
involve the expense-tracker until someone mentions the ticket was already bought. The
coordinator may not catch every connection.

Phase B adds a passive monitoring service that watches active discussions, detects
when non-participating agents might be relevant, and suggests roster additions to the
coordinator — without adding agents unilaterally or consuming discussion turns.

## Design Decisions

### Semantic Matching, Not Keywords

Keyword matching is brittle — "the ticket was already bought" wouldn't match `expenses`
or `reimbursement`. The codebase already has an `EmbeddingService` (OpenAI
`text-embedding-3-small`) and pgvector for the knowledge graph. The same infrastructure
powers topic matching: embed agent expertise descriptions and compare against thread
message content via cosine similarity.

### Three-Layer Filtering

1. **Embedding similarity** (cheap, fast) — catches obvious matches
2. **Agent self-assessment** (one LLM call) — uses the agent's domain knowledge to
   confirm relevance
3. **Coordinator approval** (final say) — the coordinator decides whether to add the
   agent

The monitor never adds agents unilaterally. It suggests, the coordinator decides.

### Suggestions Don't Consume Turns

The monitor notifies the coordinator via a separate `bullpen.suggestion` bus event,
not a message in the thread. This avoids inflating the turn count, which is especially
important for threads that are already running long — exactly when mid-thread roster
additions are most likely.

### Persisted Threshold Tuning

Per-agent similarity thresholds are stored in PostgreSQL, not in memory. Agents that
are polled infrequently (once a month) would take years to tune in-memory, and reboots
would reset all learning. Persistence ensures thresholds survive restarts and accumulate
accuracy over time.

## Architecture

### Agent Expertise Declarations

Each agent declares its areas of expertise in its YAML config:

```yaml
bullpen:
  expertise: "Financial tracking, expense reports, purchase orders, budget monitoring, reimbursement processing"
```

A single free-text field, not a keyword list. This gets embedded once at startup via
`EmbeddingService` and held in memory as a `Map<string, number[]>` (agent name →
expertise embedding). Agents without `bullpen.expertise` are excluded from topic
matching — they can only join threads via explicit coordinator invitation.

### BullpenMonitor Service

New class at `src/bullpen/bullpen-monitor.ts`. Subscribes to `agent.discuss` events
and watches for potential roster additions.

**Pipeline (on each `agent.discuss` event):**

1. **Debounce** — only check after the first message in each discussion round, not
   every agent turn. This prevents redundant checks when multiple agents respond in
   sequence.

2. **Embed the message** — call `embeddingService.embed(message.content)` to get a
   vector for the new message.

3. **Compare against non-participants** — for each agent NOT already in the thread,
   compute cosine similarity between the message embedding and the agent's expertise
   embedding.

4. **Threshold check** — if similarity exceeds the agent's tuned threshold (loaded
   from database, default 0.65), this agent is a candidate.

5. **Agent relevance poll** — make a standalone LLM call using the candidate agent's
   system prompt as context (loaded from the agent config, not a full agent task).
   The prompt asks: "A discussion is happening about [thread topic]. A recent message
   mentioned: [message content]. Is this relevant to your expertise? Respond with
   JSON: { relevant: boolean, reason: string }." This is a single cheap LLM call,
   not a full tool-use loop — no skills, no working memory, no bus events.

6. **Record poll result** — store whether the agent said yes or no in the
   `bullpen_agent_thresholds` table. This feeds threshold tuning.

7. **Notify coordinator** — if the agent says "yes," publish a `bullpen.suggestion`
   bus event. The coordinator sees this as supplementary context on its next turn and
   can call `BullpenService.addParticipant()` if it agrees.

**What the monitor does NOT do:**
- Never adds agents to threads directly — only suggests
- Never modifies thread content — only reads
- Never posts messages into threads — uses a separate event type

### Bus Event: `bullpen.suggestion`

New event type:

- **sourceLayer:** `'system'` (the monitor is a cross-cutting service)
- **payload:**
  - `threadId: string`
  - `suggestedAgent: string`
  - `reason: string` — from the agent's relevance poll
  - `similarityScore: number`

**Permissions:**
- System layer: publish
- Agent layer: subscribe (coordinator receives suggestions)

The coordinator's runtime picks this up as injected context — similar to how sender
context is injected today. The coordinator sees: "While this discussion is running,
the Bullpen monitor thinks expense-tracker may be relevant because: [reason]."

### Threshold Self-Tuning

**Table: `bullpen_agent_thresholds`:**
- `agent_name` TEXT (PK)
- `threshold` FLOAT — current tuned threshold
- `total_polls` INTEGER — lifetime poll count
- `total_hits` INTEGER — lifetime "yes, relevant" count
- `recent_polls` JSONB — rolling window of last 20 poll results
  (`[{ relevant: boolean, timestamp: string }]`)
- `updated_at` TIMESTAMPTZ

**Tuning algorithm:**

After each poll response, recalculate hit rate from the `recent_polls` window:
- Hit rate > 80% → lower threshold by 0.02 (agent is consistently relevant, catch more)
- Hit rate < 30% → raise threshold by 0.02 (agent is rarely relevant, reduce noise)
- Hit rate between 30-80% → no change
- Clamp threshold to [0.50, 0.85] — never so low it fires on everything, never so
  high it's useless

On startup, load all thresholds from the table. Agents without a row get the 0.65
default; a row is created on their first poll.

**Observability:** log threshold adjustments at `info` level:
"expense-tracker threshold adjusted: 0.65 → 0.63 (hit rate 85%, 17/20 polls)"

### Agent Config Schema Extension

Add `bullpen` block to `AgentYamlConfig` in `src/agents/loader.ts`:

```typescript
bullpen?: {
  expertise?: string;  // Free-text expertise description for topic matching
};
```

The `expertise` field is optional. Agents without it are invisible to the
`BullpenMonitor` but can still participate in threads via explicit invitation.

### Bootstrap Wiring

Construct `BullpenMonitor` after `BullpenService` and `EmbeddingService`:
- Load expertise strings from agent configs
- Embed each expertise string via `EmbeddingService`
- Load thresholds from `bullpen_agent_thresholds` table
- Subscribe to `agent.discuss` events on the bus

## Scope

### In scope

- `bullpen.expertise` field in agent YAML config schema
- `BullpenMonitor` service with embedding comparison pipeline
- Agent relevance polling (lightweight LLM call)
- `bullpen.suggestion` bus event type
- `bullpen_agent_thresholds` database table and migration
- Threshold self-tuning with persistence
- Coordinator context injection for suggestions
- Bootstrap wiring
- Tests for monitor pipeline, threshold tuning, relevance polling

### Out of scope (future work)

- CEO direct participation in threads
- Thread summarization for context management
- Multiple expertise embeddings per agent (one is sufficient for now)
- Monitor dashboard / admin UI for viewing threshold history
- Cross-thread learning (using insights from one thread to inform another)

## Testing Strategy

- **Unit tests** for `BullpenMonitor`: embedding comparison, threshold checking,
  debouncing, suggestion publication
- **Unit tests** for threshold tuning: hit rate calculation, threshold adjustment
  direction, clamping at bounds, persistence round-trip
- **Integration test**: active thread with two agents, third agent's expertise
  matches a message, monitor suggests addition, coordinator adds
- **False positive test**: thread content that doesn't match any non-participant's
  expertise produces no suggestions
- **Persistence test**: thresholds survive service restart, resume from last tuned value
