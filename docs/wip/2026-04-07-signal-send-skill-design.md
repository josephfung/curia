# signal-send Skill + Signal Group Trust Model — Design

**Date:** 2026-04-07
**Status:** Draft

---

## Overview

This document covers two tightly coupled pieces of work:

1. **`signal-send` skill** — lets the coordinator proactively initiate Signal messages
   (1:1 and group) on the CEO's behalf.
2. **Signal group trust model** — before engaging in any Signal group conversation
   (inbound or outbound), Curia verifies that every group member is a known, verified
   contact. Unknown members cause the group message to be held and the CEO to be notified
   via email.

### Why these are coupled

The `signal-send` skill requires a group trust check before sending to a group. The same
check logic is needed in the `SignalAdapter` for inbound group messages. Designing them
together avoids duplicating the trust check and ensures consistent behaviour in both
directions.

---

## Background and trust model rationale

Signal's identity anchor is the phone number. It is cryptographically bound via SIM + E2E
encryption and cannot be spoofed by a message sender. Display names, on the other hand, are
entirely user-defined and carry no trust weight.

For 1:1 Signal messages, contact trust is already handled: the adapter resolves the sender's
phone number against the contact system, and the dispatcher applies the `unknown_sender`
hold policy for provisional contacts.

For **group messages**, the group itself is not a trust boundary — any Signal user can
create a group and add Curia. The only meaningful trust primitive for groups is the set of
individual member phone numbers. Curia's group trust policy is therefore:

> A Signal group is trusted if and only if every member's phone number resolves to a
> verified (non-provisional, non-blocked) contact. A single unknown or blocked member
> renders the entire group untrusted.

This is intentionally conservative. A CEO assistant that participates in groups with unknown
parties could inadvertently leak context or be manipulated by a social-engineering attack
(e.g., a malicious third party inviting Curia to a group to extract information).

### Group trust outcomes

| Members                 | Inbound outcome                                                                             | Outbound outcome (signal-send)                                                                |
|-------------------------|---------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------|
| All verified            | Message published to bus; normal dispatch                                                   | `signal-send` proceeds; `SkillResult { success: true }`                                       |
| Any provisional/unknown | Hold; auto-create provisional contacts; notify CEO via email; message not published to bus  | `signal-send` returns `SkillResult { success: false }` listing the unverified phone numbers   |
| Any blocked             | Drop silently; no CEO notification; message not published to bus                            | `signal-send` returns `SkillResult { success: false }` — blocked member count only (no phones)|

### CLI is not monitored

The CEO is not assumed to be watching the CLI. All async notifications — including group
hold alerts — are delivered via **email**. The CLI is only reliable for synchronous,
interactive sessions. This principle applies system-wide, not just to Signal.

---

## Components

### 1. `SignalRpcClient` — `listGroups()` method

signal-cli's daemon JSON-RPC API exposes a `listGroups` method that returns all groups the
account belongs to, including member phone numbers. We add a typed wrapper:

```typescript
export interface SignalGroupMember {
  number: string;      // E.164 phone number
  uuid?: string;
}

export interface SignalGroupDetails {
  id: string;          // base64-encoded group V2 ID
  name: string;        // user-defined — NOT trusted for identity
  members: SignalGroupMember[];
  pendingMembers: SignalGroupMember[];
  isMember: boolean;
}

// New method on SignalRpcClient:
async listGroups(): Promise<SignalGroupDetails[]>
```

`listGroups` is a read-only call with no side effects. For a CEO assistant, the number of
groups will be small (single digits), so fetching all groups and filtering client-side is
acceptable — no need for a per-group lookup.

**Why `listGroups` not a hypothetical `getGroup`:** signal-cli's daemon API (v0.13.x) only
exposes `listGroups`. Filtering to a specific group by ID is done client-side.

---

### 2. `OutboundGateway` — `getSignalGroupMembers()` method

The skill cannot access `SignalRpcClient` directly (not in `SkillContext`). The gateway
already holds `signalClient`, so we add a read-only method:

