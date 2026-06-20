# 15 — Outbound Safety

**Status:** Partial — deterministic rules, LLM audience-leak judge, and tier-keyed disclosure gate (Stage 2.5) implemented; see TODO below

> **TODO:** Keep this spec aligned with production behaviour as Stage 2 evolves
> (tone/persona guardrails, operator override guidance, and caller-verification notes).
> Detailed implementation notes are in `docs/wip/`:
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
| **Prompt injection via inbound email** | Attacker email instructs LLM to dump system prompt in reply | Content filter — Stage 1 (deterministic) + Stage 2 (LLM-as-judge) |
| **Accidental context leakage** | LLM naturally includes a third party's email address in a reply | Content filter — contact data leakage rule |
| **Over-disclosure to an untrusted recipient** | Reply shares the CEO's availability or another contact's details with an unknown-tier recipient | Content filter — Stage 2.5 tier-keyed disclosure gate (escalation judge) |
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
4. **Audit emission** — on successful wire-level delivery, emit `outbound.delivered`

The gateway fails closed: if the content filter crashes, the message is blocked. A channel
client failure returns a structured error; it does not silently drop the message.

### `outbound.delivered` — the canonical wire-level audit event

The gateway emits an `outbound.delivered` event after every successful send. This is the canonical "did something actually leave the building?" audit signal:

- Emitted exactly once per successful send.
- Includes `channel`, `recipientId`, `content`, `conversationId` (or null), `taskEventId`, and the originating `skillInvocationId` so the causal chain is reconstructible.
- Distinct from `outbound.message` (emitted by `dispatch` when translating `agent.response` → send request), which represents *intent* to send and is only emitted for response-path sends. Skill-invoked sends (`signal-send`, `email-send`, `email-reply`, etc.) bypass `dispatch` entirely; without `outbound.delivered`, those sends would be invisible to a security review counting outbound traffic. See [spec 10](10-audit-log-hardening.md) for the full extraction-row contract.
- HTTP/web responses are captured by `agent.response` and are out of scope for `outbound.delivered`. CLI is dev-only and excluded by design.

---

## Content Filter

A multi-stage pipeline that runs on every outbound message to an external recipient: Stage 1 (deterministic rules), Stage 2 (LLM audience-leak judge), and Stage 2.5 (tier-keyed disclosure gate). Each stage can block; later stages run only if earlier ones pass.

### Stage 1: Deterministic Rules (implemented)

Fast, zero-cost pattern matching. Any finding from Stage 1 blocks immediately — Stage 2 is skipped.

- **System prompt fragments** — marker phrases extracted from loaded agent config checked for verbatim or near-verbatim matches in the outbound body
- **Internal structure leakage** — bus event type names, YAML/JSON config patterns, internal field names (`conversationId`, `taskId`, `agentId`, etc.)
- **Secret patterns** — reuses existing patterns from `sanitizeOutput()`: API keys, bearer tokens, hex tokens ≥ 32 chars
- **Contact data leakage** — email addresses in the body that are not the intended recipient or the CEO

### Stage 2: LLM-as-Judge — audience-leak & sensitive-data detection (implemented)

A configurable LLM judge (separate model from the coordinator) evaluates content that
passes Stage 1 and returns a binary verdict `{leak: true|false}`. It flags two classes of
content that should not reach a mixed audience:

1. **Audience leaks** — internal monologue, system/agent status, or side-channel notes
   ("To the CEO: ...") embedded in a message a non-principal recipient can read.
2. **Hyper-sensitive financial / credential data** — payment card numbers, CVV/PIN, bank
   account and payment-routing details (sort code, routing number, IBAN, SWIFT), passwords,
   passphrases, API keys, private keys, or one-time/2FA codes. Lower-sensitivity PII that is
   routinely shared (postal address, phone, DOB, passport/national-ID, frequent-flyer/loyalty
   numbers) is **not** flagged on its own.

When it flags, the judge's `reason` names the category only and must not quote the offending
value — so the secret does not re-leak into the `outbound.blocked` audit event or CEO notification.

- **Recipient awareness.** The judge reasons over the full recipient set (To + CC). Each
  recipient is tagged `isPrincipal` structurally (matches one of the principal's verified
  channel identities — never the free-text contact role).
