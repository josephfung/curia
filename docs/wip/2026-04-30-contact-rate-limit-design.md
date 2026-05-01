# Contact Auto-Creation Rate Limiting — Design

**Issue:** #36 — Rate-limit contact auto-creation from email participants to prevent spam flooding  
**Date:** 2026-04-30  
**Status:** Design approved

## Problem

The email channel adapter auto-creates contacts from every inbound email
participant (From/To/CC) with source `email_participant`. There is no rate
limit, no per-message cap, and no maximum contact count. A spam campaign
sending thousands of emails from unique senders could flood the contacts
table and knowledge graph with spam-originated records, degrading lookup
performance and polluting entity memory search results.

## Decision

In-memory rate limiting in the email adapter with CEO notification via the
existing `outbound.notification` bus event. No schema changes, no new tables,
no queuing of skipped participants.

### Why in-memory (not Postgres-backed)

This is anti-flood protection — guardrails against abuse, not throttles on
normal business. The counters don't need to survive process restarts (a
restart resets the window, which is fine — spam doesn't survive restarts
either). Promoting to Postgres later is straightforward if the need arises.

## Design

### Two rate limits

1. **Per-message cap (default: 10)** — maximum new contacts created from a
   single email's participant list. A board email can easily have 10
   participants; this cap prevents a single email with 200 CC recipients from
   flooding the contacts table. Existing contacts (already in the DB) are
   free lookups and do not count toward this cap.

2. **Per-hour cap (default: 100)** — maximum new contacts created from email
   across all messages within a sliding one-hour window, per email account.
   This prevents a sustained spam campaign from creating thousands of contacts
   over time. The window is a simple `{ count, windowStart }` tuple — when
   `Date.now() - windowStart > 3600000ms`, the counter resets.

Both limits are checked before each `createContact` call. The per-message cap
is checked first (cheaper — a loop counter), then the hourly cap.

### Check order within `extractParticipants()`

For each participant in the email:

1. Skip self-email (existing behavior)
2. Check if contact already exists via `resolveByChannelIdentity` (existing behavior)
3. If new contact needed:
   a. Check per-message counter — if `>= max_per_message`, skip and record
   b. Check hourly counter — if `>= max_per_hour`, skip and record
   c. Create contact and link identity (existing behavior)
   d. Increment both counters

### CEO notification

When either cap is hit, the adapter publishes an `outbound.notification`
event via `OutboundGateway.sendNotification()` — the same path used for
blocked-content and group-held alerts. The CEO receives an email (non-urgent,
no CLI notification).

The notification includes:
- Which limit was hit (per-message or hourly)
- How many participants were skipped
- The email subject and sender that triggered it

**Deduplication:** At most one notification per limit type per hour. A simple
`lastNotifiedAt` timestamp per limit type prevents notification spam when a
flood triggers repeated rate-limit hits.

### Configuration

New block in `config/default.yaml`:

```yaml
contact_creation_limits:
  max_per_message: 10
  max_per_hour: 100
```

Passed to `EmailAdapter` via config. Falls back to hardcoded defaults if the
config block is absent (backward compatibility).

### Skipped participant handling

- **Logged** at `warn` level with the participant email and which limit
  triggered it (structured pino fields)
- **Not persisted** for later retry — anti-flood protection, not a queue. If
  a legitimate large-CC email triggers the cap, those contacts will be created
  naturally when those people reply individually
- **Notification body** includes the skip count and triggering email subject,
  but not the full list of skipped email addresses (to avoid the notification
  itself becoming a spam vector if the original email was malicious)

## Changes

| File | Change |
|------|--------|
| `src/channels/email/email-adapter.ts` | Add rate-limit counters, modify `extractParticipants()` to check caps, publish notification on limit hit, add dedup logic |
| `src/bus/events.ts` | Add `'contact_rate_limited'` to `OutboundNotificationPayload.notificationType` union |
| `config/default.yaml` | Add `contact_creation_limits` block |
| `tests/unit/channels/email/email-adapter.test.ts` | 7 new test cases |

No new files, no schema migrations, no new bus event types.

## Test plan

1. **Per-message cap** — email with 15 participants, assert only 10 contacts created
2. **Hourly cap** — simulate 100 creations across poll cycles, assert 101st is skipped
3. **Window reset** — advance time past 1-hour boundary, assert creation resumes
4. **Existing contacts don't count** — 12 participants, 5 existing, assert 7 created (under cap)
5. **Notification fires once** — hit limit twice within an hour, assert one `outbound.notification`
6. **Notification includes context** — assert payload contains subject line and skip count
7. **Config override** — pass custom limits, verify they're respected
