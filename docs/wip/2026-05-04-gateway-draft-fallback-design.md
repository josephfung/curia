# Design: Lift Autonomy Draft-Fallback to OutboundGateway

**Issue:** #435
**Date:** 2026-05-04
**Status:** Draft

## Context

When the autonomy gate blocks an outbound email send, the email adapter
currently handles the fallback to draft creation internally via
`dispatchByPolicy()`. This creates three problems:

1. **Redundant gating** — the email adapter runs its own autonomy score
   check (the `autonomy_gated` policy path), duplicating the platform-wide
   gate in `OutboundGateway.send()` (score < minScoreForActionRisk('medium')).
2. **Context threading** — the adapter lacks task context (`taskEventId`,
   `conversationId`), so writing `autonomy_action_log` rows requires
   extending event payloads to give it information the gateway already has.
3. **Inconsistent channel layer** — the email adapter does autonomy logic
   that no other adapter does.

Additionally, observation-mode accounts create drafts as their primary
output, but these drafts are untracked — the CEO discovers them in Gmail
rather than through the pending-actions-digest.

This design lifts the draft-fallback decision to the gateway, simplifies
the email adapter to a pure transport, and unifies draft tracking for both
autonomy-gated and observation-mode drafts.

## Design

### 1. Gateway: Two-Step Gated Draft Pattern

**Gated result with action_log.** When `OutboundGateway.send()` gates a
message (score below threshold), it:

- Writes an `autonomy_action_log` row: `outcome = 'pending_approval'`,
  `source = 'autonomy_gate'` in payload, task context from the existing
  call chain, a generated `short_ref` (prefix `email-`), and a
  human-readable description
- Returns `{ success: false, gated: true, actionRef: '<short_ref>' }`

The row is initially created WITHOUT a `draftId` — the adapter provides
that in the next step.

**`linkGatedAction(actionRef, payload)` method.** New gateway method that
updates the action_log row's payload with the adapter's fallback result
(draft ID, account, recipient, subject). This is the adapter's way of
saying "here's what I did in response to the gate."

Graceful handling: unknown actionRef is a no-op (no throw), logged at
warn. This prevents failures if the action_log row expired or was cleaned
up between the gate and the link.

**Threshold change.** Replace the hardcoded `70` in the gateway's autonomy
gate with `AutonomyService.minScoreForActionRisk('medium')`. One source
of truth for the threshold.

### 2. Email Adapter: Pure Transport

**Remove autonomy logic from `dispatchByPolicy()`.** The `autonomy_gated`
policy path is deleted entirely. The adapter no longer reads autonomy
scores or has an `autonomyService` dependency.

**New outbound subscriber flow:**

```
outbound.message received for this account
  ├── policy == 'draft_gate'
  │     → createEmailDraft() directly (config-level, no action_log)
  │
  └── policy == 'direct'
        → gateway.send(msg)
        ├── result.success == true → done, email sent
        └── result.gated == true
              → gateway.createEmailDraft(msg) on this account
              → gateway.linkGatedAction(result.actionRef, {
                    draftId, accountId, recipientEmail, subject
                })
```

**Policy config.** Keep `direct` and `draft_gate` as named policy values.
Remove `autonomy_gated` from the `OutboundPolicy` type and remove the
`autonomyThreshold` and `autonomyService` fields from
`EmailAdapterConfig` (only used by the deleted path). This is a breaking
config change — any deployment using `autonomy_gated` must switch to
`direct` (the gateway handles autonomy gating now).

### 3. Observation-Mode Draft Tracking

