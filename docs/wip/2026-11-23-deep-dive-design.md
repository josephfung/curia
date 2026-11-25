# Deep dive (#2362) — design

Status: draft, 2026-11-23. Builds to the contract in
`docs/wip/2026-11-20-onboarding-program-design.md` §12. Background:
`docs/wip/2026-10-29-onboarding-journey-design.md` §2.3–2.5 and "Priorities: scope".

## Intent

The "aha" moment of onboarding: Curia reads about 90 days of the principal's history once and
comes back with three drafts — working rules, where the time went (and "what are you trying to
move?"), and writing voice. The principal edits them, and the confirmed ones become what every
agent works from. Contacts are backfilled from the same read. Separately, Curia keeps a
**priorities** document current and weighs its work against it, on every install, whether or
not the deep dive ran.

## Goals

- One deterministic scan into a stored **history summary**. Everything downstream reads the
  summary, never the mailbox.
- Drafts the principal edits in Google Docs, reviewed in the onboarding Review session, and
  imported only on confirmation.
- A priorities document the coordinator sees every turn, kept small.
- Contacts backfill of real correspondents.

## Non-goals

- Google Docs comment handling, or inferring when a doc is "done" (#2712).
- ceo-inbox and calendar pinning the priorities document.
- Document version history; priority progress tracking (the split below leaves room for it).
- A pre-run cost estimate; a retry loop on Workspace failure.

## Anti-goals

- **A Google client in Curia.** No TypeScript creates, shares, reads or edits a Google Doc.
  The coordinator does that with the existing `google-workspace` MCP tools.
- **New system code to write documents agents already know how to write.** Rules are written
  by the agents that own them; voice and priorities by the coordinator's existing tools.
- **Coordinator prompt growth beyond the priorities pin.** The coordinator does not pin the
  rules documents.
- **Inferred goals.** The priorities draft shows where time went and asks; it states no goals.
- Anything from a draft taking effect before the principal confirms that document.

## Approaches considered

1. **Code pipeline for the scan and drafting; coordinator for Google and the import (chosen).**
   Deterministic, testable that drafts read only the summary, cost measurable, and almost no
   new write paths: the import reuses delegation and existing tools.
2. **Code pipeline end to end** (in-process Google Docs client, system-side writes to the rules
   docs across the doc-write guard). Most testable, but builds a Google integration and
   duplicate document-writing code. Rejected: overbuilds.
3. **A coordinator task, like the homework,** running everything with tools. Least code, but
   the scan is unpredictable, "one read" is unprovable and cost is hard to bound. Rejected.

Within (1), the rules import: **delegate** to ceo-inbox and calendar (chosen) rather than have
the coordinator pin the rules docs, because a pin is the write permission *and* renders the
whole document on every coordinator turn.

## The design

### 1. Trigger and run state

- `src/onboarding/subscribers.ts` `onMailboxConnected`: replace the `#2362` stub with a call to
  the deep-dive service's `startOnce()`, then the existing note-and-wake.
- `OnboardingService.start` (after the task tree exists): if `mailboxDirectory.list()` is
  non-empty, call `startOnce()`. Covers a mailbox connected in Setup before onboarding.
- **Once per install:** run state in the config store under the code-owned `onboarding`
  namespace, key `onboarding/deep_dive` (separate from `onboarding/state`, which a restarted
  onboarding replaces). `startOnce()` claims it under an advisory lock; any existing state means
  no start. Fields: `status` (`scanning | drafting | delivered | failed`), `startedAt`,
  `mailboxIds` (those connected at start), `summaryPath`, `draftPaths`, `spendUsd`, `error`.
- **Re-run, any time:** only by an explicit action, and available after onboarding has completed
  — and on existing installs that never ran it — to improve personalisation. Two entry points: the
  principal asks Curia (a small coordinator-reachable tool, `deep-dive-run`, discoverable rather
  than pinned so it adds no per-turn tool definitions), and an operator button in the console.
  Both clear the run state and call `startOnce()`.
- **Where the drafts go:** to the onboarding task if one is open at hand-off time; otherwise the
  job creates a standalone coordinator task (tagged `deep-dive`) with the same Review topics and
  the onboarding skill active, so the review and import work the same way.
- **Onboarding waits for the deep dive.** While the run is `scanning` or `drafting`, or its drafts
  are delivered to the onboarding task but its review topics are still open, `completeIfDone`
  does not complete onboarding. A `failed` run releases the hold (its topics can be declined).
- **No mailbox ever:** no job. Nothing new; #2360 §13 already lets the Review topics be declined.
- **Restart safety:** the job is in-process. A run whose status is `scanning`/`drafting` is
  resumed at boot (Start can schedule a process restart, which kills a job it just started) and by
  the onboarding watcher when older than a stall threshold, from the last completed stage (a
  stored summary is not recomputed). The resume check must not depend on an open onboarding task
  (`watcher.ts:80` returns early without one), so it runs before that early return.
- **Failure:** status `failed`, `notifyOperator('deep_dive_failed', …)` (new `OPERATOR_EVENTS`
  entry), and a note on the onboarding task so the Review topics can be declined.

### 2. The history summary (code, deterministic)

- `src/onboarding/deep-dive/history-summary.ts`: reads the run's mailboxes over a configurable
  window (default 90 days, `config/default.yaml`) with `CeoNylasClient.listAllMessages` (inbox and
  sent, raised `maxScan`) and `NylasCalendarClient.listEvents` in windows under its 1,000-event cap.
- Computes, each item with message or event ids as evidence:
  - correspondents: volume each way, two-way or one-way, principal's reply latency;
    `classifyEmailSender` separates people from organisations and automated senders;
  - unopened mail and handed-off threads;
  - recurring meetings, meeting lengths and buffers, kept-clear blocks, declined or moved events;
  - where time went: calendar hours and mail volume by person, organisation (domain) and series;
  - a sample of sent mail bodies for voice (bounded count).
- The heuristics are documented in the module header and its README section, reviewed with it.
- Stored as a durable working doc, `/meetings/onboarding/deep-dive/history-summary.md`
  (JSON in the body, `taskId: null`). Nothing pins it.
- Tests: the summary from fixture mail and calendar is stable; the drafting and backfill
  steps are handed the summary and no mailbox client.

### 2a. Staying inside Nylas limits

Most operators start on Nylas's free Sandbox: five connected accounts as a hard cap, and no
published per-request quota found (2026-11-23). The binding constraints are rate limits — Nylas
per grant (Messages ~200 req/s) and, beneath it, the provider (Gmail ~600 req/min per user) — and
the scan shares the grant with live triage. So the crawl is deliberately slow and bounded:

- **Metadata only.** List calls (summaries, snippets, participants, folders) at
  `NYLAS_MAX_LIST_LIMIT` (20) per page; full bodies only for the bounded sent-mail voice sample.
  Calendar via `listEvents` at its 200-event pages.
- **Paced.** A fixed request rate (config, default 1 request/second) leaves the grant's headroom to
  triage. 429s use the client's existing backoff and `Retry-After`; repeated 429s slow the pace
  further rather than fail the run.
- **Capped.** A per-run request cap and message cap (config; defaults sized for a busy 90 days,
  roughly 15,000 messages ≈ 800 list pages ≈ 15 minutes at the default pace). Hitting a cap ends
  the scan early and the summary records the coverage it actually got (date range, counts,
  `truncated: true`); the drafts say so. Not a failure.
- **Logged.** Request count, 429 count and duration go in run state and the log, so the first
  real run's numbers can be recorded on the issue.
- Re-runs scan the same way; they are explicit and rare, so no incremental crawl.

### 3. Contacts backfill (code)

From the summary: two-way correspondents above a threshold (config) and recurring-meeting
attendees. Name, email and organisation from the domain only. One-way, automated and bulk
senders get none. Runs before the drafts; the count goes into the progress note so the receipt
can report it.

*Builder's-call decisions (from review):* `ensureChannelContact` takes no `primaryEmail` or
organisation, so organisation routing never runs through it. The backfill follows the email
adapter's real path instead — resolve by channel identity, else `createContactWithKgOutcome`
with `primaryEmail` plus `linkIdentity` (source `email_participant` / `calendar_attendee`) — so
the existing async dedup and organisation routing run. The adapter's per-hour creation caps
don't apply; the backfill has its own cap (config, default 150, highest-volume first), which
also bounds the per-create dedup scan (it reads every contact, O(N²) over a large backfill).

### 4. Drafting (code, strongest tier)

- **Model calls:** the drafting is system code, not a skill, so it calls the model router
  directly at the `powerful` tier rather than widening `InfraLlm` (whose result carries no cost,
  forces reasoning off with a 4,000-token cap, and is part of the public `ToolContext`). It uses
  the tier's default reasoning, an output cap sized for a full draft, publishes `llm.call` like
  `InfraLlm` does, and sums cost from each response's usage via `pricing.ts`. One call per draft, each given the summary plus what the first conversation
  already established (behavioral preferences, working hours, confirmed research-brief items,
  named people) and the current rules documents and voice profile, so conflicts and
  contradictions are **flagged in the draft**, never resolved by replacement. Unconfirmed
  research-brief items are excluded.
- Three Curia documents under `/meetings/onboarding/deep-dive/`:
  - `working-rules.md` — two `##` groups, inbox and calendar, each rule in its agent's format;
  - `time-and-priorities.md` — where the 90 days went, then "what are you actually trying to
    move?"; no inferred goals;
  - `writing-voice.md` — the `WritingVoice` fields plus a `guide`, and 2–3 sample replies.
  Each opens with: nothing here is in effect yet.
- Spend is stored in run state and logged.
- **No wait for the first conversation.** Drafting starts as soon as the summary is stored and
  uses whatever the principal has already said at that moment; with nothing said yet, there is
  simply nothing to flag. A later re-run picks up more.
- **Inputs read deterministically:** behavioral preferences and working hours from the executive
  profile; the research brief (`/meetings/onboarding/research-brief.md`) as text, with the prompt
  told to use only items marked confirmed; existing rules docs and the voice profile. "People the
  principal named" has no structured record and is not a separate input; contacts already exist.

### 5. Hand-off to the Review session (code)

After the drafts: `OnboardingService.openSession(parent, 'review')` (idempotent) on the onboarding
task open *at hand-off time* (run state stores no task id, so a restarted onboarding is handled),
then a progress note **on the parent onboarding task** — there is no Review session subtask, only
one subtask per topic — listing the three Curia draft paths and the backfill count, and wake the
parent with `noteAndWakeCoordinator`. Status `delivered`.

Each document's outcome is its own topic's `topic_done`: confirmed or corrected → `done`, set
aside → `declined`, with the outcome word and any corrections summary in the note.

### 6. Google Docs, review and import (coordinator guidance, no new code)

Written into `skills/onboarding/SKILL.md` (lazy, loaded with the onboarding skill) and the
playbook's Review section:

- **On the drafts-ready wake:** activate `google-workspace`; for each draft create a Google Doc
  from its text, share it with the principal as `writer` (the existing principal-access guard
  already enforces `writer`), and add the links to the Review note. Then book the review in the
  chosen format (#2360's calendar-tied sessions) and tell the principal on their messaging route.
  No email.
- **If Workspace fails** (create or share refused): point the principal at the Curia drafts in
  the console's Documents page, and raise `onboarding-progress` op `operator_notice` with the new
  event `deep_dive_delivery_failed`. The review runs from the Curia drafts.
- **On confirm or correct of a document:** read the Google Doc's current text (or the Curia
  draft on the fallback route) and import:
  - **Working rules** → delegate the inbox rules to ceo-inbox and the calendar rules to
    calendar, as "add these confirmed rules". Each agent writes its own pinned document in its
    own format and merges against what is there.
  - **Priorities** → the coordinator writes `/shared/principal/priorities.md` (it pins it, §7).
  - **Writing voice** → `executive-profile-update`, which gains two optional inputs: `guide`
    (today it always keeps the current guide, so the draft's guide would be dropped) and `note`
    (today the note is generated and `changedBy` is fixed to `'tool'`). There is no `seeded`
    provenance in Curia; the version row's note naming the deep dive is the record, and the
    issue's criterion is reworded to match. `voice-learn` refines the `guide` afterwards as today.
    To check in the plan: the tool is `action_risk: medium` (needs 70); confirm a post-call
    follow-up wake isn't blocked at the onboarding band.
  Then add "this has moved to Curia" with the console link at the top of the Google Doc, and
  send a receipt with console links and the contacts count, not waiting for a reply.
- **Outcome per document** goes on the Review subtask note as confirmed, corrected or set
  aside. Set aside writes nothing. The session is done once the review happened.
- **Playbook:** `config/onboarding/playbook.md` Review section replaces `walk-drafts` with three
  topics — working rules, priorities ("here's where your time went; what are you trying to
  move?"), writing voice — each offering confirm / correct / set aside, plus *Next step*.
  Already-seeded playbooks keep the old section (#2360 §2); the changelog fragment says so.

### 7. Priorities: two documents

- **`/shared/principal/priorities.md` — current only, pinned by the coordinator.** Frontmatter
  describes the format: current priorities with an "as of" date; superseded ones move to the
  past document. Kept small so the pin's per-turn cost stays roughly fixed.
- **Past priorities — a separate, unpinned document outside `/shared/`.** Read when history
  comes up (Weekly session, "what was I focused on in the spring?"); the natural home for
  longitudinal goal tracking later. Outside `/shared/` the pin-to-write guard doesn't apply, so
  the coordinator writes it with plain `doc-write` and no schema change. Default location
  `/meetings/principal/priorities-past.md` (durable prefix). The location is not hardcoded into
  behaviour: the current document's frontmatter carries a `past:` pointer to it, and that pointer
  is what the coordinator follows. (A write-only pin was rejected: a config option that grants
  writes without context invites misconfiguration.)
- Coordinator `pinned_context` entry for the current document, description ≤300 characters,
  carrying the behaviour (use, upkeep, offer-to-start, where past ones go). Starting wording:
  > The principal's current goals and priorities, the record of them. Weigh work and
  > suggestions against them. When a goal is stated or changes, propose updating this; move
  > superseded ones to the document its `past:` field names. If missing, offer to start it when goals come up.
- Not `editable_by: console`; the principal edits it in the console, the coordinator writes it
  when the principal agrees. `extract-facts` and `memory-store` are unchanged.
- The daily recap (a model-made scheduler job) frames the day against the priorities when the
  document is present; that comes from the pin, not new recap code.
- Prompt budget: the pin is rendered context, not `system_prompt` text; confirm with
  `tests/unit/agents/prompt-budget.test.ts` that it isn't counted, or raise the budget once.

### 8. ADR-069 and specs

- ADR-069: priorities live in two documents — the current one in `/shared/principal/`, pinned,
  the record; past ones in an unpinned document found by the current one's `past:` pointer; spec 20's "the workspace is the scratchpad, the KG is the record"
  revised for durable, principal-owned `/shared/` documents; sensitivity of the summary and
  drafts (private mail, Curia-only, drafts in Google Drive during review); who writes
  priorities and the voice profile; rules written by their owning agents through delegation.
- Spec 18 Layer 4 gets a deep-dive section and the new Review session. Spec 20 line 22 revised.

## PR stack (each well under 100 changed files)

1. **Trigger, run state, history summary.** Subscriber and Start hooks, `onboarding/deep_dive`
   state, watcher resume, summary module and its tests, `deep_dive_failed` notice. No drafts yet;
   a completed scan just stores the summary.
2. **Backfill and drafting.** Contacts backfill, `powerful` tier in `InfraLlm`, the three
   drafts, spend logging, Review hand-off (open session, note, wake).
3. **Review, import and re-run.** SKILL.md guidance, playbook Review topics, the onboarding
   completion hold, the standalone review task, `deep-dive-run` tool and console button,
   `executive-profile-update` `guide`/`note` inputs, `deep_dive_delivery_failed` event, scenario cases for the import and set-aside paths.
4. **Priorities.** Coordinator pin and the two-document format, ADR-069, spec 18 and 20
   revisions, scenario cases (offer to start, suggestion names a priority, new goal → proposed
   edit).

PR 4 does not depend on 1–3 and can go first.


## Left to the builder

Thresholds and window defaults; the summary's JSON shape; the stall threshold; draft prompts;
exact progress-note wording; how scenario cases stub the Google tools.
