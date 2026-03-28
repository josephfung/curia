# Outbound Content Filter — Design Spec

**Issue:** #38 — Prevent LLM from leaking system prompt or internal context in outbound emails
**Date:** 2026-03-27
**Status:** Design approved, pending implementation

## Problem

The coordinator's text response is sent as the outbound email body with no sanitization.
The LLM's context window contains the full system prompt, sender context (contact details
from the knowledge graph), conversation history, and skill results. A prompt injection
attack in an inbound email could trick the LLM into including this sensitive content in
its reply — sending it to an external party.

Secondary risk: the LLM accidentally includes internal context (other contacts' details,
internal metadata, agent configuration) without being explicitly prompted to do so.

## Threat Model

This design defends against both:

1. **Prompt injection** — attacker-crafted inbound email that instructs the LLM to dump
   system prompt, contact database, conversation history, or internal metadata.
2. **Accidental inclusion** — the LLM naturally references internal context it shouldn't
   expose to external recipients.

## Design Decisions

### Approach: Filter in the Dispatch Layer

The outbound content filter lives in the Dispatch layer, which already owns routing
decisions. When the Dispatcher converts `agent.response` → `outbound.message`, it runs
the response through a filter pipeline for external-facing channels.

**Why Dispatch, not the email adapter or bus middleware:**

- The Dispatcher already knows the `channelId`, so it can apply filtering only to
  external channels (email now, Signal/Telegram later) without touching internal channels
  (CLI, HTTP) that go back to the CEO.
- It's the right architectural layer — Dispatch handles routing policy.
- A bus middleware approach would require interceptor support the bus doesn't have.
- An email-adapter approach would need duplication when new external channels are added.

### Failure mode: Block and Notify

When the filter detects suspicious content, the outbound email is **blocked entirely**.
No redaction, no partial send. The CEO receives an opaque notification email with a
block event ID they can use to review the details via an internal channel (CLI now, web
app later).

A structured audit event is logged for every block, enabling future ops monitoring
independently of CEO notification.

## Architecture

### Two-Stage Filter Pipeline

Two filter stages run in sequence. Stage 1 blocks cheaply; Stage 2 runs only if Stage 1
passes. This cheap-then-expensive ordering minimizes latency and cost.

#### Stage 1: Deterministic Filter

Fast, zero-cost, pattern-based checks:

1. **System prompt fragment detection** — Marker phrases extracted at startup from the
   loaded agent config (persona name, title, tone, instruction fragments). Checked for
   verbatim or near-verbatim matches in the outbound body. Markers are derived
   dynamically, not hardcoded, so they stay in sync as the prompt evolves.

2. **Internal structure leakage** — Patterns indicating internal metadata:
   - Bus event type names: `inbound.message`, `agent.task`, `agent.response`,
     `outbound.message`, `outbound.blocked`, etc.
   - YAML/JSON config block patterns (multi-line indented key-value structures)
   - Internal field names: `conversationId`, `senderId`, `channelId`, `systemPrompt`,
     `sourceLayer`, `taskId`, `agentId`

3. **Secret patterns** — Reuses existing patterns from `sanitizeOutput()` in
   `src/skills/sanitize.ts`:
   - Anthropic API keys (`sk-ant-...`)
   - OpenAI API keys (`sk-...`)
   - AWS access keys (`AKIA...`)
   - Bearer/JWT tokens
   - Generic hex tokens (32+ chars)

4. **Contact data leakage** — Detects email addresses in the outbound body that are not
   the intended recipient or the CEO. If the response contains a third party's email
   address, it's flagged. This requires the filter to receive the recipient address and
   CEO address as context.

Each rule returns findings as `Array<{ rule: string, detail: string }>`. Any findings
from Stage 1 = block (Stage 2 is skipped).

#### Stage 2: LLM Review (stub — future implementation)

Interface defined, implementation is a no-op that always passes.

**Future intent:** A locally-hosted open-source model (different from the primary
coordinator model) evaluates contextual appropriateness. This provides defense-in-depth
against novel prompt injection patterns that deterministic rules can't catch. The model
diversity ensures that an attack crafted for the primary model doesn't also fool the
reviewer.

The stub defines the interface:
- **Input:** outbound content, conversation metadata (channel, recipient, thread context)
- **Output:** `{ passed: boolean, findings: Array<{ rule: string, detail: string }> }`

