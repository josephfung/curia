# 06 — Audit & Security

## Audit System

Every bus event is written to an append-only `audit_log` table:

```sql
CREATE TABLE audit_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp         TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type        TEXT NOT NULL,
  source_layer      TEXT NOT NULL,
  source_id         TEXT NOT NULL,
  payload           JSONB NOT NULL,
  conversation_id   UUID,
  task_id           UUID,
  parent_event_id   UUID,
  acknowledged      BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_audit_event_type ON audit_log (event_type);
CREATE INDEX idx_audit_source_id ON audit_log (source_id);
CREATE INDEX idx_audit_conversation ON audit_log (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX idx_audit_timestamp ON audit_log (timestamp);
CREATE INDEX idx_audit_unacknowledged ON audit_log (acknowledged) WHERE acknowledged = false;
```

### Properties

- **Append-only** — no UPDATE or DELETE operations on this table. Retention policy can archive old records to cold storage, but never mutate or delete.
- **Write-ahead** — events are written to audit_log *before* delivery to other bus subscribers. This ensures audit completeness even if the process crashes mid-delivery.
- **Causal tracing** — `parent_event_id` links events into chains: message → dispatch → agent → skill → response. Full chain reconstruction via recursive query.
- **Acknowledged flag** — marks whether the event was successfully delivered to all subscribers. Unacknowledged events can be replayed on restart (manual for launch, automatic later).

### Redaction

A configurable redaction layer processes payloads before writing to the audit log:
- Strips fields matching configurable patterns (e.g., `password`, `token`, `secret`, `api_key`)
- Replaces matched values with `"[REDACTED]"`
- The raw event flows through the bus (subscribers see the full payload); only the audit log gets the redacted version
- Redaction patterns are configured in `config/default.yaml`

---

## Security Model

### Hard Layer Separation (Bus-Enforced)

The bus validates publisher authorization at registration time. Each module registers with a `layer` declaration:

| Layer | Can Publish | Can Subscribe |
|---|---|---|
| `channel` | `inbound.message`, `inbound.event` | `outbound.message`, `outbound.event` |
| `dispatch` | `agent.task`, `outbound.message` | `inbound.message`, `agent.response`, `agent.error` |
| `agent` | `skill.invoke`, `agent.response`, `agent.discuss`, `memory.*` | `agent.task`, `skill.result`, `agent.discuss` |
| `execution` | `skill.result` | `skill.invoke` |
| `system` | ALL (audit, scheduler, memory engine) | ALL |

Attempting to publish an unauthorized event type throws an error at call time. This is the primary security boundary.

### Tool Output Sanitization

All skill/tool results are sanitized before being included in LLM context (see [03-skills-and-execution.md](03-skills-and-execution.md)):
- Strip XML/HTML tags that could be interpreted as system instructions
- Truncate to configurable limit
- Redact secret-like patterns
- Wrap errors in structured tags to prevent instruction injection

### Intent Drift Detection

*Lesson from Zora's ASI gaps: agents can drift from their original task during extended operations, especially in headless/unattended mode.*

For persistent tasks:
- The original task description is stored as an **intent anchor**
- On each burst execution, the intent anchor is included in the system prompt
- The agent runtime compares the latest working memory summary against the intent anchor
- If semantic similarity drops below a configurable threshold (default: 0.6), the task is paused and the user is notified: "Task [name] may have drifted from its original goal. Please review."
- **This is not advisory-only** — in unattended mode, drifted tasks are paused, not just logged

### Secrets Isolation

- Agents/LLMs never see secret values
- Only skills access secrets, through the scoped `ctx.secret()` interface
- Every secret access is audit-logged (which skill, from which agent/task)
- Secret values are never written to the audit log
- Skills can only access secrets declared in their manifest

### Input Validation

- All inbound messages are validated for size (max 100KB content)
- Agent YAML configs validated against JSON Schema at startup
- Skill manifests validated at registration
- Dispatch policy rules validated at load time

### PII Handling

- Error strings surfaced to the LLM are scrubbed of PII patterns (email addresses, phone numbers) using configurable regex
- The audit log retains the full error (PII included) for debugging — the redaction is only for LLM-facing context
- No PII is logged to stdout/pino — only to the audit log

---

## Security Checklist (for implementation)

These are non-negotiable for launch:

- [ ] Bus layer enforcement tested (channel cannot publish skill.invoke)
- [ ] Audit log append-only verified (no UPDATE/DELETE code paths)
- [ ] Secret values never appear in logs, audit, or LLM context
- [ ] Tool output sanitization active for all skill results
- [ ] Error strings scrubbed before LLM injection
- [ ] Agent config validation blocks malformed YAML at startup
- [ ] HTTP API channel requires token authentication
- [ ] Rate limiting active at dispatch layer
- [ ] Intent drift detection pauses tasks (not just logs)