```typescript
async getSignalGroupMembers(groupId: string): Promise<string[]>
// Returns: E.164 phone numbers of all current (non-pending) group members.
// Throws if Signal is not configured or the group is not found.
```

This keeps the skill's dependency surface narrow — it only needs `outboundGateway` and
`contactService`, both of which it already receives.

---

### 3. `group-trust.ts` — shared trust check helper

Location: `src/channels/signal/group-trust.ts`

A pure-logic module used by both `SignalAdapter` (inbound) and `signal-send` (outbound).
Takes a list of already-resolved phone numbers and checks their contact status:

```typescript
export interface GroupTrustResult {
  trusted: boolean;
  unknownMembers: string[];   // phone numbers with no contact or provisional status
  blockedMembers: string[];   // phone numbers of blocked contacts
}

export async function checkGroupMemberTrust(
  memberPhones: string[],     // E.164 numbers, own account already excluded
  contactService: ContactService,
): Promise<GroupTrustResult>
```

**Logic per member:**
- `resolveByChannelIdentity('signal', phone)` → null | contact
- null or status `'provisional'` → unknownMember
- status `'blocked'` → blockedMember
- status `'confirmed'` (or other non-provisional/non-blocked) → trusted

`trusted: true` iff `unknownMembers.length === 0 && blockedMembers.length === 0`.

Nathan's own phone number is excluded before calling this function — it would otherwise
resolve to Curia's own contact and skew results.

---

### 4. `SignalAdapter` — inbound group trust check

When a group message arrives, before publishing to the bus:

1. Call `rpcClient.listGroups()`, find the matching group by ID.
2. Extract member phone numbers; exclude Nathan's own number (`config.phoneNumber`).
3. Call `checkGroupMemberTrust(phones, contactService)`.
4. **If any blocked member:** drop silently, return early. No notification — blocked
   contacts should not know Curia is active or monitoring the group.
5. **If any unknown member:**
   - Auto-create provisional contacts for each unknown phone number (same pattern as
     unknown 1:1 senders) so the CEO can identify them.
   - Send CEO an email notification via `outboundGateway` (see notification spec below).
   - Do NOT publish the message to the bus. The message is not stored in held-messages —
     the CEO notification contains enough context for them to ask Nathan to re-check once
     members are verified.
   - Log at `info` level (not `warn`) — this is expected behaviour, not an anomaly.
6. **If all trusted:** publish to bus normally.

**`SignalAdapterConfig` additions:**
- `ceoEmail: string` — required for group hold notifications
- `outboundGateway` remains optional but must be present for group notifications to fire.
  If absent: log.error that the notification could not be sent, but still hold the message.

**Why not use held-messages?** The held-message system is designed for individual unknown
senders where the CEO can `identify / dismiss / block` a specific sender. For groups, the
CEO needs to verify multiple people before the conversation unblocks. Storing one held
message per group message would create a confusing queue. Email notification gives the CEO
the full picture in one place; once they verify the unknowns, they can simply ask Nathan
to re-process.

**Group re-check:** When asked by the CEO to engage with a group after members are verified,
the coordinator can ask the group a question — which will trigger an inbound reply that
passes the trust check — or use `signal-send` to initiate.

---

### 5. CEO email notification format

**Subject:** `Signal group message held — member verification needed`

**Body:**
```
A Signal group message was received but held because the following group members
have not yet been verified:

+15195550123 — no verified contact
+14165559999 — no verified contact

Once you've verified these contacts, you can ask me to send a message to the group
and I'll re-check membership before engaging.

Group ID (for reference): <base64-id>
```

Phone numbers are included in raw E.164 format — unambiguous and internationally
consistent. The Group ID is included so the CEO can reference it if needed, but no
other internal system details are exposed.

The email is sent via `outboundGateway.send({ channel: 'email', ... })`. This goes
through the content filter, which will pass (system-generated content with no user data
fragments). The email is NOT sent via the CEO notification path inside the gateway (that
path is for blocked outbound content) — it is a normal outbound email send.

---

### 6. `signal-send` skill

**Location:** `skills/signal-send/`

**Manifest (`skill.json`):**