Findings from both stages are aggregated. Any finding from either stage = block.

### Pipeline Return Type

```typescript
interface FilterResult {
  passed: boolean;
  findings: Array<{ rule: string; detail: string }>;
  stage: 'deterministic' | 'llm-review';  // which stage produced findings (if blocked)
}
```

### Bus Event: `outbound.blocked`

New event type added to `src/bus/events.ts`:

- **sourceLayer:** `'dispatch'`
- **payload:**
  - `blockId: string` — unique identifier for this block event (e.g., ULID)
  - `conversationId: string` — the original conversation thread
  - `channelId: string` — targeted channel (e.g., `'email'`)
  - `content: string` — the blocked response body
  - `recipientId: string` — intended recipient identifier
  - `reason: string` — human-readable summary
  - `findings: Array<{ rule: string, detail: string }>` — full filter output

### Dispatcher Integration

In the `agent.response` → `outbound.message` conversion:

1. Check if the target `channelId` is external-facing. Initially just `'email'`; the list
   is extensible via configuration.
2. If external: run content through the filter pipeline, passing context (recipient
   address, CEO address, conversation metadata).
3. **Pipeline passes:** publish `outbound.message` as today.
4. **Pipeline blocks:** publish `outbound.blocked` instead. Do NOT publish
   `outbound.message`. The agent layer is unaware the response was blocked.

Internal channels (CLI, HTTP) bypass the filter entirely — they deliver responses to the
CEO, not external parties.

### CEO Notification

When `outbound.blocked` fires, the CEO receives a **short, opaque notification email**:

- **Subject:** "Nathan Curia: Action needed — blocked outbound reply"
- **Body:** A templated message containing:
  - The intended recipient's name
  - The unique block event ID (`blockId`)
  - A note to review via CLI or web app using that ID
- **No blocked content, no rule details, no thread context in the email**

**Implementation note (spec deviation):** The notification email is sent directly via
`nylasClient.sendMessage()` rather than routing through the bus → filter → email-adapter
pipeline. This is a conscious deviation from the original "no bypass" principle, accepted
because the notification is a fixed template with only an opaque block ID and a sender
email address — it cannot carry sensitive content by construction.

**This deviation must not be extended.** Before adding any other direct-send path, an
`outbound.notification` event type must be built so that system notifications route
through the filter pipeline automatically. See the `@TODO` in `dispatcher.ts`.

The `blockId` is the handle for future tooling:
- Today: usable in CLI to inspect the blocked event details
- Future: becomes a deep link to the web app review UI

### Audit Logging

`outbound.blocked` events are picked up by the existing audit logger like any other bus
event. The structured payload (block ID, rule names, detail strings, channel) provides
everything a future ops/sysadmin persona needs for monitoring and alerting — no separate
logging mechanism required.

## Scope

### In scope

- `OutboundContentFilter` module with two-stage pipeline (deterministic + LLM stub)
- Four deterministic detection rules (prompt fragments, internal structures, secrets,
  contact data)
- `outbound.blocked` bus event
- Dispatcher gate on external channels
- CEO notification via opaque email with block ID
- Audit logging via existing bus subscriber
- Tests for all detection rules, pipeline logic, dispatcher integration, and notification

### Out of scope (future work)

- `outbound.notification` event type — required before adding any new direct-send paths.
  The current CEO notification bypasses the filter pipeline (see deviation note above).
  This is the **first priority** follow-up for this feature.
- LLM-as-judge implementation (Stage 2 is stub only) — see project memory for intent
- CEO review-and-approve/edit/discard flow
- Web app UI for reviewing blocked messages
- Signal/Telegram notification channels
- Rate limiting on outbound emails (covered by #35)
- Recipient allowlist / per-contact send permissions (covered by #35)

## Testing Strategy

- **Unit tests** for each detection rule in isolation (true positives and false negatives)
- **Unit tests** for the filter pipeline (stage ordering, short-circuit on Stage 1 block,
  finding aggregation)
- **Integration tests** for dispatcher gate (external channel blocked, internal channel
  passes through, `outbound.blocked` event published with correct payload)
- **Integration test** for CEO notification (opaque email sent with block ID, passes
  through filter itself)
- **False positive tests** — ensure normal business responses don't trigger the filter
  (conversational mention of "email", common phrases that partially match rules, etc.)
