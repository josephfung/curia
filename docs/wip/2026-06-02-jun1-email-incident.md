# Incident: May 2026 Reconciliation — 18-hour silence then triple reply

**Date authored:** 2026-06-02 (incident occurred 2026-06-01)
**Related issues:** [#846](https://github.com/josephfung/curia/issues/846) (poll persistence + observability), [#847](https://github.com/josephfung/curia/issues/847) (dispatcher reply-lock)

## Context

On Monday Jun 1, 2026 (EDT):

- **9:01 AM EDT** — Curia (T2125-expense-tracker) sent the monthly reconciliation reminder to Joseph. Verified: `email-send` skill at `13:01:24 UTC`, success, Nylas msg id `19e83465d868c671`.
- **9:36 AM EDT** — Joseph replied with the May credit-card CSV attached.
- **For the next 7.5 hours Curia did nothing.** Audit log has **zero** `inbound.message` events on the email channel between `13:01 UTC` and `20:27 UTC`. The Signal channel kept ingesting normally during the same window, so the agent process itself was alive.
- **4:27 PM EDT** — Joseph followed up ("Did that CSV work for the expense reconciliation?"). This message *was* ingested (`inbound.message` at `20:27:51 UTC`). The quoted-text inside it contains Joseph's 9:36 reply verbatim, so Gmail/Nylas had the CSV reply the whole time — Curia just never polled it in.
- **4:32–4:33 PM EDT** — Joseph received **three replies in rapid succession** on the reconciliation thread.

The user-visible failures are (a) the 7.5-hour stall and (b) the triple reply. They are independent bugs that compounded in the same incident. They ship as two separate issues and PRs: [#846](https://github.com/josephfung/curia/issues/846) and [#847](https://github.com/josephfung/curia/issues/847).

---

## What actually happened in the triple-reply burst

Audit reconstruction of task `b9ba279c-0d93-42c9-8aae-fcab8273eae7` (coordinator's processing of Joseph's follow-up):

| Time (UTC) | Sender                | Path                          | Body opening                                                                                        |
| ---------- | --------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| 20:32:18   | T2125-expense-tracker | direct `email-reply` skill    | "Joseph, Yes — the CSV worked. … Here's the summary: …"                                             |
| 20:33:22   | coordinator           | direct `email-reply` skill    | "Yes, it worked — the CSV processed cleanly. …"                                                     |
| 20:33:31   | coordinator           | `agent.response` → dispatcher | "Done. Replied on the thread with the reconciliation summary — 7 rows matched, 2 FX corrections, …" |

All three landed in the same Nylas thread (`19e83465d868c671`). Joseph's three emails map cleanly:
- (a) = T2125's detailed reply
- (b) = coordinator's "Yes, it worked" reply
- (c) = coordinator's wrap-up which references "the reconciliation summary" — acknowledging (a), which reads like a reply-to-its-own-reply

Joseph also received single replies on three *other* threads during the same minute — `Fwd: Joseph onboard as growth coach`, `Attach bio photo`, Armin's `Re: Coffee with Joseph this week?`. Those were legitimate one-reply-per-inbound responses to other backlogged emails; not part of this bug, but evidence the burst was the channel draining a held-up queue.

### Root cause of the triple reply

Two architectural mistakes:

1. **Fan-out without ownership.** [`dispatcher.ts` `handleAgentResponse`](../../src/dispatch/dispatcher.ts) publishes `outbound.message` for *every* `agent.response` whose task has a routing entry. The coordinator's wrap-up `agent.response` therefore always produces an extra outbound — even when the coordinator's *own* turn already called `email-reply` directly during the run. No "reply already sent on this conversation" flag is checked.

2. **Delegated specialists send their own emails.** T2125-expense-tracker was delegated by coordinator via the `delegate` skill at `20:29:23` and went on to call `email-reply` directly at `20:32:18`. Nothing forbids two agents from both replying. (Decision: leave this in place for now — see Fix 2 scope.)

---

## Root cause of the 7.5-hour silence

Smoking gun in [`email-adapter.ts`](../../src/channels/email/email-adapter.ts) — the `start()` method assigns `this.lastSeenTimestamp = Math.floor(Date.now() / 1000)` with no persistence. That value is then used as `receivedAfter` in the Nylas poll. Consequences:

- Any unread message Nylas already had at startup is invisible to the poll (`receivedAfter` excludes it).
- The poll also requires `unread: true`; a message Nylas returned once but we failed to publish (and didn't mark-read) also vanishes on a restart.
- No audit events for poll cycles, so a stalled adapter looks identical to a quiet inbox.

The Jun 2 deploy wiped Jun 1 container logs, so the exact restart/poll-fail event isn't recoverable. But the code path is sufficient to explain the symptom: a restart between 13:01 and 13:36 UTC on Jun 1 would have lost Joseph's CSV reply forever. Signal kept working because its adapter uses a stream socket, not poll-with-high-watermark.

Supporting evidence: `404 No endpoints found for google/gemini-2.0-flash-001` errors recur all day on `contacts` and `calendar` agents — an unstable upstream the platform doesn't recover from.

---

## Fix 1 — Persist email-adapter watermark + add poll observability

Tracked in [#846](https://github.com/josephfung/curia/issues/846).

**Files:**
- [`src/channels/email/email-adapter.ts`](../../src/channels/email/email-adapter.ts) — persistence + audit emission + watchdog
- [`src/bus/events.ts`](../../src/bus/events.ts) — add `channel.poll` and `channel.stalled` event types

**Storage** — reuse the KG-backed `config-store` pattern at [`skills/config-store/handler.ts`](../../skills/config-store/handler.ts) (no new table). The skill itself is LLM-facing, so factor its underlying read/write into a small internal service (e.g. `ConfigStore` in `src/memory/`) that both the skill and the email-adapter can call. Persist as:

- namespace: `system:email-poll-state`
- key: `{accountId}.last_seen_at`
- value: epoch seconds (string)

On `start()`:
1. Try to read the persisted value via `ConfigStore`.
2. If missing, fall back to `Math.floor(Date.now() / 1000)` (first boot).
3. After each successful in-loop watermark advance, upsert the new value. Don't write on every poll — only when it actually advances.

**Observability:**
- Emit a `channel.poll` audit event per cycle with `{ accountId, channel: 'email', fetched, processed, skipped: { sent_folder, recently_sent, self, excluded, failed }, lastSeenAt, durationMs }`. One event per poll, not per message.
- Add a watchdog: if no successful `channel.poll` completes within `5 × pollingIntervalMs` (default 150s), emit `channel.stalled`. No self-heal — failure mode was silent, not crashed; surfacing it is enough.

### Verification (Fix 1)
- Integration test in `tests/integration/email-adapter-persistence.test.ts`: start adapter, ingest a fake message (advance watermark), stop, restart, verify the new adapter's `lastSeenTimestamp` matches the persisted value and a message dated *before* restart is **not** re-processed.
- Integration test: stub `outboundGateway.listEmailMessages` to throw for 6× polling interval; assert one `channel.stalled` event in `audit_log`.
- Prod smoke after deploy: `SELECT count(*), max(timestamp) FROM audit_log WHERE event_type='channel.poll' AND payload->>'channel'='email'` — expect ~120/hr at 30s interval. Any gap > 90s implies the watchdog should have fired; if it didn't, the watchdog itself is broken.

---

## Fix 2 — Dispatcher reply-lock (one outbound per inbound)

Tracked in [#847](https://github.com/josephfung/curia/issues/847).

**File:** [`src/dispatch/dispatcher.ts`](../../src/dispatch/dispatcher.ts)

**Mechanism:**
- Add a `humanReplySent: boolean` field to the routing entry stored in `taskRouting`.
- The dispatcher already observes `skill.result` events on the bus (it has subscriptions). Wire a subscriber: when a `skill.result` for `email-reply` or `email-send` resolves with `success=true` and the recipient matches the routing entry's `senderId`, set `humanReplySent = true` on the routing entry keyed by the task chain root.
  - "Task chain root" = the originating `agent.task` that has a routing entry. T2125's delegated task has the coordinator's task as ancestor via `parentEventId` — walk the chain to find the routed root. Use the existing `originator` field already added in migrations 040/041 if it carries enough info; otherwise extend `taskRouting` to track child task IDs.
- In `handleAgentResponse`: if `routing.humanReplySent === true`, **skip** the `createOutboundMessage` publish. Instead emit an `outbound.suppressed_duplicate` audit event with `{ routingTaskId, agentId, conversationId, reason: 'human_reply_already_sent' }`. The wrap-up content is still preserved as the `agent.response` payload in `audit_log` — nothing is lost, only the duplicate send.
- Do not touch the `email-reply` skill handler itself; ownership lives in the dispatcher.

**What this fixes (and doesn't):**
- Fixes the (c) case from Jun 1 — coordinator's `agent.response` triple. ✅
- Does **not** prevent (a)+(b) — T2125 and coordinator both calling `email-reply` directly is still possible. That's deliberate per the chosen scope. If we see it recur in prod we'll do Fix 2b (specialist email policy) as a follow-up.

### Verification (Fix 2)
- Unit test on `handleAgentResponse`: routing entry with `humanReplySent=true` → no `bus.publish('dispatch', outbound)`; one `outbound.suppressed_duplicate` audit event recorded.
- Integration test in `tests/integration/dispatcher-reply-lock.test.ts`: publish one `inbound.message`; stub coordinator to (1) call `email-reply` skill, then (2) produce an `agent.response` with content. Assert **exactly one** `outbound.message` event published and one `outbound.suppressed_duplicate` audit event.
- Integration test for the delegated case: coordinator → delegate to specialist → specialist calls `email-reply` → both produce `agent.response`. Assert exactly one outbound from the specialist's reply path, suppressed for the coordinator's wrap-up.
- Manual prod smoke: after deploy, send a test email that would have triggered the old duplicate path; verify only one reply arrives and one `outbound.suppressed_duplicate` shows in `audit_log`.

---

## Workflow notes

Both implementation PRs go through the standard worktree workflow (see [CLAUDE.md](../../CLAUDE.md)):

1. Each fix in its own worktree: `worktrees/curia-fix-poll-persistence` and `worktrees/curia-fix-reply-lock`.
2. TDD: write the integration tests first.
3. `pnpm --prefix <worktree> run typecheck` + full test suite before commit.
4. CHANGELOG entry under `## [Unreleased]` for each PR.
5. Run `pr-review-toolkit:code-reviewer` and `pr-review-toolkit:silent-failure-hunter` before opening the PR.

## Open question

T2125 currently uses `email-send` (not `email-reply`) for the morning reminder. Fix 2's reply-lock only triggers for replies on a routed inbound, so the reminder send is unaffected — confirming the intent: the morning reminder remains agent-initiated and bypasses the lock.