```json
{
  "name": "signal-send",
  "description": "Send a Signal message to a person (by phone number) or a group (by group ID). For 1:1 sends, use the contact's verified Signal phone number from contact-lookup — display names are not trusted for Signal identity. For group sends, all group members must be verified contacts; unverified groups cannot be messaged.",
  "version": "1.0.0",
  "sensitivity": "normal",
  "action_risk": "medium",
  "infrastructure": true,
  "inputs": {
    "recipient": "string?",
    "group_id": "string?",
    "message": "string"
  },
  "outputs": {
    "delivered_to": "string",
    "channel": "string"
  },
  "permissions": [],
  "secrets": [],
  "timeout": 30000
}
```

**Handler logic:**

1. Validate inputs:
   - `message` required, ≤ 10,000 characters (Signal's practical limit)
   - Exactly one of `recipient` or `group_id` must be set
   - If `recipient`: must match E.164 pattern (`/^\+[1-9]\d{6,14}$/`)
2. Check `ctx.outboundGateway` and `ctx.contactService` present.
3. If `group_id`:
   - Call `ctx.outboundGateway.getSignalGroupMembers(group_id)` to get member phones.
   - Exclude Nathan's own number if present. (Note: the skill doesn't know Nathan's number
     directly. The gateway's `getSignalGroupMembers` excludes it.)
   - Call `checkGroupMemberTrust(phones, ctx.contactService)`.
   - If `blockedMembers.length > 0`: return error `'Cannot send to this group — it contains a blocked contact.'`
   - If `unknownMembers.length > 0`: return error listing unknown phone numbers, e.g.
     `'Cannot send to this group — the following members are not yet verified: +15195550123, +14165559999. Please verify them first.'`
4. Call `ctx.outboundGateway.send({ channel: 'signal', recipient, groupId: group_id, message })`.
5. Map result: success → `{ delivered_to: recipient ?? group_id, channel: 'signal' }`;
   failure → `{ success: false, error: result.blockedReason }`.

**Why the skill returns an error (not sends a CEO notification):** When the coordinator
calls `signal-send`, it is in an active conversation with the CEO (via CLI or email). The
coordinator can inform the CEO inline. The email notification is reserved for the inbound
async case where the CEO is not present.

---

### 7. `OutboundGateway` — own number exclusion

`getSignalGroupMembers()` calls `listGroups()`, finds the matching group, and filters out
Nathan's own phone number (`this.signalPhoneNumber`) from the members list before returning.
This ensures callers (adapter and skill) never need to know Nathan's number to do the
exclusion.

---

## Data flow diagrams

### Inbound group message

```
signal-cli daemon
  → SignalAdapter.handleInbound()
    → convertSignalEnvelope() [not null, group message]
    → rpcClient.listGroups() → find group → extract member phones
    → exclude own phone
    → checkGroupMemberTrust(phones, contactService)
      ├─ trusted: true  → publish inbound.message to bus → normal dispatch
      ├─ blocked member → drop silently, return
      └─ unknown member → auto-create provisional contacts
                        → outboundGateway.send(email to CEO, notification)
                        → return (message not published)
```

### Outbound signal-send (coordinator-initiated)

```
Coordinator (via CEO request)
  → signal-send handler
    → validate inputs
    → [if group] outboundGateway.getSignalGroupMembers(group_id)
    → [if group] checkGroupMemberTrust(phones, contactService)
      ├─ not trusted → return SkillResult { success: false, error: "..." }
      └─ trusted → continue
    → outboundGateway.send({ channel: 'signal', ... })
      → blocked-contact check (1:1: by phone; group: by group_id — no contact record, passes)
      → content filter
      → signalClient.send()
    → return SkillResult { success: true, data: { delivered_to, channel } }
```

---

## Files changed

| File | Change |
|------|--------|
| `src/channels/signal/signal-rpc-client.ts` | Add `listGroups()` method + `SignalGroupDetails` types |
| `src/channels/signal/signal-rpc-client.test.ts` | Add tests for `listGroups()` |
| `src/channels/signal/group-trust.ts` | New — `checkGroupMemberTrust()` helper |
| `src/channels/signal/group-trust.test.ts` | New — unit tests for trust helper |
| `src/channels/signal/signal-adapter.ts` | Add inbound group trust check + CEO email notification |
| `src/channels/signal/signal-adapter.test.ts` | Add tests for group trust paths |
| `src/skills/outbound-gateway.ts` | Add `getSignalGroupMembers()` method |
| `src/skills/outbound-gateway.test.ts` | Add tests for `getSignalGroupMembers()` |
| `skills/signal-send/skill.json` | New skill manifest |
| `skills/signal-send/handler.ts` | New skill handler |
| `skills/signal-send/handler.test.ts` | New skill tests |
| `CHANGELOG.md` | Add entry under `[Unreleased]` |
| `package.json` | Bump version to `0.12.1` |

---

## Error handling

- `listGroups()` RPC failure: `SignalRpcClient.listGroups()` throws. The caller (adapter or
  gateway) catches, logs warn, and treats the group as untrusted (fail-closed). Inbound
  messages from the group are held; outbound `signal-send` returns a `SkillResult` error.
- `checkGroupMemberTrust()` DB failure: `checkGroupMemberTrust()` throws when the underlying
  `contactService.resolveByChannelIdentity()` rejects — it does **not** convert DB errors
  into unknownMembers internally. The caller is responsible for catching the exception and
  applying fail-closed behavior: log warn and treat affected members as untrusted (hold
  inbound messages; return `SkillResult { success: false }` for outbound sends).
- CEO notification email failure: log error but do NOT re-raise. The group message is still
  held. The audit log records the hold event.
- `getSignalGroupMembers()` group not found: the method **throws** (it does not return an
  empty list) when the group ID is not found in the account's group list or Signal is not
  configured. Callers catch the exception, log a warning, and surface the error. For the
  `signal-send` skill this returns `{ success: false, error: 'Group not found or Curia is not a member.' }`.

---

## Testing

**`signal-rpc-client.test.ts` additions:**
- `listGroups()` returns parsed group list with members
- `listGroups()` on socket error rejects

**`group-trust.test.ts`:**
- All members verified → `{ trusted: true }`
- One provisional member → `{ trusted: false, unknownMembers: ['+1...'] }`
- One blocked member → `{ trusted: false, blockedMembers: ['+1...'] }`
- Mixed unknown + blocked → both surfaces in result
- Empty member list → `{ trusted: true }` (edge case: empty group)

**`signal-adapter.test.ts` additions:**
- Inbound group from fully trusted group → publishes to bus
- Inbound group with unknown member → holds, sends email notification, does not publish
- Inbound group with blocked member → drops silently, no email, no publish
- Group not found in listGroups → treated as untrusted

**`handler.test.ts` (signal-send):**
- 1:1 send success
- Group send, all members trusted → success
- Group send, unknown member → error with member list
- Group send, blocked member → error
- Neither recipient nor group_id → validation error
- Both recipient and group_id → validation error
- recipient not E.164 → validation error
- message too long → validation error
- gateway returns blocked → skill returns error
- Signal not configured (no outboundGateway) → clear error message

---

## Out of scope

- **Group message replay:** When the CEO verifies unknown members after a group hold,
  the original held message is not replayed — there is no held-message record for it.
  The CEO will need to ask the group to resend or ask Nathan to check the group.
  A future iteration could store group-held messages in the held-message table.
- **Gateway-level group blocked check:** The gateway's own blocked-contact pipeline checks
  the group_id as the recipientId — there is no contact record keyed on a group_id, so it
  always passes. This is a known gap in the gateway's internal pipeline. It is compensated
  by the skill: `signal-send` runs `checkGroupMemberTrust` (which surfaces blocked members)
  *before* calling the gateway. A blocked group member causes the skill to return an error
  immediately, so the send never reaches the gateway. From the CEO's perspective, blocked
  members in a group fully prevent the outbound send — the gap is internal to the gateway
  and never surfaces.
- **Group membership change detection:** If a new member is added to a trusted group after
  Curia starts engaging, the next inbound message from that group will re-run the trust
  check and hold if the new member is unknown. This is correct behaviour but may surprise
  the CEO mid-conversation.
