# 10 — Audit Log Hardening

*The existing audit system (spec 06) captures every bus event in an append-only, write-ahead log with causal tracing. This spec levels it up to meet industry standards for governance, regulatory compliance, and AI-specific auditability — informed by NIST AI RMF, EU AI Act, OWASP LLM Top 10, CADF, SOC 2, and W3C PROV.*

## Motivation

Curia's audit log already does the hard structural work: write-ahead persistence, append-only guarantees, causal chains via `parent_event_id`, and secret redaction. What it lacks is:

1. **Field richness** — events store a JSONB blob but don't expose structured who/what/why fields for fast querying
2. **LLM provenance** — no record of which model version produced which output, or what it cost
3. **Tamper evidence** — append-only by convention, but not cryptographically verifiable
4. **Source attribution** — causal event chains exist, but there's no record of which knowledge graph entities or memory records informed a decision
5. **Human-in-the-loop records** — approval/rejection decisions are logged as events, but don't capture the full decision context (who approved, what they saw, how long they deliberated)

These gaps matter because regulators, auditors, and future-us-doing-incident-response all need answers that the current schema can't efficiently provide.

---

## Schema Evolution

### New Columns on `audit_log`

Add structured, indexed columns alongside the existing JSONB `payload`. The payload remains the full event record; these columns are denormalized for queryability.

```sql
ALTER TABLE audit_log
  ADD COLUMN action         TEXT,            -- controlled vocabulary (see Action Taxonomy below)
  ADD COLUMN outcome        TEXT,            -- 'success' | 'failure' | 'pending' | 'denied' | 'error'
  ADD COLUMN target_type    TEXT,            -- resource type acted upon (e.g., 'contact', 'kg_node', 'email', 'skill')
  ADD COLUMN target_id      TEXT,            -- identifier of the target resource
  ADD COLUMN initiator_type TEXT,            -- 'human' | 'agent' | 'system' | 'scheduler'
  ADD COLUMN initiator_id   TEXT,            -- specific actor (sender email, agent name, 'scheduler')
  ADD COLUMN entry_hash     TEXT;            -- SHA-256 hash of this record + previous hash (see Tamper Evidence)

CREATE INDEX idx_audit_action ON audit_log (action);
CREATE INDEX idx_audit_outcome ON audit_log (outcome) WHERE outcome IS NOT NULL;
CREATE INDEX idx_audit_target ON audit_log (target_type, target_id) WHERE target_type IS NOT NULL;
CREATE INDEX idx_audit_initiator ON audit_log (initiator_type, initiator_id) WHERE initiator_type IS NOT NULL;
```

**Migration strategy:** These columns are all nullable. Existing rows get `NULL` values. New events populate them via the audit logger's field extraction logic (see below). No backfill required — the JSONB payload retains the full record for historical events.

### Field Extraction

The audit logger extracts structured fields from each event payload before INSERT. Extraction rules are deterministic and based on event type:

| Event Type | `action` | `outcome` | `target_type` / `target_id` | `initiator_type` / `initiator_id` |
|---|---|---|---|---|
| `inbound.message` | `receive` | `success` | `conversation` / conversationId | `human` / senderId |
| `agent.task` | `delegate` | `pending` | `agent` / agentId | `system` / `dispatch` |
| `agent.response` | `respond` | `success` | `conversation` / conversationId | `agent` / agentId |
| `outbound.message` | `send` | `success` | `conversation` / conversationId | `system` / `dispatch` |
| `skill.invoke` | `execute` | `pending` | `skill` / skillName | `agent` / agentId |
| `skill.result` | `execute` | from `result.success` | `skill` / skillName | `agent` / agentId |
| `memory.store` | `create` | `success` | `kg_node` / nodeId | `agent` / agentId |
| `memory.query` | `read` | `success` | `knowledge_graph` / queryType | `agent` / agentId |
| `contact.resolved` | `resolve` | `success` | `contact` / contactId | `system` / `dispatch` |
| `contact.unknown` | `resolve` | `failure` | `contact` / senderId | `system` / `dispatch` |
| `message.held` | `hold` | `pending` | `message` / heldMessageId | `system` / `dispatch` |

