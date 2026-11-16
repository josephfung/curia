# 01 — Memory System

## Overview

Four memory tiers + inter-agent discussion, all backed by PostgreSQL + pgvector. Memory is the framework's competitive advantage — it's what makes agents contextually aware across conversations, tasks, and time.

> **Related:** agents also have a fifth, deliberately *ungated* working surface — the OKF document workspace (freeform, mutable working documents) — kept separate from these four validated tiers. See [spec 20 — Agent Document Workspace](20-agent-document-workspace.md).

---

## Tier 1: Working Memory (per-conversation ephemeral)

Short-lived context for active agent conversations. Stored in the `working_memory` table, scoped to a `conversation_id` (the deterministic, reversible channel-scoped key described in [spec 04](04-channels.md); stored as TEXT — see ADR-025). Holds conversation turns as `role`/`content`. Auto-expires via a configurable TTL (`expires_at`); summarized turns are marked `archived` and excluded from active context loading. Lives in Postgres — survives restarts.

**Table:** `working_memory`
- `id` UUID
- `conversation_id` TEXT
- `agent_id` TEXT
- `role` TEXT
- `content` TEXT
- `created_at` TIMESTAMPTZ
- `expires_at` TIMESTAMPTZ
- `archived` BOOLEAN — excludes summarized turns from active context loading (migration 018)
- `sender_contact_id` UUID NULL — contact who authored a `user` turn (migration 090). Assistant and system turns leave it null. Deleting the contact sets it null.
- `channel_id` TEXT NULL — inbound channel, used to label cross-conversation recall (migration 090)
- `injected_into_task_id` TEXT NULL — the host `agent.task` id when this user row was drained into a live turn (migration 106, [ADR-053](../adr/053-turn-lanes-and-mid-turn-injection.md)). Null is a normal turn. Model history keeps that row with the user row it followed, so the follow-up does not replace the original. Contact-recent history does not read the column.

---

## Tier 2: The Bullpen (inter-agent discussion)

