# Context Bridging v2: Delegation-Aware Outbound Context

## Context

Curia's context bridging system helps the coordinator understand what was previously sent on non-threaded channels (Signal today) so it can contextualize inbound replies. The current implementation (shipped in v0.27) works for coordinator-initiated outbound but breaks down for specialist-initiated proactive messages.

Three problems drive this redesign:

1. **Specialist outbound is invisible.** When a specialist agent sends a message (e.g., a scheduled debrief prompt), no context memo is written. When the CEO replies, the coordinator has no idea what the reply is about and no guidance on which specialist should handle it.

2. **No delegation guidance.** Context memos say "User may reply to this message" but don't indicate which specialist originated the outbound or what kind of reply to expect. The coordinator can't delegate intelligently.

3. **No lifecycle management.** Memos have a fixed 24h TTL with no manual release. An agent that finishes a conversation can't clean up, and there's no mechanism to signal "stop expecting a reply."

### Architectural principle established in this design

**The coordinator is the sole voice for all human-facing communication.** Specialist agents never call outbound skills (signal-send, email-send, email-reply) directly. When a specialist needs to send a proactive message, it requests the send via a Bullpen thread mentioning the coordinator. The coordinator applies judgment, sends the message, and registers the context bridge entry. This is enforced structurally by not pinning outbound communication skills to specialist agents.

This principle was implicit in the original architecture ("only the coordinator speaks to humans") but the implementation allowed specialists to send directly via OutboundGateway. This design makes the enforcement explicit and introduces the Bullpen-through-coordinator pattern as the standard for specialist-initiated outbound.

---

## Design

### 1. Dedicated Storage: `outbound_context` Table