**Design note on `outbound.message` initiator:** The initiator is attributed to `system/dispatch` because the dispatch layer performs the send. To find the upstream agent that composed the response, follow the `parent_event_id` chain back to the `agent.response` event. This keeps the extraction logic simple (no parent lookups) while the causal chain preserves full attribution for deeper queries.

This extraction happens in the audit logger, not in the event factories. The event factories remain unchanged — they produce domain events, not audit records. The audit logger is the translation layer.

### Extraction Failure Policy

If a mapped payload field is missing or has an unexpected type, the audit logger:
1. Sets the structured column to `'[EXTRACTION_FAILED]'` (not NULL — distinguishes extraction failures from pre-migration rows which are NULL)
2. Logs a warning via pino with the event ID and the field that failed
3. Still writes the audit row (never drops an event due to extraction failure — the JSONB payload is always the source of truth)

For event types not in the extraction mapping table (e.g., future event types added before the mapping is updated), all structured columns are NULL. This is expected, not an error — but the audit logger logs a `debug`-level message noting the unmapped event type so it's discoverable.

### Action Taxonomy

A controlled vocabulary for the `action` column. Inspired by CADF and FHIR AuditEvent's C/R/U/D/E model, extended for agent-specific actions:

| Action | Meaning |
|---|---|
| `create` | New resource created (KG node, contact, scheduled job) |
| `read` | Resource queried or retrieved |
| `update` | Existing resource modified |
| `delete` | Resource removed |
| `execute` | Skill or tool invoked |
| `delegate` | Task routed to an agent |
| `respond` | Agent produced a response |
| `send` | Outbound message delivered |
| `receive` | Inbound message accepted |
| `resolve` | Identity or contact resolution attempted |
| `hold` | Message held pending human review |
| `approve` | Human approved a pending action |
| `deny` | Human denied a pending action |
| `authenticate` | Authentication attempted |
| `escalate` | Action escalated to human oversight |
| `configure` | System configuration changed |

New actions can be added as new event types are introduced. The `action` column is a TEXT field, not an enum, to avoid migration churn.

---

## LLM Call Provenance

*Required by NIST AI 600-1, EU AI Act Article 12, OWASP LLM Top 10 (LLM10).*

Every LLM API call made by the agent runtime must produce a structured provenance record in the audit log. This is a new event type, not a modification to existing events.

### New Event Type: `llm.call`

```typescript
interface LlmCallPayload {
  agentId: string;
  conversationId: string;
  // Model provenance — what was requested vs. what actually ran
  requestedModel: string;       // e.g. 'claude-sonnet-4-20250514'
  actualModel: string;          // from the API response (may differ if provider aliases)
  provider: string;             // 'anthropic' | 'openai' | 'ollama'
  // Token accounting
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;     // computed from provider pricing at call time
  // Timing
  latencyMs: number;
  // Upstream correlation — enables cross-referencing with the provider's own audit logs
  providerRequestId: string;    // Anthropic: x-request-id header; OpenAI: x-request-id header
  // Content fingerprints — not the full prompt/response (those go in a separate table),
  // but enough to verify integrity
  promptHash: string;           // SHA-256 of the full prompt (system + messages + tools)
  responseHash: string;         // SHA-256 of the full response content
}
```

The `llm.call` event is published by the agent runtime after every LLM API call completes. Its `parentEventId` references the `agent.task` event that triggered it. Multiple `llm.call` events can trace to the same task (multi-turn tool-use loops produce one per LLM round-trip).

### Bus Layer Permissions for New Event Types

These new event types require updates to the layer permissions table in [spec 06](06-audit-and-security.md):

| Event Type | Publishing Layer | Rationale |
|---|---|---|
| `llm.call` | `agent` | The agent runtime makes LLM calls; add to agent's publish allowlist |
| `human.decision` | `dispatch` | Approval gates are enforced at the dispatch layer |
| `config.change` | `system` | Bootstrap orchestrator runs at system level (already has ALL permissions) |

### Prompt & Response Archive

