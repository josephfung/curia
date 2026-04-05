# Outbound Gateway — Design Spec

**Issue:** #35 — Add outbound email approval gate before production deployment
**Date:** 2026-03-27
**Status:** Design approved, pending implementation

## Problem

Email skills (`email-send`, `email-reply`) call `nylasClient.sendMessage()` directly from
the execution layer. This bypasses the outbound content filter (PR #59) which only
intercepts `agent.response` → `outbound.message` events in the dispatcher. A prompt
injection in an inbound email could trick the coordinator into invoking an email skill to
send arbitrary content to arbitrary recipients — completely circumventing the filter.

Additionally, the email adapter's outbound path (`sendOutboundReply`) calls
`nylasClient.sendMessage()` directly, duplicating the filter logic that already exists in
the dispatcher's `handleAgentResponse`. The CEO notification in the dispatcher also calls
Nylas directly (documented spec deviation from PR #59).

Three separate code paths send email, each with different security properties. This is
fragile and unsustainable as more channels are added.

## Design Decision

### Single Outbound Gateway

All outbound external communication passes through an `OutboundGateway` — a new class in
the execution layer that enforces security policy before dispatching to channel clients.

**Why a gateway, not per-skill filtering:**
- Skills should not be trusted to enforce security invariants. Third-party or
  user-authored skills may not implement filtering correctly.
- The gateway is the narrowest chokepoint — every outbound message must pass through it
  regardless of origin (skill, dispatcher, notification).
- Future channels (Signal, Telegram, Google Drive) get the same protection automatically.

**Why the execution layer:**
- The execution layer already owns the skill runtime environment and controls what skills
  can access (sandboxed context, scoped secrets, infrastructure injection).
- The gateway is infrastructure the execution layer provides, replacing direct channel
  client access.

## Architecture

### OutboundGateway

New class at `src/skills/outbound-gateway.ts`.

**Interface:**

```typescript
interface OutboundSendRequest {
  channel: 'email';  // extensible: 'signal' | 'telegram' | etc.
  to: string;        // recipient identifier (email address, phone, etc.)
  subject?: string;  // email-specific
  body: string;
  cc?: string[];     // email-specific
  replyToMessageId?: string;  // email-specific (thread replies)
}

interface OutboundSendResult {
  success: boolean;
  messageId?: string;
  blockedReason?: string;
}
```

**Pipeline (executed in order):**

1. **Contact blocked check** — resolve the recipient via `ContactService`. If the contact
   exists and has status `blocked`, reject immediately. Return
   `{ success: false, blockedReason: 'Recipient is blocked' }`. Log at `warn` level.
   If the contact doesn't exist or isn't blocked, proceed.

2. **Content filter** — run `OutboundContentFilter.check()` on the body, passing the
   recipient email and channel. If the filter blocks:
   - Publish `outbound.blocked` event to the bus (for audit logging)
   - Send opaque CEO notification email (block ID + recipient only)
   - Return `{ success: false, blockedReason: 'Content blocked by filter' }`
   The CEO notification is sent via a recursive `send()` call with a flag to skip the
   filter for notification emails. See "CEO Notification" section for details.

3. **Channel dispatch** — route to the appropriate channel client based on `channel`:
   - `'email'` → `nylasClient.sendMessage()`
   - Future channels added here
   Return `{ success: true, messageId }` on success.

**Error handling:**
- Filter crash → fail-closed (block the message). Same pattern as the dispatcher's
  existing filter gate.
- Channel client error (Nylas API failure) → return
  `{ success: false, blockedReason: 'Send failed: <error>' }`. Logged at `error` level.
- Contact resolution failure → log warning, proceed (do not block on resolution errors —
  the contact may not exist yet for new recipients).

**Additional method for email threading:**

```typescript
async getEmailMessage(messageId: string): Promise<NylasMessage>
```

Delegates to `nylasClient.getMessage()`. The `email-reply` handler needs this to fetch the
original message for thread resolution (sender address, subject line). This is a read-only
operation that doesn't need filtering.

### CEO Notification

When the content filter blocks a message, the gateway sends an opaque notification email
to the CEO. This notification must itself go through the gateway to avoid creating a
bypass path (the #38 spec deviation).

To prevent infinite recursion (notification triggers filter → filter blocks → notification
→ ...), the gateway accepts an internal `isNotification` flag on the send request. When
`isNotification` is true:
- The content filter is skipped (the notification is a fixed template with only a block
  ID and recipient identifier — no sensitive content by construction)
- The blocked check is still performed (don't send notifications to blocked contacts)

This flag is **not exposed on the public interface**. It's an internal-only parameter
used by the gateway's own notification method. Skills cannot set it.

**Why this is safe:** The notification template is hardcoded inside the gateway. External
callers cannot inject content into it. The only dynamic values are the block ID (a UUID)
and the recipient email address. Neither can carry system prompt content.

**Why this is better than the #38 approach:** The notification flows through the gateway
(which owns the Nylas client), rather than the dispatcher calling Nylas directly. The
gateway is the single point of Nylas access, and the notification flag is internal — not
a general-purpose bypass.

### Skill Refactoring

**`email-send` handler:**
- Replace `ctx.nylasClient.sendMessage(...)` with
  `ctx.outboundGateway.send({ channel: 'email', to, subject, body, cc })`
- Input validation (email format, length limits) stays in the handler
- Check `result.success` and return appropriate `SkillResult`
- If gateway blocked, return a graceful message to the LLM (e.g., "Email could not be
  sent — it was flagged by the content filter")
- Remove SECURITY TODO comment — the gateway makes it obsolete

**`email-reply` handler:**
- Fetch original message via `ctx.outboundGateway.getEmailMessage(replyToMessageId)`
- Extract sender address and subject from original message (reply-specific logic)
- Call `ctx.outboundGateway.send({ channel: 'email', to: originalSender, subject, body,
  replyToMessageId })`
- Remove SECURITY TODO comment

### Execution Layer Changes

**`ExecutionLayer` constructor:**
- Takes `OutboundGateway` instead of `NylasClient`
- The `nylasClient` reference is removed from the execution layer entirely

**Infrastructure skill context:**
- Skills get `ctx.outboundGateway` instead of `ctx.nylasClient`
- Skills that previously needed `nylasClient` now use the gateway

### Email Adapter Changes

**Outbound path in `EmailAdapter.sendOutboundReply()`:**
- Replace `nylasClient.sendMessage(...)` with `outboundGateway.send(...)`
- Thread resolution stays in the adapter (looking up original message, extracting sender
  address, building `Re: Subject` — this is channel-specific addressing knowledge)
- The adapter uses `outboundGateway.getEmailMessage()` for thread lookups instead of
  raw `nylasClient.listMessages()`

**Constructor:**
- Takes `OutboundGateway` instead of `NylasClient`

### Dispatcher Simplification

**Remove from `handleAgentResponse()`:**
- The outbound content filter gate (the `if (this.outboundFilter && ...)` block)
- The CEO notification logic
- The `OutboundContentFilter` dependency
- The `externalChannels` config
- The `ceoNotification` config
- The misconfiguration warnings for filter/channels/notification

**Keep:**
- Routing logic (`agent.response` → `outbound.message`)
- `taskRouting` map with `senderId`
- Contact resolution on inbound
- Held message / unknown sender policy

The dispatcher returns to its original responsibility: routing bus events between channels
and agents. Security policy enforcement moves entirely to the gateway.

### Bootstrap Changes

**Construct `OutboundGateway` before `ExecutionLayer`:**

```
OutboundGateway ← contentFilter, contactService, nylasClient, bus, ceoEmail, logger
ExecutionLayer  ← skillRegistry, logger, { bus, agentRegistry, contactService, outboundGateway, heldMessages }
EmailAdapter    ← bus, logger, outboundGateway, contactService, pollingIntervalMs, selfEmail
Dispatcher      ← bus, logger, contactResolver, heldMessages, channelPolicies
```

The `Dispatcher` no longer needs the content filter, external channels set, or CEO
notification config.

## Scope

### In scope

- `OutboundGateway` with contact blocked check + content filter + channel dispatch
- CEO notification through the gateway (resolving #38 spec deviation)
- Refactor `email-send` and `email-reply` to use gateway
- Refactor `EmailAdapter` outbound path to use gateway
- Simplify `Dispatcher` (remove filter gate)
- Update bootstrap wiring
- Tests for gateway pipeline, skill refactoring, adapter integration, dispatcher
  simplification

### Out of scope (future work)

- Domain-level blocking (`blocked_domains` table)
- Rate limiting on outbound sends
- `outbound.notification` event type (the internal `isNotification` flag is simpler)
- Runtime blocklist management skills (`outbound-block` / `outbound-unblock`)
- Signal/Telegram channel clients (gateway is extensible for them)
- LLM-as-judge content filter (Stage 2 — see #38 spec)

## Testing Strategy

- **Unit tests** for `OutboundGateway`: pipeline ordering, blocked contact rejection,
  content filter integration, channel dispatch, error handling (filter crash, Nylas
  failure, contact resolution failure)
- **Unit tests** for refactored `email-send` and `email-reply`: gateway success, gateway
  block, gateway error paths
- **Integration tests** for the full flow: inbound email → coordinator response → email
  adapter → gateway → filtered send
- **Regression tests**: existing dispatcher tests still pass with simplified dispatcher,
  existing email adapter tests adapt to gateway injection
- **CEO notification test**: notification goes through gateway, contains only opaque
  content, is exempt from content filter