Observation-mode accounts create drafts as their primary output via skill
handlers (not via the adapter's policy dispatch). These drafts are
currently untracked.

**Skill-level action_log write.** When a skill creates a draft because
`taskMetadata.observationMode === true`, the skill writes an
`autonomy_action_log` row directly:

- `outcome: 'pending_approval'`
- `source: 'observation_mode'` in payload
- Includes `draftId`, `accountId`, `recipientEmail`, `subject`
- `short_ref` with `email-` prefix
- Description follows the same format as autonomy-gated drafts

The skill has access to `ctx.taskEventId`, `ctx.conversationId`, and
`ctx.actionLogRepo` — no context threading needed.

### 4. send-draft Transitions the Action Log Row

When the CEO uses `send-draft` to approve a draft:

1. Skill calls `gateway.sendEmailDraft(draftId, account, meta, { humanApproved: true })` — unchanged
2. On success, skill queries action_log for rows where `payload.draftId` matches
3. If found, transitions the row to `outcome: 'approved'`
4. Publishes `human.decision` event — unchanged

Best-effort: if no matching action_log row exists (pre-existing drafts,
draft_gate drafts), send-draft still works normally.

### 5. Unified Action Log Row Format

Both autonomy-gated and observation-mode draft rows use the same schema:

**Payload (JSONB):**
```json
{
  "draftId": "nylas-draft-xyz",
  "source": "autonomy_gate",
  "accountId": "curia",
  "recipientEmail": "kevin@example.com",
  "subject": "Quarterly review meeting"
}
```

**Description (human + LLM readable):**
```
Draft reply to kevin@example.com — "Quarterly review" (curia). Use send-draft to approve.
```

The description does NOT include the `short_ref` — the digest line
format handles placement (see section 7). The `source` field
distinguishes draft provenance for the digest and future analytics.

### 6. Coordinator Contract

When a send is gated and a draft is created, the skill result returned
to the coordinator MUST include:

- Clear indication: "draft created" (not "email sent")
- The `short_ref` for the draft action
- The draft recipient and subject
- The account the draft was created on
- A suggestion to use `send-draft` for approval

This is the testable contract for LLM ergonomics — if the result is
clear and complete, the coordinator can tell the CEO what happened and
what to do next.

### 7. Pending Actions Digest

The existing `pending-actions-digest` skill already surfaces all
`pending_approval` action_log rows. After this refactor, both
autonomy-gated and observation-mode drafts appear alongside gated
skill invocations.

**Updated line format** (minor change to `pending-actions-digest`):
```
{description} [{skillName}] — {timeRemaining} [{shortRef}]
```

The current digest format puts `shortRef` first (`EMAIL-A3: ...`).
Moving it to the end improves scannability — the human-readable
description leads, the machine-friendly reference trails.

The `source` field in the payload lets the digest group or annotate
items by provenance if needed in the future.

### 8. Multi-Account Behavior

One EmailAdapter instance per account. The autonomy gate is global
(one score). When a send is gated:

- The draft is created on the SAME account that received the outbound
  event (routed by `accountId` in the event payload)
- The action_log row includes `accountId` in payload for disambiguation
- Multiple accounts can be gated simultaneously — each gets its own
  action_log row

Config-level `draft_gate` accounts create drafts without action_log rows
(static policy, not a dynamic decision).

## Testing Strategy

### Layer 1: Gateway Unit Tests (`outbound-gateway.test.ts`)

| Test | Verifies |
|------|----------|
| `send()` returns `{ gated: true, actionRef }` when score < threshold | Result shape contract |
| `send()` writes action_log row with `pending_approval` on gate | Side effect of gating |
| Action_log row has correct `taskEventId`, `conversationId`, `short_ref` | Context threading |
| Action_log payload has message metadata (recipient, subject) | Audit trail |
| `linkGatedAction(ref, payload)` updates row's payload | Link mechanism |
| `linkGatedAction()` with unknown ref is no-op | Graceful handling |
| Gateway uses `minScoreForActionRisk('medium')` not hardcoded 70 | Threshold derivation |
| Existing `humanApproved: true` tests still pass | Regression guard |
| `createEmailDraft()` still un-gated | Drafts remain safe |

### Layer 2: Email Adapter Unit Tests (`email-adapter.test.ts`)

| Test | Verifies |
|------|----------|
| `direct` policy calls `gateway.send()` | Basic routing |
| On `{ gated: true }`, adapter calls `createEmailDraft()` | Fallback behavior |
| On `{ gated: true }`, adapter calls `linkGatedAction()` with draft ID | Link step |
| `draft_gate` policy calls `createEmailDraft()` directly | Config-level draft |
| `draft_gate` does NOT write action_log | No tracking for config drafts |
| No autonomy score reads in adapter | Negative test |

### Layer 3: Observation-Mode Skill Tests

| Test | Verifies |
|------|----------|
| Skill writes action_log with `source: 'observation_mode'` | Observation tracking |
| Action_log row has correct draftId, accountId, recipient, subject | Payload completeness |
| Skill result message says "draft created" with short_ref | Coordinator contract |

### Layer 4: send-draft Skill Tests (`handler.test.ts`)

| Test | Verifies |
|------|----------|
| On success, queries action_log for matching draftId | Transition lookup |
| If found, transitions to `approved` | State machine |
| If no row found (pre-existing draft), still succeeds | Graceful degradation |
| Works for both `autonomy_gate` and `observation_mode` source rows | Unified resolution |

### Layer 5: Flow Integration Test (new file)

Full path test:

```
Setup:
  - Wire EventBus, ExecutionLayer, OutboundGateway, EmailAdapter
  - Set autonomy score below threshold
  - Mock Nylas API

Autonomy-gated flow:
  1. Trigger outbound.message → gateway.send() → gated
  2. Assert: adapter creates draft on correct account
  3. Assert: adapter links action_log with draftId
  4. Assert: action_log row: pending_approval, source=autonomy_gate
  5. Simulate send-draft → assert: row transitions to approved

Observation-mode flow:
  1. Skill creates draft with observationMode context
  2. Assert: action_log row: pending_approval, source=observation_mode
  3. Simulate send-draft → assert: row transitions to approved

Multi-account:
  - Two adapters (different accounts), both gated
  - Assert: each creates draft on its own account
  - Assert: separate action_log rows with correct accountId

Negative cases:
  - Score >= threshold: sends directly, no draft, no action_log
  - draft_gate policy: drafts without action_log
```

### Layer 6: Skill Result Message Tests

| Test | Verifies |
|------|----------|
| Gated send returns result distinguishing "draft created" from "sent" | LLM gets clear signal |
| Result includes short_ref, recipient, subject, account | Coordinator has context |
| Result suggests send-draft as next action | LLM affordance |

## Files to Modify

- `src/skills/outbound-gateway.ts` — add gated result, linkGatedAction(), derive threshold
- `src/channels/email/email-adapter.ts` — remove autonomy logic, add gated-fallback handling
- `src/config.ts` — remove `autonomy_gated` from OutboundPolicy type
- `skills/send-draft/handler.ts` — add action_log transition on successful send
- `skills/pending-actions-digest/handler.ts` — move shortRef to end of line format
- `skills/*/handler.ts` — observation-mode skill(s) that create drafts: add action_log write
- `tests/unit/skills/outbound-gateway.test.ts` — new gateway tests
- `tests/unit/channels/email/email-adapter.test.ts` — updated adapter tests
- `skills/send-draft/handler.test.ts` — updated send-draft tests
- `skills/pending-actions-digest/handler.test.ts` — updated format test
- `tests/integration/draft-fallback-flow.test.ts` — new integration test

## Out of Scope

- LLM eval tests (coordinator judgment in gated scenarios) — follow-up
- Changing the autonomy scoring pass to treat draft outcomes differently
- Observation-mode as a standalone feature — only the action_log tracking
  aspect is in scope here
