# ADR-023: ceo-inbox batch draining via read-status, no watermark

Date: 2026-06-23
Status: Accepted

## Context

The `ceo-inbox` agent triages unread email on a 15-minute cron under a turn budget
(`max_turns`). A large unread burst cannot be fully triaged in one run, so the original
design (#840) added an **overflow mode**: above 10 unread, fully triage the top 5 by urgency
and convert the rest into degraded `inbox-overflow` to-do tasks (then mark them read). This
was rejected in practice (#1123): the secondary path still spends several tool calls per shed
message (so it does not actually save the budget) and pollutes the CEO's digest with to-do
noise. The desired behavior is to fully triage the inbox in fixed-size batches that continue
until the inbox is drained.

Two mechanisms for "which messages are already triaged?" were considered:

1. **Timestamp watermark** (the existing `ceo_inbox/last_processed_at`, code-owned since
   #866). It exists only because 📌 Seen / 🚨 Urgent are deliberately left *unread*; without
   it they would re-triage forever. But Nylas v3 `/messages` returns newest-first with no
   sort option, so a forward watermark + `limit` **orphans the oldest mail** in any backlog
   larger than the fetch window — the exact burst case. Correctly fetching the oldest batch
   would require backward paging plus same-timestamp-boundary handling: significant
   complexity, and a per-message watermark advance would put the value back under LLM control
   (the failure #866 fixed).

2. **Read/archive status as the marker.** Cleared/Handled/Drafted are already archived
   (removed from INBOX). If Seen/Urgent/Stuck are *also* marked read (tracked via label and,
   for Urgent, star + Signal escalation), then the unread-INBOX set IS the not-yet-triaged
   set. No watermark, no ordering, no paging, no orphaning; a budget-aborted run is harmless
   because un-settled messages stay unread and are retried.

## Decision

Adopt **read-status batching**. Each run lists one fixed-size batch of unread messages
(`ceo-inbox-list` with `limit: N`, which now also returns `has_more`), fully triages it, and
settles every message into one of two end-states: **archived** or **marked read**. If
`has_more`, the agent self-continues by re-arming a single `tag='inbox-drain'`,
`owner='curia'` task with a near-term `wake_at` (~90s), reusing the existing wake/resume
machinery; it completes that task when the inbox empties. The 15-minute cron is the backstop.
The `ceo-inbox-list` watermark (and its `received_after_hours` input) is removed entirely —
it had no other consumer — making the skill a plain "list unread" primitive.

This was chosen over the watermark approach because it is strictly simpler (deletes code
rather than adding paging), has no orphaning failure mode, keeps watermark logic out of LLM
hands, and matches the product intent ("just continue with the next batch") directly.

## Consequences

- **Simpler and correct by construction.** No watermark, ordering, paging, or
  same-timestamp edge cases. A mid-run budget abort cannot lose messages.
- **Drains any backlog** at N/run; self-continue clears it within minutes during operating
  hours rather than one batch per 15-minute tick.
- **No more to-do noise** in the CEO digest from inbox bursts.
- **Trade-off — read-status semantics change.** 📌 Seen / 🚨 Urgent are no longer left
  bold-unread; they are marked read and tracked via label (and star + Signal for Urgent).
  A message the CEO manually re-marks unread would re-enter triage (same disposition). The
  CEO's attention signal is now labels/stars, not the unread badge.
- **Trade-off — one transient control task.** The `inbox-drain` continuation task briefly
  appears in the digest's "What I'm working on" until the drain completes.
- **Pathological edge.** If ≥ `limit+1` of the very newest unread are Curia-self messages
  (filtered, never marked read), older real mail could wait. Accepted: Curia does not
  bulk-email the CEO inbox.
