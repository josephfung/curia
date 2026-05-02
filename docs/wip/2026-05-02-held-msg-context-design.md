# Held Message Notification Context Enrichment

**Issue:** [#400](https://github.com/josephfung/curia/issues/400)
**Date:** 2026-05-02

## Problem

When a message from an external contact is held (trust score below floor), the
coordinator notifies the CEO with something like "you have a held email from Nik
about 'AI Assistant'". This tells the CEO *who* sent it but not *what they asked
for*.

In a real incident, a contact sent a direct request for the CEO's full calendar
— a data exfiltration attempt beyond their granted permissions. The message was
correctly held, but the notification didn't surface the nature of the request.
The CEO only discovered what was asked during a manual debugging session.

## Approach

Prompt + skill enrichment only. No schema changes, no new infrastructure. The
coordinator LLM already reads `held-messages-list` output — give it richer data
and clearer instructions so it can describe the request's nature and flag
sensitive requests.

## Changes

### 1. Enrich `held-messages-list` skill output

**File:** `skills/held-messages-list/handler.ts`

Update the per-message summary returned by the skill:

| Field | Before | After |
|-------|--------|-------|
| `preview` | First 200 chars of raw `content` | First 500 chars of **plaintext** (HTML tags stripped) |
| `totalLength` | *(not present)* | Character count of the full plaintext body |
| `subject` | Already present | No change |
| `id`, `channel`, `sender`, `receivedAt` | Already present | No change |

**HTML stripping:** Simple regex replacement (`<[^>]+>` replaced with empty
string). Not a full DOM parser — good enough for preview extraction. Applied
before slicing to 500 chars and before computing `totalLength`.

**Edge cases:**
- Message with no HTML: stripping is a no-op, preview is first 500 chars as-is
- Message shorter than 500 chars: `preview` contains the full plaintext,
  `totalLength` matches `preview.length`
- No subject: `subject` remains `null` (no change)
- Empty content: `preview` is empty string, `totalLength` is 0

### 2. Update coordinator prompt

**File:** `agents/coordinator.yaml` (Held Messages section, lines 152-165)

Two changes:

**Channel-generic language:** Replace hardcoded "held email" with channel-aware
phrasing. The coordinator already receives the `channel` field from the skill
output. Example becomes: *"By the way, you have a held message on email from
stranger@example.com about 'Q3 Numbers'. They appear to be asking for your full
calendar. Want me to identify them?"*

**Request nature instructions:** Add guidance for the coordinator to:
- Read the `preview` and `subject` from `held-messages-list` output
- Briefly describe what the sender appears to be asking for (one clause, not a
  paragraph — the notification should stay short)
- Explicitly call out if the request involves sensitive data or actions: calendar
  access, data export, financial actions, credential/password requests
- If the preview is short relative to `totalLength`, qualify the assessment
  (e.g., "appears to be asking for..." rather than stating definitively)

No changes to the identify/dismiss/block instructions or any other coordinator
behavior.

### 3. Remove CLI held-message notification

**File:** `src/channels/cli/cli-adapter.ts` (lines 42-54)

Remove the `message.held` bus subscription that prints
`[Held] Unknown sender on {channel}: {senderId} — "{subject}"`. This
notification is vestigial — the CLI is rarely monitored, and the coordinator's
proactive mention is the real notification path.

The HTTP/SSE broadcast in the event router is unaffected — it serves
dashboard/API consumers, a different concern.

### 4. What does NOT change

- **Hold/release/dismiss mechanics** — untouched
- **Database schema** — no migrations, no new columns
- **Bus events** — `MessageHeldPayload` stays as-is (no content in the event)
- **HTTP/SSE broadcast** — stays as-is
- **Trust scoring** — untouched
- **`held-messages-process` skill** — untouched

## Testing

- **`held-messages-list` unit tests:** Verify enriched output — 500-char
  plaintext preview, HTML stripping, `totalLength` computation. Cover edge
  cases: no HTML, content shorter than 500 chars, null subject, empty content.
- **CLI adapter unit tests:** Verify the `message.held` subscription is removed
  — the adapter should not react to that event type.
- **Existing tests:** Confirm nothing else depends on the CLI notification or
  the old 200-char preview format.
- No new integration tests — the coordinator prompt change is behavioral (LLM
  output phrasing) and not deterministically testable.

## Channel Agnosticism

The design is inherently channel-agnostic. `HeldMessage` stores `channel` as a
string. The skill output includes it. The coordinator prompt instructs the LLM
to use the channel name in its notification. This works for email, Signal, or
any future channel without modification.
