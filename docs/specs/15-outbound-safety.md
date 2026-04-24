# 15 — Outbound Safety

**Status:** Partial — deterministic rules implemented; see TODO below

> **TODO:** This spec is a stub. Flesh it out fully once the outbound gateway, LLM-as-judge
> content filter, and caller verification are all complete and battle-tested in production.
> The WIP design docs in `docs/wip/` have the detailed implementation notes in the meantime:
> - `docs/wip/2026-03-27-outbound-gateway-design.md`
> - `docs/wip/2026-03-27-outbound-content-filter-design.md`
> - `docs/wip/2026-03-28-caller-verification-design.md`

---

## Overview

Outbound safety is a set of defenses ensuring that what Curia sends to the outside world is
legitimate, authorized, and free of inadvertently leaked internal context. It covers four
concerns:

1. **Outbound Gateway** — a single chokepoint all external messages pass through
2. **Content Filter** — blocks responses that may contain leaked system context or injected content
3. **Caller Verification** — confirms elevated-sensitivity skill invocations come from the real CEO
4. **Display Name Sanitization** — prevents spoofing via crafted sender display names

These are deliberately grouped as a single spec area because they share a threat model:
an attacker (or a misbehaving LLM) trying to get Curia to send harmful content, impersonate
the CEO, or exfiltrate internal data to an external party.

---

## Threat Model

| Threat | Example | Defence |
|---|---|---|
| **Prompt injection via inbound email** | Attacker email instructs LLM to dump system prompt in reply | Content filter — Stage 1 (deterministic) + Stage 2 (LLM-as-judge, future) |
| **Accidental context leakage** | LLM naturally includes a third party's email address in a reply | Content filter — contact data leakage rule |
| **Skill-layer bypass** | Prompt injection tricks LLM into calling `email-send` directly, circumventing the dispatcher filter | Outbound gateway — all `nylasClient.sendMessage()` calls go through it |
| **Impersonation of CEO** | Attacker sends email claiming to be the CEO, triggers a high-sensitivity action | Caller verification — cross-channel challenge/response for elevated skills |
| **Display name spoofing** | Reply-To header set to `Jane Doe <attacker@evil.com>` | Display name sanitization — strip or flag mismatched display names |

---

## Outbound Gateway

All external communications — regardless of whether they originate from a skill, the dispatcher,
or a system notification — pass through a single `OutboundGateway` class in the execution layer.

**Why a single gateway, not per-adapter filtering:**
Skills are not trusted to enforce security invariants. Third-party or user-authored skills may
not implement filtering correctly. The gateway is the narrowest chokepoint — every outbound
message must pass through it regardless of origin.

**Pipeline (in order):**
1. **Blocked contact check** — reject immediately if the recipient is blocked
2. **Content filter** — run the two-stage filter pipeline (see below)
3. **Channel dispatch** — route to the appropriate channel client (`email` → Nylas, etc.)

The gateway fails closed: if the content filter crashes, the message is blocked. A channel
client failure returns a structured error; it does not silently drop the message.

---

## Content Filter

A two-stage pipeline that runs on every outbound message to an external recipient.

### Stage 1: Deterministic Rules (implemented)

Fast, zero-cost pattern matching. Any finding from Stage 1 blocks immediately — Stage 2 is skipped.

- **System prompt fragments** — marker phrases extracted from loaded agent config checked for verbatim or near-verbatim matches in the outbound body
- **Internal structure leakage** — bus event type names, YAML/JSON config patterns, internal field names (`conversationId`, `taskId`, `agentId`, etc.)
- **Secret patterns** — reuses existing patterns from `sanitizeOutput()`: API keys, bearer tokens, hex tokens ≥ 32 chars
- **Contact data leakage** — email addresses in the body that are not the intended recipient or the CEO

### Stage 2: LLM-as-Judge (stub — future)

A locally-hosted open-source model (different from the primary coordinator model) evaluates
contextual appropriateness for content that passes Stage 1. Model diversity ensures an attack
crafted for the primary model doesn't fool the reviewer.

Currently a no-op that always passes. The interface is defined; implementation is deferred.

**When blocked:** the outbound message is dropped entirely (no partial send), an `outbound.blocked`
audit event is published, and the CEO receives an opaque notification containing only a block ID
and the intended recipient — no blocked content, no rule detail.

---

## Caller Verification

For skills declared with `sensitivity: elevated`, the execution layer requires a verified
`CallerContext` confirming the instruction came from the real CEO before proceeding. This guards
against prompt injection attacks that attempt to trigger high-consequence actions.

The verification mechanism is a cross-channel challenge/response: if a request arrives via a
lower-trust channel (email), the system sends a challenge via a higher-trust channel (Signal or
CLI) and waits for confirmation before executing.

Trust levels used for gating: see [06-audit-and-security.md](06-audit-and-security.md#trust-gated-actions).

---

## Display Name Sanitization

Inbound messages are checked for mismatches between the platform-verified sender identity and
the display name claimed in message headers. A `From: Jane Doe <attacker@evil.com>` header
is flagged: the display name matches a known contact but the address does not.

Flagged messages are tagged `sender_verified: false` in `InboundMessage.metadata`. The
Coordinator's system prompt instructs it not to take consequential actions on unverified messages
without cross-channel confirmation.

---

## Implementation Status

| Item | Status |
|---|---|
| `OutboundGateway` class — single chokepoint for all external messages | Done |
| Blocked contact check in gateway pipeline | Done |
| Content filter Stage 1 — deterministic rules (system prompt fragments, internal field names, secret patterns, contact data leakage) | Done |
| Content filter Stage 2 — LLM-as-judge | Not Done — stub (always passes) |
| `outbound.blocked` audit event published on filter block | Done |
| Caller verification gate — elevated-skill check in execution layer | Partial — role-based gate exists; cross-channel challenge/response flow not built |
| Display name sanitization — storage-time sanitization of inbound display names | Done |
| Display name mismatch check — flag when display name matches known contact but address does not | Not Done |
| CEO review-and-approve / edit / discard flow for blocked messages | Not Done |
| Web UI for reviewing `outbound.blocked` events | Not Done |
| Outbound rate limiting per recipient | Not Done |
| Blocklist management skills (`outbound-block` / `outbound-unblock`) | Not Done |
| `outbound.notification` event type (CEO notifications currently bypass the filter) | Not Done |

---

## What's Not Here Yet

- LLM-as-judge implementation (Stage 2 of content filter)
- CEO review-and-approve / edit / discard flow for blocked messages
- Web UI for reviewing `outbound.blocked` events
- Outbound rate limiting per recipient
- Blocklist management skills (`outbound-block` / `outbound-unblock`)
- `outbound.notification` event type (currently CEO notifications bypass the filter pipeline
  via a hardcoded template — this deviation must not be extended; see `@TODO` in `dispatcher.ts`)

> **TODO:** Replace this section with a proper "What's Implemented / What's Planned" table
> once the feature is complete. The outstanding items above are the main gaps.
