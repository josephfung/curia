# ADR-019: Delegation-aware outbound context via a dedicated registry

Date: 2026-05-23
Status: Accepted

## Context

When Curia sends an outbound message (email, Signal) it often expects a reply
that needs to be routed back to a specific agent with specific context — a
research-analyst follow-up, a meeting-debrief response, a clarification thread.
Without persistence of *what was sent and why*, an inbound reply lands without
provenance: the dispatcher cannot tell whether this is a fresh conversation or
a continuation of an outbound thread the system started, and the coordinator
cannot reason about it as a follow-up.

The first attempt at this (v1, PR #431) used a **context-memo** pure-function
module: outbound messages were prefixed with an opaque memo string that
encoded the agent ID and metadata, and inbound replies were parsed to extract
that memo. The write side lived inside `email-send` / `signal-send` handlers;
the read side lived in the dispatcher and the coordinator system prompt.

This worked for a single use case (proactive research follow-ups) but broke
down as the platform grew:

1. **Channel-coupled persistence.** The memo lived in the outbound message
   body itself. Quoting, formatting, and reply-tail trimming routinely corrupted
   it; Signal had no equivalent header field; calendar events couldn't carry
   one at all.
2. **No expiry or release semantics.** Stale memos accumulated as the LLM
   was prompted with "expected replies" for threads that had already ended.
3. **No delegation surface.** When the coordinator delegated to a specialist
   (research-analyst, meeting-debrief), the specialist had no way to register
   "I'm expecting a reply to this email" — only the send-skill handler did,
   and it only knew about the immediate calling agent, not the originating
   task chain.
4. **Conditional registration.** v1 only wrote memos when the coordinator
   explicitly opted in. Proactive outbounds — which are exactly the case where
   reply correlation matters most — frequently shipped without a memo and the
   reply arrived as a context-less inbound (#609).
5. **Coupling to the message body** made it impossible for the meeting-debrief
   agent (spec 17) to claim ownership of a thread it didn't originate the
   outbound for. The agent needed a way to register interest in replies
   without re-sending the message.

Three approaches were considered:

**A. Extend context-memo.** Add expiry timestamps, a release mechanism, and
   delegation metadata to the memo string. Keeps the existing architecture.
   Rejected because the channel-coupled persistence is the root problem —
   layering more state into an opaque body-embedded string makes parsing
   fragile and channels without a body field (calendar, future webhook
   integrations) still can't participate.

**B. Per-skill capability injection.** Give each send skill a capability that
   writes context to a generic key-value store, with the dispatcher reading
   from the same store on inbound. Rejected because it conflates "what does
   this skill need to call APIs with" (a skill capability concern) with "what
   does the dispatcher need to correlate replies" (a platform concern). It
   also leaves the delegation-hint surface fragmented across stores.

**C. Dedicated outbound-context registry with a scoped capability surface.**
   A single `outbound_context` table records every outbound message Curia sends:
   conversation, channel, originating agent, content preview, expected-reply
   hint, delegation hint, structured metadata, TTL. The dispatcher injects
   active entries into the coordinator's prompt on every inbound. Skills get
   a narrow `outboundContext` capability (register + release, pre-scoped to
   the current conversation) so any skill — not just send skills — can claim
   a reply thread.

## Decision

**Adopt option C.** Implementation:

1. **New table `outbound_context`** (migration 042). Columns: `id`,
   `conversation_id`, `channel_id`, `agent_id`, `content_preview`,
   `expected_reply`, `delegation_hint`, `metadata` (JSONB), `created_at`,
   `expires_at`, `released`. Indexed on `(expires_at, created_at DESC) WHERE
   released = false` for the dispatcher's hot path.

2. **`OutboundContextService`** owns all CRUD. The dispatcher uses the full
   service to query active entries and format the `[ACTIVE OUTBOUND CONTEXT]`
   injection block prepended to inbound message content for the coordinator.
   Skills receive a `ScopedOutboundContext` wrapper that pre-binds the
   conversation ID and exposes only `register` and `release`.

3. **`outboundContext` skill capability.** Send skills (`email-send`,
   `email-reply`, `signal-send`) and any future agent-initiated send skill
   declare `outboundContext` in their manifest `capabilities` array. The
   execution layer wires `ctx.outboundContext: ScopedOutboundContext` at
   invocation time. A new coordinator-only `context-bridge-release` skill
   lets the coordinator explicitly close a thread when the LLM detects the
   conversation has concluded.

4. **Unconditional auto-registration.** All send-skill handlers register an
   outbound context entry on success — regardless of whether the caller
   passed an explicit `context_bridge` JSON input (closes #609). Explicit
   metadata supplements the auto-registered fields; auto-registered entries
   carry only the agent ID and content preview.

5. **Two-tier TTL.** Auto-registered entries expire in `defaultExpiryHours`
   (6h default). Entries with explicit `context_bridge` metadata expire in
   `explicitExpiryHours` (24h default). Caller-specified `expires_in_hours`
   in the JSON overrides both. The meeting-debrief agent uses 48h via
   `debrief.contextBridgeTtlHours`. Config keys live under `contextBridge.*`
   in `config/default.yaml`.

6. **Periodic cleanup.** A scheduled job runs `cleanupExpired()` on a fixed
   cadence to delete released and expired rows. The dispatcher's read query
   already filters by `expires_at > now() AND released = false`, so stale
   rows are invisible to consumers before cleanup runs — cleanup is a
   storage-hygiene concern, not a correctness concern.

7. **v1 deletion.** The `context-memo.ts` module and its associated read
   path have been deleted in their entirety. There is no fallback; replies
   to messages sent before migration 042 ran will arrive without context,
   exactly as they would have under v1 without a memo.

## Consequences

**Easier:**

- Any agent or skill can claim a reply thread by calling
  `ctx.outboundContext.register(...)` — no channel-specific machinery, no
  message-body manipulation. The meeting-debrief agent uses this to claim
  threads for replies to its own outbound prompts.
- The dispatcher's injection logic is a single query against one table with a
  single index. Inbound latency for context lookup is a single-digit-ms
  read in normal operation.
- Delegation context is a first-class field (`delegation_hint`), not an opaque
  encoded substring. The coordinator can see "this reply is in response to a
  research-analyst delegation" and route accordingly.
- TTL semantics give the platform a principled way to forget — a 24-hour-old
  expected reply is no longer surfaced to the LLM, preventing the "ghost
  thread" problem where the coordinator keeps trying to chase a conversation
  that ended.
- Multi-turn research conversations (#611) work because the specialist can
  re-register on each reply, extending the lifetime of the thread without
  re-sending.

**Harder / accepted trade-offs:**

- `outbound_context` is now a hot table on the inbound path. The
  `(expires_at, created_at DESC) WHERE released = false` partial index keeps
  the query fast even with high write throughput, but the table requires
  periodic cleanup — handled by the scheduled `cleanupExpired()` job.
- Unconditional registration means every outbound message writes a row,
  including one-shot sends that will never receive a reply. The 6-hour TTL
  on auto-registered entries plus cleanup keeps storage bounded, but the
  write amplification is real. Accepted because the alternative
  (conditional registration) is exactly what caused #609.
- Metadata is JSONB capped at 16 KB. Oversize metadata is dropped at
  serialization time (text fields like `expected_reply` and `delegation_hint`
  are truncated to 500 chars with a marker). This protects against runaway
  LLM-generated payloads at the cost of silently losing very large
  delegation context — judged acceptable since delegation hints should be
  short by design.
- A `ScopedOutboundContext` is per-conversation, which means a skill
  delegated to a different conversation cannot directly release entries from
  the originating one. The full `OutboundContextService` is the only way to
  do cross-conversation operations; only system-layer code holds the full
  service handle.
- v1 deletion means any in-flight outbound thread at deploy time loses its
  memo. There is no compatibility shim. Judged acceptable given the small
  scale of the deployment and the short half-life of expected replies (most
  reply within minutes-to-hours, well under the deploy window).