- **Skip rule.** The judge is **short-circuited before any model call** when the principal is
  the SOLE recipient (a private channel). The judge model therefore only ever sees messages
  with at least one non-principal recipient, and the prompt does not reason about the
  principal-sole case. Principal + third parties → judge runs.
- **Model.** Configurable via `filter.llmJudge.model` (default `claude-haiku-4-5`).
  Operators are strongly encouraged to use a different vendor/family than the agent tiers
  so an attack crafted for the coordinator cannot also fool the reviewer.
- **Failure handling** (`filter.llmJudge.failMode`, default `split`): a judge that is
  unreachable (timeout / API error) fails open (message delivered, Stage-1-only); a live
  model that returns an unparseable verdict fails closed (blocked). `open`/`closed` force
  uniform behavior.

Tone alignment and persona consistency are deferred to a follow-up; the judge prompt can be
extended to cover them without further plumbing changes.

**When blocked:** the outbound message is dropped entirely (no partial send), an `outbound.blocked`
audit event is published, and the CEO receives a notification. The notification carries the
intended recipient, a UTC timestamp, the block ID, the audit event ID (for log lookup), and a
principal-safe **reason summary**:

- For a Stage 2 judge block, the judge's own `reason` is surfaced — it is abstract by
  construction (names the category, never quotes the value), so it is safe to show and gives
  the CEO something actionable.
- For a Stage 1 deterministic block, only the rule *name* is shown (e.g. `secret-pattern`); the
  rule detail can embed the matched fragment, so it is withheld.

