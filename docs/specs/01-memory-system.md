# 01 — Memory System

## Overview

Four memory tiers + inter-agent discussion, all backed by PostgreSQL + pgvector. Memory is the framework's competitive advantage — it's what makes agents contextually aware across conversations, tasks, and time.

---

## Tier 1: Working Memory (per-task ephemeral)

Short-lived context for active agent tasks. Stored in `working_memory` table, scoped to a task ID. Holds conversation turns, intermediate results, tool outputs. Auto-expires on task completion (configurable TTL for reactive conversations). Lives in Postgres — survives restarts.

**Table:** `working_memory`
- `id` UUID
- `task_id` UUID
- `agent_id` TEXT
- `key` TEXT
- `value` JSONB
- `created_at` TIMESTAMPTZ
- `expires_at` TIMESTAMPTZ

---

## Tier 2: The Bullpen (inter-agent discussion)

Shared workspace where agents have structured, threaded conversations:
- Any agent can open a thread addressed to other agents
- Flows through the bus as `agent.discuss` events (same security model)
- Threaded and async — agents subscribe to `agent.discuss` events and respond when addressed. The dispatcher also checks for pending Bullpen threads when routing any `agent.task`, ensuring agents see discussion messages even if they only activate via inbound user messages.
- All threads are logged, auditable, and visible to the user via dashboard
- Dispatcher can mediate stuck discussions or escalate to user

**Tables:**
- `bullpen_threads` — id, topic, participants (TEXT[]), status, created_at
- `bullpen_messages` — id, thread_id, agent_id, content (JSONB), created_at

---

## Tier 3: Entity Memory (configurable facts)

A specialized view over the knowledge graph for key facts about people, projects, and preferences. Agents query: "what do I know about [entity]?" → returns connected facts with confidence and freshness.

Entity memory is stored as `kg_nodes` with type `fact`, linked to relevant entity nodes via edges. This is a query pattern over the knowledge graph, not a separate store.

---

## Tier 4: Knowledge Graph (long-term relationships)

Stored as nodes + edges in Postgres:

**Nodes** (`kg_nodes`):
- `id` UUID
- `type` TEXT — `person`, `organization`, `project`, `decision`, `event`, `concept`, `fact`
- `label` TEXT
- `properties` JSONB — flexible attributes
- `embedding` VECTOR(1536) — for semantic search via pgvector
- Temporal metadata (see below)

**Edges** (`kg_edges`):
- `id` UUID
- `source_node_id` UUID (FK → kg_nodes)
- `target_node_id` UUID (FK → kg_nodes)
- `type` TEXT — `works_on`, `decided`, `attended`, `relates_to`, etc.
- `properties` JSONB
- Temporal metadata (see below)

Queried via recursive CTEs for traversal (e.g., "all decisions about Project X involving Person Y"). For launch, depth-limited to 3 hops. If graph traversal performance becomes an issue, introduce materialized views or caching as a future optimization.

---

## Temporal Metadata

Every fact and relationship carries:
- `created_at` TIMESTAMPTZ — when first recorded
- `last_confirmed_at` TIMESTAMPTZ — last time evidence reinforced this
- `confidence` FLOAT — 0-1 scale
- `decay_class` TEXT — `permanent` | `slow_decay` | `fast_decay`
  - `permanent`: birth city, legal name — never decays
  - `slow_decay`: employer, residence — reliable for months/years
  - `fast_decay`: coffee preference, current focus — unreliable after weeks
- `source` TEXT — which agent/channel/interaction created it

**For launch:** `decay_class` is stored but not acted on. A decay engine can be added later to reduce confidence over time based on class.

---

## Embedding Layer

Key facts and node descriptions are embedded via OpenAI `text-embedding-3-small` (1536 dimensions) and stored in pgvector with HNSW index. Enables semantic search across the knowledge graph: "find everything related to our fundraising strategy" even if "fundraising" doesn't appear in node labels.

Embeddings are generated:
- On node/fact creation
- On significant property updates
- Not on every access (read-path doesn't re-embed)

---

## Memory Validation Gates

*Lesson from Zora: without validation, agents pollute memory with redundant, contradictory, or low-quality facts.*

All writes to entity memory and the knowledge graph pass through validation:

### Deduplication
Before creating a new fact node, check for existing nodes with:
- Same entity + similar label (fuzzy match via embedding cosine similarity > 0.92)
- If duplicate found: update `last_confirmed_at` and merge properties instead of creating a new node

### Contradiction Detection
Before writing a fact that updates an entity attribute (e.g., "Joseph lives in Toronto" when "Joseph lives in Kitchener" exists):
- Check for existing facts on the same entity with the same attribute type
- If contradicting fact exists with higher confidence: reject the write, log the conflict
- If contradicting fact exists with lower confidence: update the existing fact, preserve the old value in `properties.previous_values` for audit
- If contradicting fact exists with equal confidence: flag for human review via the alert channel

### Rate Limiting
- Max 50 memory writes per agent per task execution (prevents runaway memory pollution)
- Exceeded writes are dropped with a warning in the audit log

### Source Attribution
Every memory write records the full provenance chain: which agent, triggered by which task, from which channel/conversation. This enables tracing why the system believes something.

---

## Context Management

*Lesson from Zora: agents that exceed context windows fail silently or lose critical information.*

When assembling context for an LLM call, the agent runtime manages context window usage:

### Context Budget
Each LLM call has a context budget (model's max tokens minus a reserve for the response). The agent assembles context in priority order:

1. **System prompt** (always included, non-negotiable)
2. **Active task context** (current conversation turns from working memory)
3. **Relevant entity memory** (facts about entities mentioned in the current task)
4. **Bullpen threads** (pending discussions addressed to this agent)
5. **Knowledge graph context** (semantic search results relevant to the task)

If the total exceeds the budget, items are trimmed from the bottom of the priority list. Within each tier, older/less-relevant items are dropped first.

### Context Summarization
When conversation history in working memory exceeds a configurable threshold (default: 20 turns), older turns are summarized into a condensed narrative and the originals are archived (still in Postgres, just not loaded into context). The summary preserves: key decisions made, entities discussed, and any commitments or action items.

### Intent Anchor
*Lesson from Zora's ASI gaps: agents drift from their original task during extended operations.*

When a persistent task is created, the original task description is stored as an **intent anchor** in the task record. On each burst execution, the intent anchor is included in the system prompt as a grounding reference. The agent can evolve its approach, but the anchor prevents wholesale drift from the original goal.
