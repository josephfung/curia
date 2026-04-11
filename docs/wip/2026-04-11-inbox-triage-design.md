# Inbox Triage — Phase 1 Design

## Goal

Replace the observation-mode "summarise everything" behaviour with a 4-way triage protocol. When an email arrives in a monitored inbox, Curia classifies it and acts — silently for routine work, via a high-urgency channel notification only for items that genuinely need the CEO's attention.

## Background

`observation_mode: true` per-account config (shipped in PR #294) routes emails from a monitored inbox to the coordinator with a preamble injected by the dispatcher. The original preamble instructed the coordinator to summarise every email — creating noise and doubling email volume. This design replaces that preamble with a triage protocol.

## Scope

**In scope:**
- Updated observation-mode preamble in `src/dispatch/dispatcher.ts`
- New `skills/email-archive/` skill (Nylas archive API)
- `agents/coordinator.yaml` updates: pin `email-archive`, add triage guidance

**Out of scope:**
- `email-list`, `email-get`, `email-draft-save` skills (CEO inbox plan Tasks 7–10, separate PR)
- Sub-agent delegation architecture (see Option C issue — future)
- Weekly activity digest (future)
- Headshot / file-sharing capability (requires Google Drive integration)

## Triage Protocol

The observation-mode preamble (injected into `taskContent` in `dispatcher.ts`) replaces "summarise what arrived" with:

```
[OBSERVATION MODE — monitored inbox]
This email arrived in a monitored inbox. You watch it on the CEO's behalf.
You are NOT the recipient. NEVER reply to the sender as yourself or sign with your name.

TRIAGE — evaluate in order:

1. STANDING INSTRUCTIONS: use entity-context to look up the sender. If the CEO has
   given you a standing instruction for this sender or email type, follow it.

2. CLASSIFY and act:
   - URGENT — time-sensitive, requires CEO decision, from a known contact:
     Send the CEO a message on a high-urgency channel (e.g. Signal): sender, subject,
     one-sentence summary, key ask. Do NOT reply to the sender.
   - ACTIONABLE — calendar booking, add attendee, change location, clear task:
     Do it using your existing skills. No notification. It will appear in the weekly log.
   - NEEDS DRAFT — a reply is warranted and you can write it:
     Save a draft with email-reply. The CEO will review before it sends.
   - NOISE — receipt, newsletter, automated notification, no action needed:
     Call email-archive. No notification.

3. WHEN IN DOUBT: default to URGENT (notify) rather than acting silently.
   It is better to surface something than to quietly act on it incorrectly.
```

## `email-archive` Skill

**Location:** `skills/email-archive/`

**Purpose:** Archive an email via Nylas. For Gmail, archiving = removing from INBOX (Nylas `folders` update endpoint). Reversible, low-risk.

**Interface:**

```typescript
// Input (snake_case to match skill.json manifest convention)
{
  message_id: string;  // Nylas message ID
  account: string;     // "curia" | "ceo" | any configured account name
}

// Output (SkillResult pattern)
{ success: true }
{ success: false, error: string }
```

**Nylas implementation:** `PUT /v3/grants/{grantId}/messages/{messageId}` with `{ "folders": [] }` (removes INBOX label on Gmail; equivalent archive on other providers). Uses the existing per-account `NylasClient` resolution pattern (same as `email-reply` and `email-send`).

**`skill.json`:**
- `action_risk: "low"` — reversible folder move, internal only
- `infrastructure: true` — requires `nylasEmailClient` / `nylasCeoEmailClient` from `SkillContext`

## `coordinator.yaml` Updates

1. Add `email-archive` to the pinned skills list.
2. Add a "Monitored Inbox Triage" section to the system prompt explaining the 4 categories in standing context (the preamble handles per-email direction; the system prompt teaches the coordinator how to generalise the categories across different email types and standing instructions).

## Logging

All triage actions (archive, notify, draft, calendar change) already flow through the audit logger via the normal skill execution path. No additional logging infrastructure needed. A future weekly digest report can query the audit log for observation-mode actions.

## Standing Instructions

The coordinator uses `entity-context` to look up the sender before classifying. If the CEO has previously said "always archive receipts from Stripe" or similar, that instruction is stored as a KG fact on the Stripe entity. The coordinator reads it and follows it before applying the 4-way classification.

No new KG infrastructure is needed — `entity-context` already retrieves facts. The coordinator's existing memory and KG tooling handles this.

## Future: Option C (Sub-agent Delegation)

As the number of triage patterns grows, the coordinator will delegate to configured sub-agents (e.g., a `receipts-handler` agent). The triage protocol above is the first step in that direction: the "STANDING INSTRUCTIONS" step in the protocol is where delegation will be inserted. See the Option C GitHub issue for the full architecture.