Shared workspace where agents — and the user — have structured, threaded conversations:
- Any agent can open a thread addressed to other agents
- Flows through the bus as `agent.discuss` events (same security model)
- Threaded and async — agents subscribe to `agent.discuss` events and respond when addressed. The dispatcher also checks for pending Bullpen threads when routing any `agent.task`, ensuring agents see discussion messages even if they only activate via inbound user messages. That injection looks back seven days (the `BULLPEN_PENDING_WINDOW_MINUTES` constant in `src/memory/bullpen.ts`, not an environment variable; [ADR-043](../adr/043-bullpen-pending-window.md)): an open thread the agent has not seen, and did not author the latest message on, stays pending across that window so a missed `agent.discuss` dispatch can be recovered on a later interactive or bullpen-origin wake. One of the five slots is the oldest thread outside the four newest that has not already been shown; if every such thread was already shown, the slot is the oldest of them. Scheduler-channel tasks do not inject the tier (#1609). The block tells the model to answer in-thread. Message stamps use the principal's local offset. An ambient @mention stays pending the first time a wake leaves it untouched, and is marked seen if those same messages are shown again with no reply, close, or other action (#1901). A later message that does not @mention the agent does not clear an earlier unanswered mention. The mark stops at the newest message that was shown. The thread a bullpen-origin wake was opened for is marked seen even if the agent does not reply.
- **Peer requests.** Any agent can ask another a question in its area with a message headed `PEER REQUEST` that states `Need:`, `Scope:` and any constraints, which the answerer treats as binding. The answer is a `PEER REPLY` with `Result: ok | nothing | error`, so "looked and found nothing" is distinct from "could not look". The protocol is injected only when a pending message contains `PEER REQUEST` (`PEER_REQUEST_PROTOCOL_LINES` in `src/memory/bullpen.ts`); a peer has no principal authority, and a `PEER REPLY` is exempt from the `close_after` convention because the asker closes the thread.
- All threads are logged, auditable, and visible to the user via dashboard
- Dispatcher can mediate stuck discussions or escalate to user

### User Participation

The CEO can participate in Bullpen threads:
- **Observe** — all threads are visible via the dashboard SSE stream or HTTP API
- **Intervene** — send a message to a thread via any channel (e.g., `@bullpen: focus on Q2 expenses, not Q1`) or the dashboard. The dispatcher translates this into an `agent.discuss` event with `sender: "user"`.
- **Start threads** — ask a question that multiple agents respond to (e.g., `@bullpen: what does everyone know about this vendor?`)

User messages in the Bullpen carry the same audit trail as any other event. The `sender` field distinguishes user messages from agent messages.

**Tables:**
- `bullpen_threads` — id, topic, participants (TEXT[]), status, created_at
- `bullpen_messages` — id, thread_id, sender_type (TEXT: "agent" | "user"), sender_id (TEXT), content (JSONB), created_at

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
- `embedding` VECTOR(n) — for semantic search via pgvector; `n` is the configured profile's width, at most 2,000
- `embedding_model` TEXT — the stamp of the profile that produced `embedding` (see Model stamp below); set exactly when `embedding` is
- Temporal metadata (see below)

**Edges** (`kg_edges`):
- `id` UUID
- `source_node_id` UUID (FK → kg_nodes)
- `target_node_id` UUID (FK → kg_nodes)
- `type` TEXT — `works_on`, `decided`, `attended`, `relates_to`, etc.
- `properties` JSONB
- Temporal metadata (see below)

Queried via recursive CTEs for traversal (e.g., "all decisions about Project X involving Person Y"). For launch, depth-limited to 3 hops. If graph traversal performance becomes an issue, introduce materialized views or caching as a future optimization.

The `decision` node type and `decided` edge type record decisions Curia *learned about* ("the board decided to raise in Q3"), written by LLM extraction like any other entity. Decisions Curia makes or must enforce are relational state, not graph knowledge ([ADR-039](../adr/039-decisions-in-the-ledger-not-the-knowledge-graph.md)).

### Deferred

Considered and deliberately not built. Each has a trigger: revisit when it fires, not before.

- **Validity intervals.** Nodes and edges record when Curia learned or last confirmed something (`created_at`, `last_confirmed_at`), not when it was true in the world (e.g. employment from 2019 to 2022). Freshness is folded into `confidence` by decay (see Temporal Metadata). Superseded fact values survive in `properties.previous_values`. *Revisit when* an agent acts on a fact or relationship that was once true and no longer is, and decay did not catch it.
- **Edge sensitivity.** `sensitivity` lives on nodes only. An edge has none of its own. *Revisit when* a relationship itself (e.g. `invested_in`, `spouse`) needs protection its endpoints do not carry, in an export or outbound path.
- **Subtypes and participation roles.** The node and edge vocabularies are flat: no event subtypes such as meeting vs deadline, and no invited vs attended distinction. Nothing reads the graph for those distinctions today. *Revisit when* a skill must answer a question that depends on them from the graph.

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

**Decay.** The DreamEngine (`src/memory/dream-engine.ts`) runs a daily pass that halves `confidence` per half-life since the node or edge was last confirmed or decayed: 180 days for `slow_decay`, 21 for `fast_decay`, never for `permanent` (`dreaming.decay` in `config/default.yaml`). Nodes and edges at or below `archiveThreshold` (0.05) are archived, as are edges whose endpoint was archived. An important node (high sensitivity or high connectivity) is warned first and held for `warnHoldBackDays` (7) before archiving. Contact-anchored nodes are never decayed or archived ([ADR-040](../adr/040-contact-anchored-kg-node-identity.md)). Re-asserting an edge or entity node raises its `confidence` to at least the incoming value. Re-asserting an identical fact only merges its properties, so its confidence keeps decaying (#2626).

---

## Embedding Layer

Key facts and node descriptions are embedded and stored in pgvector with an HNSW index. Enables semantic search across the knowledge graph: "find everything related to our fundraising strategy" even if "fundraising" doesn't appear in node labels. ADR-051 records the design, and ADR-065 the bundled default model.

**Source.** `resolveEmbedding()` (`src/memory/embedding.ts`) picks one source at boot. With no `EMBEDDING_BASE_URL`, it is the **bundled model**: `all-MiniLM-L6-v2` (int8 ONNX, 384 dimensions), shipped in the image and run in-process through `onnxruntime-node` (`src/memory/embedding-onnx.ts`), with no key and no network call. With a base URL, it is that server, which speaks OpenAI's `/embeddings` API, with `EMBEDDING_MODEL`'s profile and the vault's `embedding_api_key` when the server checks a key. OpenAI is configured this way like any other server. An install whose graph already holds another model's vectors is never switched to the bundled model unless `EMBEDDING_MODEL=all-MiniLM-L6-v2` says so; without its endpoint settings, entity memory stays off with the reason logged. One deprecated exception keeps the old implicit default working for a graph holding `text-embedding-3-small` vectors: no base URL and `openai_api_key` in the vault still mean OpenAI, with a deprecation warning at boot (removal tracked in #2628). When entity memory is off for any reason, the sensitivity classifier and the setup wizard are off with it.

**Bundled weights.** `models/embedding/manifest.json` pins the Hugging Face revision and the sha256 of each file. The Docker build fetches and verifies them; a source checkout runs `pnpm fetch:embedder`. `EMBEDDING_MODEL_DIR` points elsewhere. Missing or unloadable files keep entity memory off with a reason; nothing is ever downloaded at runtime.

**Profiles.** Each model has a profile in `src/memory/embedding-profiles.ts`: the width to store, a text prefix for each purpose (`query` for a search, `document` for a stored label, `similarity` for a label matched against stored labels), and the three thresholds that fact dedup and fuzzy entity resolution use. `text-embedding-3-small`, `Qwen3-Embedding-4B` and `all-MiniLM-L6-v2` are built in. A profile can also name a pooling strategy (`mean` for the bundled model), which only a built-in profile sets. An operator adds or overrides one under `embedding.profiles` in `config/local.yaml`. A model with no profile leaves entity memory off, because thresholds from another model would merge distinct people and facts. `scripts/embedding-eval.ts` (`pnpm embedding-eval`) calibrates a profile against the fixture in `tests/fixtures/embedding-eval/`.

**Model stamp.** Every vector is stored with a stamp in `embedding_model`. The stamp is the model name when the profile's `document` prefix is empty. Otherwise it is the model name plus a short hash of that prefix, because stored vectors keep the prefix they were embedded with. `embeddingStamp()` in `src/memory/embedding-profiles.ts` computes it. Search and dedup compare only vectors that carry the configured profile's stamp. A bundled profile's stamp also carries a short hash of the weight file actually loaded (`all-MiniLM-L6-v2#weights:afdb6f1a0e45`), so other weights under the same model name read as a model change. A model served by an endpoint stamps without a weights hash.

**Identifier guard.** Before a fuzzy candidate auto-resolves and before a fact merges in dedup, `hasConflictingIdentifiers()` (`src/memory/identifier-guard.ts`) compares the identifier tokens of the two labels (long digit runs and long alphanumeric ids). When both carry tokens and neither set is a subset of the other, the pair is not treated as the same, whatever its score. It applies to every model.

**Drift check.** For an endpoint source, the stored vectors are the baseline: boot re-embeds 5 stored labels and compares them with their stored vectors (`src/memory/embedding-drift.ts`). A minimum cosine of 0.995 or more is the same weights. Between 0.9 and 0.995 the weights shifted and entity memory stays on, reported in health. Below 0.9 they changed, and entity memory stays off until `pnpm reembed:kg --force`. An unreachable endpoint never blocks boot; the daily embeddings canary retries the check.

**Health.** `/api/health` reports `checks.knowledge_graph` and, when there is one, the reason in `details.knowledge_graph` (spec 08).

**Boot gate.** At boot Curia compares the column's declared width and the stored stamps with the profile, and checks `kg_reembed_runs` for an unfinished re-embed. When no row holds a vector, Curia resizes the column itself. Otherwise a width mismatch, a stamp mismatch (another model or `document` prefix) or an open run turns entity memory off, and the log names `pnpm reembed:kg`.

**Re-embed.** `pnpm reembed:kg` resizes the column, rebuilds the index and re-embeds every node, archived ones included. It records the run in `kg_reembed_runs` before it clears any vector and closes the run when it finishes, so an interrupted run keeps entity memory off until a rerun completes it. `--dry-run` reports what would change. `--force` re-embeds every row even when its stamp already matches, the recovery from a drift finding.

**Instance lock.** Curia holds a session-level Postgres advisory lock for its lifetime. The re-embed command takes the same lock first, and exits naming the holder when a running Curia has it. If Curia boots while the command holds the lock, the knowledge graph stays off and the log says to restart Curia when the command finishes. The schema gate recognises the command by the application name it sets, `curia-reembed-kg`. A second Curia process, or any other holder, gets a warning at boot, and Curia continues without the lock. If the lock's connection drops, Curia logs an error and runs on without the lock until it restarts, so the command could run beside it in that time.

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
- Same entity + similar label (fuzzy match via embedding cosine similarity at or above the profile's `fact_dedup` threshold: 0.95 for the bundled `all-MiniLM-L6-v2`, 0.92 for `text-embedding-3-small`), unless the identifier guard finds conflicting identifiers
- If duplicate found: update `last_confirmed_at` and merge properties instead of creating a new node

### Contradiction Detection
Before writing a fact that updates an entity attribute (e.g., "the CEO lives in Toronto" when "the CEO lives in Kitchener" exists):
- Check for existing facts on the same entity with the same attribute type
- **Multi-valued facts** (`StoreFactOptions.multiValued: true`, e.g. a person's several email addresses): same attribute with different `value` properties are independent facts, not contradictions. Same attribute + same value still deduplicates normally. Callers persist `properties.multi_valued: true` so subsequent unrelated writes cannot silently merge into them. (Introduced for `dedup_exclusion` in #1623; exclusions moved to the `contact_dedup_exclusions` table in #1625 — see ADR-039 for the ledger-vs-KG boundary rule — but the flag remains a general primitive.)
- **Exact-key facts** (`StoreFactOptions.exactKey: true`, used by config-store): skip embedding similarity. Match an existing fact only when `properties.key` equals the incoming key exactly (or adopt a legacy label-only fact with that label); otherwise create. Opaque identifiers that share a stem (`foo_1` / `foo_2`, recurring `seen:<id>_<date>`) must never merge (#2252). Persists `properties.exact_key: true` so a later semantic write without the flag (e.g. `mergeEntities`) cannot merge into the fact. Requires a string `properties.key` (throws if missing). On a key match the node's label is realigned to the key. The fixed source `system:config-store` is exempt from the per-task write rate limit; other `system:` sources (e.g. checkpoint extraction) stay capped.
- If contradicting fact exists with higher confidence: reject the write, log the conflict
- If contradicting fact exists with lower confidence: update the existing fact, preserve the old value in `properties.previous_values` for audit
- If contradicting fact exists with equal confidence: flag for human review via the alert channel

Known gaps, under investigation in #2626:
- Resolution compares confidence only. A genuine update is discarded, not retried, while an older fact still holds higher confidence, which can last months for `slow_decay` facts.
- Attribute keys are LLM-chosen. Keys in the contact canonical-field map (`src/contacts/canonical-attribute-guard.ts`) go to the contact record, but synonyms outside it (e.g. `role` / `position`), or on entities with no contact, are never compared.
- Re-asserting an identical fact does not refresh its confidence, so a repeatedly confirmed fact still decays to archive.
- An equal-confidence conflict from `extract-facts` is only logged, not sent to the alert channel. `memory-store` returns the conflict to the calling agent.

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

The tool definitions sent with the call are charged as a required tier, `tool_definitions`, right after sender context. They are often the largest fixed component of a call, so they are counted in `context.budget` and reduce what is left for bullpen, resolved entities and history. They are charged after sender context so a long tool list can never push out the sender's authorization block. Only the first round's tool list is charged; tools discovered mid-turn are not.

Contacts resolved during a conversation are not part of working-memory history (tool results are not persisted). Their contact IDs are stored on the conversation and re-read from the contact row at the start of each later turn. That block is its own context-budget tier, `resolved_entities`, capped in size and charged before history so a long transcript cannot crowd the identities out. An outbound message to someone other than the principal is blocked when it carries an unconfirmed-name hedge, or an unresolved name next to an invitation or attendance cue. Other names are not blocked. `filter.identityGate` selects `enforce` (default), `shadow` (log only), or `off`.

Recent activity with the current contact from *other* conversations is a separate tier, `contact_recent_history`. The read lives in working memory and is keyed by `sender_contact_id`. The window resolves per inbound channel. The rows themselves stay cross-channel: an email reply can recall Signal, SMS, and voice turns inside that window, and a voice call can recall email. A channel that does not name one uses the start of the local day, or a rolling 24 hours when the configured timezone is not a valid IANA zone. Email uses 72 hours and voice uses 48 hours. Those longer windows parallel the outbound-context auto-registration TTL (`CHANNEL_DEFAULT_EXPIRY_HOURS`, [spec 11](11-entity-context-enrichment.md#ttl-configuration)): email correspondence runs on business days, so a next-morning reply is already past a single local day, and 72 hours reaches a Friday-afternoon message on Monday morning when that message is still among the 8 newest turns. Newer turns on any channel can fill that cap and drop the older email. Voice keeps 48 hours — about two calendar days, which covers a call from the previous day in almost all cases; a DST fall-back weekend can leave a call from the start of yesterday just outside — without holding a business week of calls. The block header names the window the read actually queried, and each turn stamp includes the calendar day, so a multi-day block cannot claim to be "today". It is charged only after `resolved_entities` and the active transcript, and dropped when it does not fit. User turns are limited to that contact. Assistant and summary turns are included only from conversations where that contact is the sole attributed sender, so a group or a CC'd thread cannot leak another participant's words. A synthetic user turn does not count as another participant. Several paths re-enter an agent by writing a task brief that lands as a `user` row with a null sender — the voice opening cue, the outbound content-filter rewrite brief, a late specialist result, and the secret-capture resume. Each declares itself: `agent.task` carries `syntheticTurn`, the runtime forwards it, and it is stored as `working_memory.synthetic`, which both the recall read and the sender backfill test. A path that does not set it defaults to `false` and is treated as a participant's words, which is the fail-closed direction. The flag is never inferred from message content: a body is attacker-controlled, so a crafted inbound message could otherwise drop its own conversation from the shared check and push assistant replies that quote its sender into another contact's recall block. Migration 092 classifies the rows stored before the column existed, which is the one place content matching is used and the only place it is safe. The tier is injected only when the reply stays with that contact: a Signal direct chat, SMS, a Slack DM, a two-party email where one address is an owned mailbox, a console session, or a voice call. An email whose headers do not include an owned mailbox (BCC, alias, forward) does not receive it. Each turn body is JSON inside `<untrusted_turn_json>` and is data, not an instruction. Voice runs the same read inside its history deadline and, on timeout, continues with the live transcript only. Migration 090 stamps seven days of Signal 1:1, SMS, and voice rows at boot. Older Signal 1:1 and SMS rows are stamped after boot, in batches, so an archived null sender cannot hide that thread's replies. Neither pass stamps a row flagged `synthetic`: a conversation id names the human peer, but not every user row in the thread is theirs. Migration 092 clears any such stamp left by an earlier run of 090, and the backfill logs `syntheticRowsRemaining`, the standing count of synthetic Signal and SMS rows that are still unstamped. A caught-up boot can report a non-zero remainder while stamping nothing. If the exclusion stops working, those rows get stamped and the remainder falls. Slack threads and Signal groups are not backfilled: there a null sender is how a multi-party thread stays closed. Email is backfilled out of band by `pnpm run backfill:email-senders` ([ADR-042](../adr/042-email-sender-attribution-from-the-audit-log.md)), which recovers each turn's sender from the `inbound.message` audit row whose content it contains. It is a one-off for databases that predate migration 090 — a new install stamps on write and never needs it — so it ships as a script rather than a boot path, and it runs dry by default. A turn it cannot attribute unambiguously is left null, which keeps its thread shared exactly as before.

### Context Summarization
When conversation history in working memory exceeds a configurable threshold (default: 20 turns), older turns are summarized into a condensed narrative and the originals are archived (still in Postgres, just not loaded into context). The summary preserves: key decisions made, entities discussed, and any commitments or action items. A write that passes `summarize: background` — voice turns do — returns once the new turn is stored, and the pass runs in the background so the spoken reply is not held for the condensation call. Other writes wait for the pass. Passes for the same conversation and agent run one at a time. Shutdown waits briefly for an in-flight pass before the database pool closes.

### Intent Anchor
*Lesson from Zora's ASI gaps: agents drift from their original task during extended operations.*

When a persistent task is created, the original task description is stored as an **intent anchor** in the task record. On each burst execution, the intent anchor is included in the system prompt as a grounding reference. The agent can evolve its approach, but the anchor prevents wholesale drift from the original goal.
