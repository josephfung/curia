# send-draft: CEO-authorized draft send

**Issue:** [#414](https://github.com/josephfung/curia/issues/414)
**Date:** 2026-05-02
**Status:** Approved

## Context

When Curia saves a draft email (draft_gate policy, autonomy_gated fallback, or
observation-mode triage), the CEO's normal discovery path is to find it in their
Drafts folder or via the end-of-day Signal digest. That path works.

The gap is the urgent case: CEO receives a Signal ping about a draft and replies
"send it, I trust your judgment." Today Curia cannot honour that — the policy gate
would create a second draft instead of sending the first.

Issue #414 identifies two problems:

1. **No draft registry.** Curia can't look up "the draft I created for thread X"
   because the Nylas draft ID is only in the audit log, not queryable by context.

2. **Policy gate blocks the send.** `dispatchByPolicy()` routes back to
   `createEmailDraft()` even when the CEO has explicitly approved.

## Decisions made during design

### No `pending_drafts` table

The original issue spec included a `pending_drafts` Postgres table as a draft
registry. This was rejected: Nylas already maintains a queryable DRAFTS folder,
and a shadow PG table would immediately start drifting whenever the CEO manually
sends, edits, or deletes a draft from Gmail.

**Nylas DRAFTS folder is the source of truth.** The coordinator uses the existing
`email-list` skill (which already supports `folders: ['DRAFTS']`) to look up
drafts by context before calling `send-draft`.

### No distinction between Curia-created vs CEO-created drafts

Not needed. The end-of-day digest can list all drafts in the folder; there is no
operational need to filter by author.

### No new gateway method

A dedicated `sendApprovedEmailDraft()` gateway method was considered and rejected:
it sets a precedent that every CEO-approved action type needs its own method. The
right general pattern is a `humanApproved: true` option on the existing
`gateway.send()` — works for any channel, not just email. See ADR-017.

### Threading via thread lookup, not Nylas draft-send API

Rather than adding `drafts.send()` to NylasClient, the handler reconstructs the
send request from the draft's content and resolves `replyToMessageId` by looking
up the latest message in the draft's thread — the same pattern
`email-adapter.sendOutboundReply()` already uses. This avoids expanding the
NylasClient interface and keeps the send path through the standard
`gateway.send()` pipeline.

### `action_risk: "none"`

This skill is not an autonomous action. It is a CEO-directed action — the CEO is
explicitly in the loop at the moment of invocation. The `action_risk` system
governs autonomous Curia decisions; it is the wrong gate for CEO-authorized ones.

The real enforcement is the task-origin check (see below). Raising `action_risk`
to `"medium"` would block legitimate CEO-approved sends when the autonomy score
is below 70, defeating the scenario this feature was designed for, while providing
no meaningful defence against the only real failure mode (a bug in `ceoInitiated`
stamping).

See ADR-017 for the full reasoning and the general pattern.

---

## Design

### 1. `send-draft` skill

**Location:** `skills/send-draft/`

**skill.json highlights:**

```json
{
  "name": "send-draft",
  "description": "Send a draft email that the CEO has explicitly authorized. Only call this skill when the CEO has directly instructed Curia to send a specific draft. Do NOT call this autonomously or infer authorization from ambiguous messages.",
  "action_risk": "none",
  "inputs": {
    "draft_id": "string (Nylas draft ID to send)",
    "account": "string (named email account the draft lives in, e.g. 'joseph')"
  },
  "outputs": {
    "message_id": "string",
    "to": "string",
    "subject": "string"
  },
  "capabilities": ["outboundGateway", "bus"]
}
```

**Handler flow:**

```
1. Task-origin check
   └─ ctx.taskMetadata?.ceoInitiated === true?
      ├─ no  → return { success: false, error: 'send-draft requires direct CEO authorization...' }
      └─ yes → continue

2. Fetch draft
   └─ outboundGateway.listEmailMessages({ folders: ['DRAFTS'] }, account)
      filter client-side for id === draft_id
      └─ not found → return { success: false, error: 'Draft not found...' }

3. Resolve reply threading
   └─ if draft.threadId:
        outboundGateway.listEmailMessages({ threadId: draft.threadId, limit: 1 }, account)
        replyToMessageId = latestThreadMessage?.id
      else: replyToMessageId = undefined (draft is a new message, not a reply)

4. Build send request
   └─ { channel: 'email', accountId: account, to: draft.to[0].email,
         subject: draft.subject, body: draft.body, replyToMessageId }

5. Send via gateway
   └─ outboundGateway.send(sendRequest, { humanApproved: true })
      ├─ blocked (content filter / blocked contact) → return { success: false, error: reason }
      └─ success → continue

6. Publish human.decision event (see §4)

7. Return { success: true, data: { message_id, to, subject } }
```

### 2. Gateway change

Single addition to `OutboundGateway.send()` options:

```typescript
options?: {
  skipNotificationOnBlock?: boolean; // existing
  humanApproved?: boolean;           // new — skips Step 0 (autonomy gate) only
}
```

When `humanApproved: true`:
- **Step 0 (autonomy gate):** skipped — the CEO is in the loop, autonomous-action
  gating does not apply
- **Step 1 (blocked-contact check):** runs normally
- **Step 2 (content filter):** runs normally
- **Step 3 (channel dispatch + contact promotion):** runs normally

This is intentionally narrow. `humanApproved: true` is not "skip all safety
checks" — it is specifically "the human is in the loop so the autonomy gate does
not apply." All other safety invariants are preserved.

### 3. Task-origin enforcement

The dispatch layer already stamps `observationMode: true` into inbound message
metadata for monitored-inbox tasks. The same mechanism is extended to stamp
`ceoInitiated: true`, `senderId`, and `channelId` when the inbound message's
sender matches the CEO's known channel identities (Signal number, email address —
available from the executive profile).