The blocked content itself is never included, on either path. There is no review-and-approve /
resend flow yet (see *What's Not Here Yet*), so a false positive currently means the agent's send
is dropped and must be re-requested.

### Stage 2.5: Escalation Judge — tier-keyed disclosure gate (implemented)

Stages 1 and 2 catch *leaked internal content*. Stage 2.5 catches *over-disclosure to a recipient who isn't trusted enough to receive it* — sharing the principal's availability with an unknown sender, or another contact's details with someone who has no business seeing them. It runs only if Stages 1 and 2 both pass (#948, #949).

The policy is **deterministic code**; the LLM does only the natural-language classification. The escalation judge classifies the outbound body into a `DisclosureClass`, and `applyDisclosurePolicy(recipientTier, disclosureClass)` decides `allow` or `escalate`:

| Disclosure class | unknown | known | trusted | principal |
|---|:---:|:---:|:---:|:---:|
| `public` (a meeting exists, "best to email") | ✅ | ✅ | ✅ | ✅ |
| `principal-context` (CEO's availability, location, opinion) | escalate | ✅ | ✅ | ✅ |
| `third-party` (anything about another contact) | escalate | escalate | ✅ | ✅ |
| `confidential` (financials, legal, private-thread content) | escalate | escalate | ✅ | ✅ |

(`blocked` recipients receive nothing; they're dropped upstream and guarded here.)

- **Recipient tier** is the contact's `tier` (`contact.tier`), not the legacy `trust_level` column — that column was retired in the contacts redesign. The principal-bypass that the old `trust_override` redactor config provided is now structural (the immutable CEO contact UUID), and `trust_override` was removed (#949).
- **Fail-closed.** Any LLM failure (timeout, malformed verdict, provider error) resolves to `decision='escalate'`. A configured-but-throwing judge yields a `disclosure-gate-error` finding and blocks. When **no** escalation judge is configured, Stage 2.5 is a no-op pass.
- **Shared policy module.** Both this disclosure gate and the [Gate C action gate](09-contacts-and-identity.md#layer-4-tier-based-action-gate-gate-c) import the same `src/autonomy/escalation-policy.ts` tables (`DisclosureClass`, `ActionConsequenceClass`). The action gate adds a reversibility axis (`none` → `reversible-internal` → `reversible-external` → `irreversible`) and a `isThirdPartyFacing` runtime flag the judge resolves per-invocation.

A Stage 2.5 escalation surfaces to the CEO the same way as a block: the finding names the disclosure class and recipient tier (never the offending value), so the audit event and CEO notification stay principal-safe.

### Value-aware browser secret redaction (v0.35.0)

A complementary defense on the tool-output side, upstream of the outbound filter. When a
secret is injected into the browser by reference (`web-browser` `secret_ref`), the value is
never returned to the LLM in the first place: it is tracked per browser session and scrubbed —
raw plus its URL- and HTML-encoded variants — from the returned page content, the page URL,
and any error messages, so a hostile page cannot reflect the injected credential back into the
model's context. Screenshots are suppressed on any action that fills a secret, since an image
cannot be value-redacted. See [spec 03 — Output Sanitization](03-skills-and-execution.md#output-sanitization).

---

## Audience Partitioning (coordinator prompt guidance)

The content filter (above) is the *detection* layer — it catches principal-private or internal
content that has already leaked into an external-facing body. A complementary *prevention* layer
stops the leak from being composed in the first place, at the point where the coordinator decides
what to send.

This prevention layer is implemented as **coordinator prompt guidance**, not a skill or payload
field. The `agents/coordinator.yaml` system prompt (under `## Audience Awareness`) instructs the
coordinator: when a single interaction calls for both an **external reply** *and* a **principal
status update**, treat them as two independent outbound actions —

1. the external reply (composed for the external recipient only), and
2. a **separate** outbound call to the principal via `email-send` / `signal-send`,

— and **never** address the principal in a body that also reaches an external recipient.

> **Implementation note:** An earlier design (a dedicated `compose-reply` skill plus an
> `AgentResponsePayload.sidebar` field, PR #907) was **closed unmerged**. What shipped (PR #908)
> is the prompt-guidance mechanism described above. There is **no** `compose-reply` skill and
> **no** `sidebar` payload field in the codebase — do not document them as existing.

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
| Content filter Stage 2 — LLM-as-judge (audience-leak & hyper-sensitive financial/credential detection) | Done |
| Content filter Stage 2.5 — tier-keyed disclosure gate (escalation judge classifies `DisclosureClass`; `applyDisclosurePolicy` gates on recipient `tier`; fail-closed) (#948, #949) | Done |
| Disclosure gate + PII redactor key on `contact.tier`; legacy `trust_override` redactor config removed (principal bypass now structural) (#949) | Done |
| Audience partitioning — coordinator prompt guidance to send external reply and principal status update as **separate** outbound messages (no shared body) | Done |
| `outbound.blocked` audit event published on filter block | Done |
| Caller verification gate — elevated-skill check in execution layer | Partial — role-based gate exists; cross-channel challenge/response flow not built |
| Display name sanitization — storage-time sanitization of inbound display names | Done |
| Display name mismatch check — flag when display name matches known contact but address does not | Not Done |
| CEO review-and-approve / edit / discard flow for blocked messages | Not Done |
| Web UI for reviewing `outbound.blocked` events | Not Done |
| Outbound rate limiting per recipient | Not Done |
| Blocklist management skills (`outbound-block` / `outbound-unblock`) | Not Done |
| `outbound.notification` event type (CEO notifications route through the filter pipeline) | Done |
| Email reply quoting — `email-reply` includes the quoted original message body in drafts and sends; the filter pipeline runs over the full quoted reply | Done |
| ceo-inbox URGENT alerts route through coordinator via Bullpen — specialist agents no longer call `signal-send` directly; alerts are requested as Bullpen threads mentioning the coordinator (see [spec 17 §4](17-meeting-debrief.md)) | Done |
| `ceo-inbox-update-folders` empty-folders guard — refuses to PUT an empty folder set to Nylas, preventing accidental folder wipes | Done |
| `ceo-inbox-draft-reply` — fails on missing sender rather than substituting an `"unknown"` placeholder in the draft | Done |

---

## What's Not Here Yet

- Stage 2 follow-up: tone alignment and persona consistency checks (the judge prompt can be extended without further plumbing changes)
- CEO review-and-approve / edit / discard flow for blocked messages
- Web UI for reviewing `outbound.blocked` events
- Outbound rate limiting per recipient
- Blocklist management skills (`outbound-block` / `outbound-unblock`)

> **TODO:** Replace this section with a proper "What's Implemented / What's Planned" table
> once the feature is complete. The outstanding items above are the main gaps.