Full prompts and responses are stored in a separate table, not in the audit log payload. This keeps audit log rows small (fast scans) while preserving full replay capability.

```sql
CREATE TABLE llm_call_archive (
  audit_event_id    UUID PRIMARY KEY REFERENCES audit_log(id),
  prompt            JSONB NOT NULL,       -- full message array as sent to the LLM API
  response          JSONB NOT NULL,       -- full response object from the LLM API
  tool_definitions  JSONB,                -- tool schemas provided in this call (nullable if none)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Transaction atomicity:** The `audit_log` INSERT and `llm_call_archive` INSERT must be in the same database transaction. If either fails, both roll back. This prevents orphaned audit rows that reference a nonexistent archive record. The FK from `llm_call_archive.audit_event_id` to `audit_log.id` points from archive to audit (not the reverse), so when archive rows are purged at retention, no FK violation occurs — the audit_log row outlives the archive row.

**Redaction:** The existing redaction layer processes prompts and responses before archive write. Secrets and PII patterns are stripped per the same rules used for audit log payloads. **If redaction fails** (malformed content, unexpected binary data), the archive write is skipped — never fall back to writing unredacted content. The `audit_log` row for the `llm.call` event is still written (it contains hashes, not raw content). A high-severity error is logged via pino with the event ID and redaction failure reason.

**Retention:** The `llm_call_archive` is large (prompts and responses can be several KB each). Retention policy: 90 days hot (in Postgres), then archived to compressed JSONL on disk. The `audit_log` row (with hashes) is retained per the standard audit retention schedule.

**Why separate tables:** The audit log is optimized for fast, indexed queries ("show me all actions by agent X on contact Y"). Storing multi-KB prompts inline would bloat the table and slow scans. The archive is optimized for replay ("show me exactly what the LLM saw when it made decision Z"). Different access patterns, different tables.

---

## Source Attribution

*Required by EU AI Act Article 12 (reference databases queried), OWASP LLM08 (vector/embedding weaknesses).*

When an agent's response is informed by data retrieved from the knowledge graph, working memory, or contacts database, the audit record must capture which specific sources were consulted. The existing `memory.query` event type captures that a query happened and how many results were returned — but not which results.

### Enriched Memory Query Payload

Extend `MemoryQueryPayload` with a `resultIds` field:

```typescript
interface MemoryQueryPayload {
  agentId: string;
  conversationId: string;
  queryType: string;
  queryParams: Record<string, unknown>;
  resultCount: number;
  // New: specific results returned by the query (for attribution)
  results: Array<{
    id: string;                   // KG node ID, contact ID, or working memory key
    score?: number;               // cosine similarity score (for vector queries; omitted for exact lookups)
  }>;
}
```

This creates a traceable link from any response back to its data sources. Memory queries and LLM calls are siblings under the same `agent.task` parent (memory is queried to assemble context *before* the LLM call). The chain is: `agent.task` → `memory.query` (with `resultIds`) + `llm.call` → `agent.response`. In tool-use loops, the LLM can also trigger additional memory queries mid-conversation, producing nested `llm.call` → `memory.query` → `llm.call` chains. Either way, given a response you can reconstruct exactly which knowledge graph entities informed it by collecting all `memory.query` events that share the same `agent.task` parent.

### Skill Data Access Logging

Skills that read external data (email-reader, calendar-reader, web-fetcher) should include a `sourcesAccessed` field in their `skill.result` payload:

```typescript
// Convention for skill result data when external sources are consulted
interface SkillResultWithSources {
  success: true;
  data: unknown;
  sourcesAccessed?: Array<{
    type: string;       // 'email' | 'calendar_event' | 'url' | 'file'
    identifier: string; // message ID, event ID, URL, path
  }>;
}
```

This is a convention, not a type enforcement — skills are responsible for populating it. The audit log captures whatever the skill returns. Skills that don't access external sources omit the field. To prevent silent omission, skills whose manifests declare external data sources (via a `dataSources` field in `skill.json`) should be validated at test time: a lint/test checks that their results include `sourcesAccessed` when `success: true`.

---

## Tamper Evidence

*Required by NIST SP 800-92, SOC 2 CC7.2, recommended by AuditableLLM (2024).*

### Hash Chain

Each audit log entry includes a SHA-256 hash computed over its content and the previous entry's hash, forming a verifiable chain. Any modification to a historical record invalidates every subsequent hash.

**Computation:**

```
entry_hash = SHA-256(canonical_json({
  id, timestamp, event_type, source_layer, source_id,
  payload, conversation_id, task_id, parent_event_id,
  action, outcome, target_type, target_id,
  initiator_type, initiator_id
}) + previous_entry_hash)
```

- The first entry chains from a fixed genesis constant: `SHA-256("curia-audit-genesis-v1")`
- `canonical_json` sorts keys alphabetically and uses deterministic formatting (no whitespace) to prevent false positive tampering alerts from JSON key-ordering variations
- The `entry_hash` column stores the computed hash of the current record. To chain, the audit logger reads the most recent `entry_hash` value before computing the new one. This means each record's hash incorporates the entire history of the chain — modifying any past record invalidates every hash after it

**Serialization:** All audit writes are serialized through a single writer (the `AuditLogger` instance). This is already the case — the bus's write-ahead hook calls `AuditLogger.log()` sequentially before delivering each event. The hash chain computation reads the previous `entry_hash` and writes the new one in the same INSERT. At current throughput (~425 events/day), serialization has negligible performance impact. If throughput ever becomes a concern, the INSERT can use an advisory lock or CTE to atomically read-then-write without external serialization.

**Bootstrapping:** On startup, the audit logger queries `SELECT entry_hash FROM audit_log ORDER BY timestamp DESC LIMIT 1` to seed the chain. If the table is empty (fresh deployment), the genesis constant is used. This query runs once at boot, before the bus starts accepting events.

**Implementation:** ~30 lines in the audit logger using Node.js native `crypto.createHash('sha256')`. Zero external dependencies.

**Verification:** A CLI command `curia audit verify` walks the chain from genesis, recomputing hashes and reporting the first broken link (if any). This is O(n) over the full audit log — acceptable for periodic verification runs, not for real-time checking.

### Merkle Checkpoints (Future)

For efficient single-entry verification without walking the full chain, periodically compute Merkle tree roots over batches of entries (e.g., every 1000 records or every hour). Store roots in a separate `audit_checkpoints` table. This enables O(log n) verification of any individual entry via a Merkle proof.

For launch, the linear hash chain is sufficient. Merkle checkpoints become valuable when the audit log grows past ~1M entries (~6 years at current rates).

---

## Human-in-the-Loop Decision Records

*Required by EU AI Act Article 14, US Treasury AI RMF (2026), emerging HITL audit standards.*

When a human approves, denies, or reviews an agent action, the audit record must capture the full decision context — not just the outcome.

### New Event Type: `human.decision`

```typescript
interface HumanDecisionPayload {
  // What was decided
  decision: 'approve' | 'deny' | 'modify' | 'escalate' | 'timeout';
  // Who decided
  deciderId: string;            // sender ID of the human who made the decision
  deciderChannel: string;       // channel through which the decision was made
  // What they were deciding on
  subjectEventId: string;       // the audit event ID of the action that required human review
  subjectSummary: string;       // human-readable description of what was being decided
  // Decision context
  contextShown: string[];       // list of information items presented to the human
  rationale?: string;           // optional: reason provided by the human
  // Timing
  presentedAt: Date;            // when the decision was presented to the human
  decidedAt: Date;              // when the human responded
  // What would have happened without intervention
  defaultAction: string;        // 'block' | 'allow' | 'queue' — the system's default if no human responded
  // Autonomy context
  autonomyTier?: string;        // which autonomy tier was in effect (e.g., 'unknown_sender', 'elevated_skill')
}
```

This event type is used for:
- Outbound email approval gate (issue #35)
- Unknown sender identify/dismiss/block decisions
- Elevated skill first-use approval
- Any future human-in-the-loop gate

The `presentedAt` / `decidedAt` timestamps capture time-to-decide, which is relevant for both compliance (EU AI Act's "demonstrable human oversight") and UX analysis (are approval gates too frequent? too slow?).

### Decision Timeout Logging

When a human decision times out (configurable per gate), the system logs a `human.decision` event with `decision: 'timeout'` and `decidedAt` equal to the timeout timestamp. The `defaultAction` field records what the system did in the absence of a human response.

---

## Agent Configuration Change Tracking

*Recommended by ISACA (2025) for agent identity governance.*

When agent YAML configurations change (detected at startup by comparing against a stored hash), emit a `config.change` event:

```typescript
interface ConfigChangePayload {
  configType: 'agent' | 'skill' | 'channel' | 'system';
  configId: string;             // agent name, skill name, channel ID, or 'system'
  previousHash: string;         // SHA-256 of the previous config content
  currentHash: string;          // SHA-256 of the new config content
  changedFields: string[];      // top-level keys that differ (e.g., ['system_prompt', 'error_budget'])
}
```

Full before/after config values are stored in the audit log's JSONB `payload` column directly. Agent YAML files are typically a few KB — well within reason for JSONB, and small enough that a separate archive table isn't warranted. The payload includes `previousConfig` and `currentConfig` fields alongside the `ConfigChangePayload` fields above.

**Detection:** At startup, the bootstrap orchestrator hashes each agent/skill/channel config file and compares against the last `config.change` event for that `configId`. If the hash differs, a new event is emitted. On first boot (no prior events for a `configId`), emit a `config.change` event with `previousHash: 'none'` to capture the initial config state.

**Limitation:** This is startup-only detection. Config files modified on disk while the system is running are not detected until the next restart. If hot-reload is added in the future, the config watcher must also emit change events. This is lightweight (SHA-256 of YAML files) and requires no file-watching infrastructure.

---

## Retention Policy

*Required by EU AI Act Article 19 (6-month minimum), SOC 2 (12-month observation period).*

This section supersedes the retention strategy in [spec 08](08-operations.md). The implementation trigger remains as described there (`audit_log` exceeding 1 GB, estimated ~2029), but the tier definitions below establish the target policy for when that trigger fires:

| Tier | Data | Hot (Postgres, indexed) | Warm (Postgres, partitioned) | Cold (compressed JSONL on disk) |
|---|---|---|---|---|
| **Critical** | `audit_log` rows with `action` in (`approve`, `deny`, `authenticate`, `configure`, `escalate`) | 12 months | 12-36 months | 3+ years |
| **Standard** | All other `audit_log` rows | 6 months | 6-18 months | 18 months - 3 years |
| **Bulk** | `llm_call_archive` (prompts/responses) | 90 days | 90 days - 12 months | 12 months - 3 years |

**Implementation:** Postgres declarative partitioning by month on `audit_log.timestamp`. The partition promotion/demotion is a scheduled job (manual for launch, automated later). Cold storage archival writes partitions to compressed JSONL files in the `ceo-deploy` data volume.

**For launch:** No partitioning needed (volume is too low to matter). The retention tiers define the *policy* — implementation triggers when any tier's hot window is exceeded.

---

## CloudEvents Envelope (Future)

*For interoperability with external SIEM/log aggregation systems.*

When Curia's audit events need to be exported to an external system (Datadog, Grafana Loki, Splunk, or a compliance platform), wrap them in the [CloudEvents v1.0](https://cloudevents.io/) envelope format:

```json
{
  "specversion": "1.0",
  "id": "audit-event-uuid",
  "source": "curia://dispatch/coordinator",
  "type": "io.curia.audit.agent.task",
  "time": "2026-03-28T14:30:00Z",
  "subject": "conversation-uuid",
  "datacontenttype": "application/json",
  "data": { }
}
```

The `cloudevents` npm package (v10, CNCF, actively maintained) provides serialization, deserialization, and protocol bindings. This is an export-time transformation — the internal audit log schema remains unchanged.

**For launch:** Not needed. The single-tenant VPS queries Postgres directly. CloudEvents wrapping becomes relevant when an external log aggregator is added to the deployment.

---

## Standards Alignment Summary

This table maps each change in this spec to the standards that require or recommend it:

| Change | NIST AI RMF | EU AI Act | OWASP LLM | SOC 2 | NIST 800-92 |
|---|---|---|---|---|---|
| Structured audit fields (action, outcome, initiator, target) | -- | Art. 12 | -- | CC7.2 | Yes |
| LLM call provenance (model, tokens, cost, provider ID) | AI 600-1 | Art. 12 | LLM10 | -- | -- |
| Prompt/response archive | AI 600-1 | Art. 12 | LLM01, LLM09 | -- | -- |
| Source attribution (resultIds on memory queries) | -- | Art. 12 | LLM08 | -- | -- |
| Hash-chain tamper evidence | -- | -- | -- | CC7.2 | Yes |
| HITL decision records | -- | Art. 14 | LLM06 | CC7.2 | -- |
| Agent config change tracking | -- | Art. 19 | LLM03 | CC7.2 | Yes |
| Retention tiers | -- | Art. 19 | -- | 12-month | Yes |
| CloudEvents envelope | -- | -- | -- | -- | -- |

---

## Implementation Sequence

This spec is designed to be implemented incrementally. Each phase is independently valuable.

### Phase A: Structured Fields + LLM Provenance

1. Migration: add `action`, `outcome`, `target_type`, `target_id`, `initiator_type`, `initiator_id` columns to `audit_log`
2. Field extraction logic in `AuditLogger.log()` (the mapping table above)
3. New `llm.call` event type in `events.ts` + emission from `agents/llm/` providers
4. Migration: create `llm_call_archive` table
5. Archive write logic in the agent runtime (after each LLM call)

**Validates:** NIST AI 600-1 model provenance, EU AI Act Article 12, OWASP LLM10, SOC 2 CC7.2 structured logging.

### Phase B: Tamper Evidence + Source Attribution

6. Migration: add `entry_hash` column to `audit_log`
7. Hash chain computation in `AuditLogger.log()` (~30 lines)
8. `curia audit verify` CLI command
9. Extend `MemoryQueryPayload` with `results` array (id + optional score)
10. `sourcesAccessed` convention for skill results

**Validates:** NIST 800-92 integrity, SOC 2 CC7.2 tamper detection, EU AI Act Article 12 reference data tracking.

### Phase C: HITL Records + Config Tracking

11. New `human.decision` event type + emission from approval gates
12. New `config.change` event type + detection at startup
13. Retention tier definitions in config (policy, not enforcement)

**Validates:** EU AI Act Article 14 human oversight, Article 19 retention, ISACA agent identity governance.

### Phase D: Operational Maturity (Future)

14. Postgres declarative partitioning on `audit_log`
15. Cold storage archival job
16. CloudEvents export adapter
17. Merkle checkpoints

---

## Implementation Completion Status

| Item | Status |
|---|---|
| Migration: structured columns on `audit_log` (`action`, `outcome`, `target_type`, `target_id`, `initiator_type`, `initiator_id`) | Not Done |
| Field extraction logic in `AuditLogger.log()` | Not Done |
| `llm.call` event type added to `events.ts` | Done (#187) |
| LLM providers emit `llm.call` events with provenance fields | Not Done |
| `llm_call_archive` table created and populated | Not Done |
| Redaction applied to prompt/response archive writes | Not Done |
| `entry_hash` column added and hash chain computed on every write | Not Done |
| `curia audit verify` CLI command implemented and tested | Not Done |
| `MemoryQueryPayload` extended with `results` array (id + optional score) | Not Done |
| `sourcesAccessed` convention documented and adopted in existing skills | Not Done |
| `human.decision` event type added and emitted from approval gates | Not Done |
| `config.change` event type added and emitted at startup | Done |
| Retention tiers defined in `config/default.yaml` | Not Done |
| All new event types covered by tests | Not Done |
| Hash chain verification tested (insert, verify, detect tamper) | Not Done |
| Monitoring query: detect `[EXTRACTION_FAILED]` values in structured columns | Not Done |
| Monitoring query: detect `llm.call` audit rows with no corresponding `llm_call_archive` row | Not Done |