These fields flow through the same propagation path as `observationMode`:
inbound message metadata → agent task payload → `ctx.taskMetadata`.

**Why this is a hard gate:**

The LLM cannot set `ctx.taskMetadata`. Task metadata is stamped by the dispatch
layer in TypeScript code before the coordinator sees the task. A prompt injection
attempt in an external email cannot set `ceoInitiated: true` — observation-mode
tasks (`observationMode: true`) explicitly do not receive this flag.

If the dispatch layer has a bug that incorrectly stamps `ceoInitiated: true`,
that is a bug in the dispatch layer, not in `send-draft`. The fix is to make
`ceoInitiated` stamping reliable. Raising `action_risk` would not protect against
this failure mode — it would only block legitimate CEO-approved sends.

### 4. `human.decision` event

Published to the bus after a successful send:

| Field | Value |
|---|---|
| `decision` | `'approve'` |
| `deciderId` | `ctx.taskMetadata.senderId` |
| `deciderChannel` | `ctx.taskMetadata.channelId` |
| `subjectSummary` | `"CEO authorized send of draft '${subject}' to ${recipient}"` |
| `contextShown` | `['draft_id', 'draft_subject', 'draft_recipient']` |
| `presentedAt` | `new Date(draft.date * 1000)` — draft creation time as proxy |
| `decidedAt` | `new Date()` |
| `defaultAction` | `'block'` — what the autonomy gate would have done |
| `parentEventId` | `ctx.taskEventId` |

### 5. Coordinator registration

Add `send-draft` to `pinned_skills` in `agents/coordinator.yaml`.

**Not** added to `agents/email-triage.yaml` — the triage agent creates drafts; it
never handles CEO responses. The coordinator is the agent that receives CEO
Signal/email messages, making it the only agent where this skill is meaningful.
Triage agent tasks are triggered by observation-mode inbound emails, which
explicitly do not receive `ceoInitiated: true`, so the task-origin check would
hard-reject every invocation even if the skill were pinned there.

---

## Acceptance criteria

From issue #414, reframed for this design:

- [ ] `send-draft` skill implemented and registered in coordinator's `pinned_skills`
- [ ] When CEO says "send it" in reply to a draft notification, coordinator invokes
      `send-draft` and the message is delivered
- [ ] Task-origin check enforced: invocations from non-CEO-initiated tasks return
      a hard error before any Nylas call is made
- [ ] `human.decision` event logged with `decision: 'approve'` and the `draft_id`
- [ ] Content filter still runs — `send-draft` is not a filter bypass
- [ ] Blocked-contact check still runs
- [ ] `humanApproved: true` option added to `OutboundGateway.send()`;
      autonomy gate skipped when set; all other checks unaffected
- [ ] `ceoInitiated` stamped into task metadata by dispatch layer for messages
      from CEO's verified identities
- [ ] ADR-017 written documenting the CEO-authorized action pattern

## Out of scope

- `pending_drafts` table (rejected — Nylas DRAFTS folder is the registry)
- Stale draft flagging in end-of-day digest (tracked separately in #403)
- Multi-draft disambiguation UI (coordinator handles this via `email-list` before
  calling `send-draft`)