Context bridge entries move from working memory (where they're awkwardly stored as system-role conversation turns) to a dedicated table with structured fields.

```sql
CREATE TABLE outbound_context (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  TEXT NOT NULL,
  channel_id       TEXT NOT NULL,
  agent_id         TEXT NOT NULL,       -- originating specialist (or 'coordinator')
  content_preview  TEXT NOT NULL,       -- first 300 chars of outbound
  expected_reply   TEXT,                -- guidance for coordinator
  delegation_hint  TEXT,                -- "delegate to meeting-debrief"
  metadata         JSONB,              -- extensible (meeting title, attendees, etc.)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  released         BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_outbound_context_active
  ON outbound_context (expires_at) WHERE released = false;
```

**Why not working memory?** Working memory is for conversation turns — sequential dialogue that may be summarized. Context bridge entries are lifecycle-managed records with structured metadata, expiry, and explicit release. Different data model, different access patterns.

### 2. Write Path: Outbound Send Skills

When the coordinator calls an outbound send skill (`signal-send`, `email-send`, `email-reply`), it can optionally include `context_bridge` parameters. The skill handler writes the context record atomically with the send.

**Enhanced skill inputs** (optional, additive — existing calls without these fields work unchanged):

```json
{
  "recipient": "+15550001111",
  "message": "You just wrapped up with Sarah Chen from Meridian. Any takeaways?",
  "context_bridge": {
    "agent_id": "meeting-debrief",
    "expected_reply": "Meeting takeaways or follow-up action items",
    "delegation_hint": "Delegate replies about this meeting to meeting-debrief",
    "metadata": { "meeting_title": "Strategy sync with Meridian", "attendees": ["sarah@meridian.com"] },
    "expires_in_hours": 48
  }
}
```

The skill handler:
1. Sends the message via OutboundGateway (existing flow, unchanged)
2. If `context_bridge` is present AND the send succeeds, writes a row to `outbound_context`
3. `conversation_id` and `channel_id` come from the send context (OutboundGateway already resolves these)
4. If the write fails, log a warning but don't fail the send (best-effort, same as today)

**No context_bridge param?** Behaves exactly as today — no record written. This maintains backward compatibility for routine coordinator replies where context bridging isn't needed (e.g., answering a direct question).

### 3. Read Path: Dispatcher Injection

On every inbound message, the dispatcher queries active context bridge entries and injects them into the coordinator's task content.

**Query:** All non-released, non-expired entries. No filtering by conversation ID or channel — the coordinator's LLM judges relevance across channels.

```sql
SELECT * FROM outbound_context
WHERE released = false AND expires_at > now()
ORDER BY created_at DESC
LIMIT 10;
```

**Why no channel/conversation filter?** Cross-channel correlation. If the coordinator sent a Signal prompt and the CEO replies via email mentioning the same topic, the coordinator sees both the active context entry and the inbound email, and can connect them. The LLM handles relevance; the system provides visibility.

**Injection format** (replaces current `[PRIOR OUTBOUND CONTEXT]` block):

```
[ACTIVE OUTBOUND CONTEXT — messages you've sent that may receive replies]
---
[sent 5 minutes ago via signal, on behalf of meeting-debrief, expires in 48h]
preview: "You just wrapped up with Sarah Chen from Meridian. Any takeaways?"
expected reply: Meeting takeaways or follow-up action items
delegation: Delegate replies about this meeting to meeting-debrief
context: {"meeting_title": "Strategy sync with Meridian", "attendees": ["sarah@meridian.com"]}
---

<original inbound message content>
```

If no active entries exist, no block is injected (same as today).

### 4. Release Path: Explicit Completion

When a specialist finishes handling a conversation (e.g., debrief is complete), the coordinator marks the context entry as released. This happens naturally when the coordinator decides the conversation is done — it calls a skill to release the entry.

**New skill: `context-bridge-release`** (pinned to coordinator):

```json
{
  "name": "context-bridge-release",
  "description": "Mark an outbound context bridge entry as released — stop expecting replies for this outbound message.",
  "inputs": {
    "entry_id": "string"
  },
  "action_risk": "none"
}
```

The coordinator calls this when:
- The specialist signals completion (via delegate response: "Debrief complete, all actions taken")
- The coordinator judges the conversation is done (CEO said "thanks" or "nothing else")
- The coordinator wants to manually clear stale context

**Automatic expiry** handles the case where neither party explicitly releases — the `expires_at` column takes care of cleanup without manual intervention.

### 5. Coordinator Prompt Guidance

New section added to `coordinator.yaml` system prompt:

```
## Active Outbound Context & Delegation
When your input includes an [ACTIVE OUTBOUND CONTEXT] section, these are messages
you previously sent that may receive replies. For each entry:

- Check if the inbound message plausibly relates to one of the active entries
- If it does, delegate to the specialist named in the delegation hint, including
  the CEO's message and relevant context from the entry
- If the message is clearly about something else, handle it normally — entries
  are advisory, not binding
- When a delegated task completes and the conversation is done, release the
  context entry using context-bridge-release

If no [ACTIVE OUTBOUND CONTEXT] section is present, the self-contained vs.
reply-shaped test still applies (see "Outbound context" section above).
```

### 6. Bullpen-Through-Coordinator Pattern

When a specialist agent needs to send a proactive message to the CEO, it posts a Bullpen thread mentioning the coordinator with a structured request:

**Specialist's Bullpen message:**
> @coordinator I'd like you to send a message to the CEO.
>
> **Channel:** Signal
> **Message:** "You just wrapped up with Sarah Chen and David Park from Meridian. Any takeaways or follow-ups?"
> **Context bridge:** Please register this with: agent_id=meeting-debrief, expected_reply="Meeting takeaways or follow-up items", delegation_hint="Delegate replies to meeting-debrief", expires_in_hours=48, metadata={"meeting_title": "Strategy sync with Meridian", "attendees": ["sarah@meridian.com", "david@meridian.com"]}

**Coordinator receives via Bullpen task, then:**
1. Applies judgment — is this the right time? Is the CEO available? Should the wording be adjusted?
2. Calls `signal-send` with the message and `context_bridge` parameters
3. Context record is written atomically with the send
4. Replies in the Bullpen thread confirming the send (or explaining why it declined)

**Coordinator judgment examples:**
- CEO just received 3 prompts in the last hour → coordinator holds or batches
- Meeting was a personal appointment that shouldn't get a debrief → coordinator declines, replies in Bullpen: "Skipping — this was a personal meeting"
- Wording needs persona adjustment → coordinator rewrites in its own voice before sending

### 7. Skill Registry Enforcement

Specialist agents do NOT get outbound communication skills pinned:
- `signal-send` — coordinator only
- `email-send` — coordinator only
- `email-reply` — coordinator only

Specialists retain internal-write skills:
- `email-draft-save` — creates drafts for CEO review (not human communication)
- `calendar-create-event` — external effects, but gated by autonomy engine
- `memory-store`, `scheduler-create`, etc. — internal state

This makes the "coordinator is the sole voice" rule enforceable at the skill registry level rather than relying on prompt discipline. Future hardening (issue TBD) can add explicit deny-lists or runtime checks.

### 8. Migration from Working Memory

The existing context bridging code (`context-memo.ts` + dispatcher integration) is replaced:

1. **New migration** creates `outbound_context` table
2. **Dispatcher read path** (`handleInbound`) queries `outbound_context` instead of working memory
3. **Dispatcher write path** (`handleAgentResponse`) is removed — writes now happen in send skill handlers
4. **`context-memo.ts`** is refactored: `formatOutboundMemo` and `extractRecentMemos` are replaced with SQL-backed equivalents; `buildContextPreamble` stays (formatting the injection block)
5. **Working memory** continues to serve its actual purpose (conversation history for agents) without context memos mixed in
6. **Coordinator prompt** updated: `[PRIOR OUTBOUND CONTEXT]` section replaced with `[ACTIVE OUTBOUND CONTEXT]` section and delegation guidance

**Behavioral change for routine coordinator replies:** Today, every coordinator response on a non-threaded channel creates a context memo automatically. After this migration, context entries are only created when `context_bridge` params are passed to a send skill. Routine Q&A replies (CEO asks "what's on my calendar?" → coordinator answers) will NOT create entries. This is intentional — for routine exchanges, the coordinator's existing "self-contained vs. reply-shaped" heuristic handles context adequately. Context bridge entries are reserved for proactive outbound that genuinely expects a substantive reply and needs delegation routing.

Backward compatibility: during migration, any active memos in working memory can be ignored (they'll expire within 24h via the old TTL logic). No data migration needed.

---

## What This Enables

- **Meeting debrief agent** (Spec 17 / #384) — proactive prompts route through coordinator, replies delegate back correctly
- **Any future proactive agent** — relationship manager, task reminders, scheduled check-ins all use the same pattern
- **Cross-channel reply handling** — CEO can reply on any channel; coordinator sees all active context and correlates
- **Coordinator judgment on all outbound** — timing, batching, persona consistency, appropriateness

---

## New Files

| File | Purpose |
|------|---------|
| `src/db/migrations/NNN_create_outbound_context.sql` | Dedicated table for context bridge entries |
| `src/dispatch/outbound-context.ts` | Service class: write, query active, release, cleanup expired |
| `src/dispatch/outbound-context.test.ts` | Unit tests |
| Update: `skills/signal-send/handler.ts` | Accept optional `context_bridge` param, write entry on send |
| Update: `skills/email-send/handler.ts` | Same |
| Update: `skills/email-reply/handler.ts` | Same |
| New: `skills/context-bridge-release/` | Coordinator skill to release entries |
| Update: `src/dispatch/dispatcher.ts` | Read path queries new table; remove old working memory write path |
| Update: `src/dispatch/context-memo.ts` | Refactor formatting functions for new data model |
| Update: `agents/coordinator.yaml` | New prompt section for delegation guidance |

---

## Follow-Up Issues (out of scope)

1. **Retrofit existing specialist agents** — update agents that currently call outbound skills directly (ceo-inbox, research-analyst if applicable) to use Bullpen-through-coordinator pattern
2. **Hardened enforcement** — runtime deny-list or execution-layer gate preventing specialists from invoking outbound skills, even if discovered dynamically
3. **Batching/throttling** — coordinator-level logic to batch or throttle proactive prompts when multiple specialists request outbound in a short window
4. **Context bridge analytics** — track which specialists generate the most context entries, which get replied to, delegation accuracy

---

## Naming

The term "context bridging" describes the mechanism (bridging outbound context to inbound handling). This design retains the name for the overall system but introduces specific terminology:
- **Context bridge entry** — a single record in `outbound_context`
- **Delegation hint** — the field that tells the coordinator which specialist to route to
- **Bullpen-through-coordinator** — the pattern for specialist-initiated outbound

Open question: is "context bridging" still the right umbrella name, or should this be renamed now that it's grown beyond simple message correlation? Candidates: "outbound context registry", "reply routing", "conversation context." Keeping "context bridging" for continuity unless a better name emerges.
