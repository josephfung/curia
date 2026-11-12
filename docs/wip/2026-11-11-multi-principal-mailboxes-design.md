# Multiple principal mailboxes and calendars — design

Status: draft · 2026-11-11 · implements #2475 (widened: see "Decided by the principal").
Builds on ADR-062 / #2474 (sending from the principal's mailbox).

## Why

The principal has more than one Gmail account: a personal one and a work one (Google
Workspace). Curia manages exactly one today. Forwarding one account into the other is not
a workaround: it is a poor experience and often blocked by workplace policy. An EA with
delegate access to both accounts works across them as one job: reads both, keeps both
triaged, drafts and sends from the right one, books on the right calendar, and sees the
principal's availability across both.

The hard part is not plumbing a second grant. It is that **every action against the
principal's mail or calendar now has an account, and the wrong account is a real mistake**:
personal mail sent from the work address, a work meeting booked on the personal calendar,
a draft saved where the principal won't look, a rule applied to the wrong inbox, two
triage passes replying to each other. Choosing the account is also a judgement an EA makes
from context ("email my CFO" → work; "email my sister" → personal; the same accountant
gets corporate-audit mail from work and personal-tax mail from personal), and correcting a
wrong choice must be cheap.

## Decided by the principal (2026-11-11)

1. **Both mailboxes are triaged on an ongoing basis.** Cadence is tunable per mailbox
   (e.g. work hourly, personal daily); neither is "read only on request".
2. **Calendar is in scope.** Each mailbox's calendar is connected. Availability checks see
   both. Events, holds and RSVPs land on the calendar of the account the meeting belongs to.
3. **Choosing the account is a nuanced inference, not a rule.** Recipient, topic, history
   and the principal's standing preferences all count. Curia infers, asks when the evidence
   is genuinely split, mentions the account only when the choice was a real judgement call
   (item 10), and a correction is cheap. Examples the principal gave: CFO → work;
   sister → personal; "the [work org] finance team" → work calendar; the same accountant →
   work for the corporate audit, personal for personal taxes; a personal contact writing
   about a work matter may stay personal (asking for an inside tip on a job posting) or be
   moved to the work side (reporting a website error to pass to marketing).
4. **One shared memory.** Work and personal facts do not need to be kept apart; the
   principal's own memory is blended and cross-over is natural. Confidentiality is about
   the recipient and the nature of the data, not the source mailbox. Give the models enough
   context and expect nuanced drafting rather than building cross-over blocks. Record which
   mailbox a fact came from only where it is nearly free; do not build provenance machinery
   for a hypothetical need.
5. **Stronger models or more reasoning effort are acceptable** where they buy better
   judgement on this work.
6. The failure-mode guards proposed in chat (the table under D11) are accepted.
7. **Sending drafts across accounts:** look at drafts in every account and ask only when
   more than one is still a candidate after the conversation; a draft the conversation or
   the instruction already identified is sent without asking (D6).
8. From the issue: Gmail only; config must not preclude another provider later. Forwarding
   between accounts is not a workaround.

Added after review (2026-11-12):

9. **The autonomous-send cap stays 10 a day in total.** Hitting it is reported as its own
   thing, never looking like a reply Curia judged unsafe (D6).
10. **Say which account only when there was a real chance of being wrong.** When the
    principal named it, a standing preference covers it ("meetings always go on my work
    calendar"), or the evidence all points one way, Curia acts without mentioning the
    account. It mentions it when it made a judgement call the principal might not expect,
    and asks when the evidence is split (D5).
11. **Not every event is a conflict.** A personal calendar may carry the cleaner's or the
    lawn service's visits, which don't block the principal. Which events count is the
    principal's calendaring preference, applied with the events in view. Code never drops a
    calendar silently (D7).
12. **The triage heartbeat is code and runs around the clock, every 15 minutes.** It wakes the
    agent only when a mailbox is due and has mail; the per-mailbox cadence decides how much
    triage work happens (D4).
13. **Cheap provenance extends to fact and relationship extraction** (D8).

## Goals

- Two or more named principal mailboxes, each with its own Nylas grant and its own calendar.
  An existing single-mailbox install upgrades with no operator action.
- Every ceo-inbox and calendar action runs against the right account, chosen by code
  whenever the object (message, draft, event, calendar) already belongs to one.
- Where no object fixes the account (a new email, a new meeting), Curia infers it from
  evidence and standing preferences, mentions it only when the call was uncertain, asks
  when split, and accepts a correction cheaply.
- Both inboxes triaged on their own cadence within one bounded triage loop, with no backlog
  flood and no double-processing of the same message.
- Availability across all connected calendars, with no calendar silently left out and
  conflicts judged by the principal's calendaring preferences.
- A mailbox can be removed (leaving a job) and a new one made default without stale state,
  rules or identities carrying over.
- Per-mailbox state wherever state exists (watermarks, send level, start lines, ledger).

## Non-goals

- Non-Gmail providers (Microsoft 365 / Outlook). Gmail label and folder assumptions stay;
  the registry carries a `provider` so a later provider is a new value, not a reshape.
- Separating work and personal memory, or blocking information cross-over in drafts.
- A separate writing-voice profile per mailbox (see D8: one profile, mailbox-aware notes).
- Gmail "send as" aliases beyond the mailbox's primary address. An alias the principal uses
  can be added as a verified principal identity by hand; it is not a separate mailbox.
- Nylas hosted sign-in for the principal (#2361). Mailboxes are added by grant ID as today.
- Multiple calendars per account beyond the account's primary ("home") calendar being the
  write target. Other calendars visible in a grant can still be registered as today.

## Anti-goals (a failure even if it works)

- Any write (draft, label, archive, send, event, hold, RSVP) landing in an account other
  than the one the object belongs to or the one Curia stated.
- A new email or meeting placed in an account by a guess Curia neither asked about nor
  mentioned. (A clear choice needs no mention; an uncertain one does.)
- Noise: Curia announcing the account on choices the principal made or settled long ago.
- An autonomous send that crosses accounts, goes to one of the principal's own addresses,
  or replies to mail from one of them.
- The same inbound message triaged twice (two drafts, two Signal pings, two replies).
- An availability answer that silently skipped a calendar (failed, unread or forgotten).
  Ignoring an event is fine when a calendaring preference says so; ignoring a calendar by
  accident is not.
- A replies-held-by-the-limit notice that reads like Curia judged the replies unsafe.
- After a mailbox is removed: the old address still treated as the principal, notices
  still sent to it, or its rules and state attaching to a new mailbox.
- Connecting a busy work inbox quietly burning budget all day on an old backlog.
- A single-mailbox install behaving differently after upgrade.

## Constraints

- Prompt budgets (`tests/unit/agents/prompt-budget.test.ts`) cover coordinator, calendar,
  ceo-inbox, contacts and meeting-debrief. New behaviour goes to code first, then tool
  descriptions, then lazy playbooks; the always-on prompts grow only where unavoidable
  (ADR-046).
- Nylas message, draft, thread, attachment and folder IDs are grant-scoped. Calendar IDs
  are not reliably so: a Google calendar ID is the calendar's address, and a calendar shared
  from one account to the other is reachable through both grants; the literal `primary`
  exists in every grant. Calendar routing therefore cannot rely on a 404 (D7).
- One agent has one model tier (`model.tier` in its YAML); there is no per-mode tier today.
- ADR-062's rules hold: one gateway entry for principal-mailbox sends; holds stay drafts;
  the send level is read by the gateway, never chosen by the caller.
- Behaviour suites cost money: new scenario cases are written freely, run only with the
  maintainer's agreement and a cost estimate.

## Design

### D1. Mailbox registry, secrets and migration

- New table `principal_mailboxes` (migration `123_*`, re-check prefix uniqueness after every
  rebase): `id` (slug `[a-z][a-z0-9-]{0,31}`, primary key, **immutable**), `label`
  (display name, editable), `address` (lowercased), `provider` (`google`), `is_default`
  (exactly one true among live rows, partial unique index), `triage_start_at` (nullable
  timestamptz, D4), `removed_at` (nullable; see Remove), `created_at`, `updated_at`.
  `address` is unique among live rows. **An id is never reused**, even after removal.
- The grant ID stays a vault secret, one per mailbox:
  `principal.mailbox.<id>.nylas_grant_id`, following `channel.email.<name>.nylas_grant_id`
  (`src/channels/email/email-account-secrets.ts`). The shared API key stays
  `channel.email.nylas_api_key`.
- **The address comes from Nylas, not from the operator.** Adding or testing a mailbox calls
  Nylas `GET /v3/grants/{id}` and stores the grant's own `email` and `provider`. A
  non-Google grant, a grant already used by another mailbox, a grant whose address belongs
  to another mailbox, or a grant whose address is one of Curia's own `email_accounts` is
  refused. This is the guard against "work" being wired to the personal grant.
- **Upgrade migration (app code at boot, idempotent; SQL alone can't decrypt).** If the
  table is empty and the flat `ceo_nylas_grant_id` exists: insert one mailbox (default,
  `triage_start_at` null so today's behaviour is unchanged), address from the grant lookup,
  else from `ceo_self_email`. Its id comes from the address domain (`gmail` for
  gmail.com/googlemail.com, otherwise the domain's first label), its label is that word
  capitalised; both are only names (relabel in the console). It is deliberately not
  `primary` (Nylas's calendar alias, D7) nor `default` (being default can move). Copy the
  grant into `principal.mailbox.<id>.nylas_grant_id`, rename the stored `ceo_inbox/sending`
  key `default` → `<id>`, and rename every existing per-mailbox state key (sent-observe and
  learning state, D8) to that mailbox's keys, all in one step. The flat keys are
  then retired the way #2522 retired the legacy Nylas keys.
  **If neither address source is available** (Nylas unreachable at boot and no
  `ceo_self_email`), the migration does not run: the boot logs a warning, the resolver
  serves the flat grant as an in-memory mailbox `mailbox` with no address-dependent
  features (reply-all exclusion falls back to verified principal identities), and the
  migration retries on the next boot and on each health-check tick until it succeeds.
- **The migration never touches principal identities.** If the migrated address is not a
  verified principal identity it logs a warning and the console shows it, so a
  single-mailbox install's dispatch is unchanged.
- **Adding a mailbox** (an operator action in the console) writes its address as a
  **verified principal email identity** (`contact_channel_identities`) if it is not one
  already, so Principal Contact Details, reply-all exclusion, the gateway's principal checks
  and inbound recognition on Curia's own email channel all see it. The identity row records
  that it came from this mailbox, so removal can find it (below).
- **Adding a mailbox never changes the principal's primary email.** `contacts.primary_email`
  stays as it is, and the gateway's `emailPrincipal` (`outbound-gateway.ts:3060`, today the
  first verified identity) is changed to use the primary, as the `principal` recipient alias
  already does (`recipient-reference.ts:343`). Otherwise adding a work mailbox could quietly
  move Curia's system notices to the work address.
- **Set default.** Being default means only: the mailbox used when exactly one exists, and
  the one listed first. It never changes the principal's primary email by itself (see
  above); the console offers that as a separate, explicit choice.
- **Remove (e.g. the principal left the job).** A console action, one confirmation screen
  that spells out each consequence below. Removing the default mailbox while others exist
  asks for the new default in the same screen rather than refusing.
  - **Is the address still yours?** The screen asks, defaulting to **no** for a mailbox
    whose domain isn't a consumer domain. *No* (left the job): the principal identity
    added for it is removed, so mail from that address (now the old employer's or a
    successor's) is no longer treated as the principal, reply-all stops excluding it, and
    the gateway stops treating it as the sender's own. *Yes* (only disconnecting Curia):
    the identity stays.
  - **If it was the principal's primary email**, the screen requires a new one (offered:
    the new default mailbox's address) before removing, so Curia's notices never keep going
    to an address the principal no longer reads.
  - **Tombstone, not delete.** The grant secret is deleted and the row gets `removed_at`;
    the id is never reused. Everything keyed by the id (send level, cadence, sent-observe
    and learning state, ledger entries, dedupe records, `Mailbox:` rule lines, per-contact
    account preferences) therefore can never attach to a later mailbox, even one labelled
    "Work" again. Per-mailbox config keys are deleted; ledger and dedupe records age out.
  - **Rules scoped only to it** are listed on the screen with a choice: delete them, or
    rescope them to another mailbox. A rule scoped to several keeps the others.
  - **Calendars** registered through it are marked disconnected and left out of
    availability as *removed*, not reported as *partial* (a removed calendar is not a
    failing one). Holds on it can't be released and need not be: the account is gone.
  - **In flight:** an open drain batch drops the mailbox at its next list; consults,
    follow-up tasks or scheduled jobs that name it fail closed with "that mailbox was
    removed", reported once each, never retried against another mailbox.
  - **Memory is not touched** (one shared memory, decision 4). Stale work facts age like
    any other; the principal can ask Curia to forget them.
  - A per-contact account preference naming a removed mailbox reads back as "used to be
    <label> (removed)", so the agent treats it as history, not a rule.
- **Connecting a new account and making it default** is add + set default: a new id, a new
  start line (no backlog flood), send level `on_request`, an empty rule scope, and the
  console offers to make its address the primary email.
- **A grant revoked before removal** (IT disables the account on the last day): the health
  canary alerts once and the alert suggests removing the mailbox; until then the mailbox
  is reported failing, as in D2.
- **Staging gate:** a code constant caps the registry at one mailbox until the final PR of
  the stack (Delivery) lifts it, so no intermediate release can run a second mailbox
  through half-converted code.

### D2. One resolver for every principal-mailbox and calendar client

- Replace `ctx.secret('ceo_nylas_grant_id')` in all ceo-inbox handlers, the
  `createPrincipalMailboxResolver` single slot, `resolvePrincipalCalendarGrant`, the
  boot-time single `NylasCalendarClient` and `NylasPrincipalMailbox` with one service,
  `PrincipalMailboxes`, injected as a tool capability (as `outboundGateway` is), never as
  per-mailbox secret names in `tool.json`.
- It lists mailboxes, returns the default, and returns per-mailbox clients (the ceo-inbox
  `CeoNylasClient`, the gateway `NylasClient`, the `NylasCalendarClient`), resolved per call
  so a grant change takes effect without a restart. An unknown mailbox id is an error,
  **never a fallback to the default** (same rule as `getNylasClient(accountId)` in the
  gateway).
- `locate(kind, id, hint?)`: for a tool given an existing object ID but no mailbox, probe
  every mailbox in parallel (one GET each). Exactly one hit → that mailbox. More than one
  → refuse as ambiguous and ask for `mailbox`. None → not found. Any mailbox erroring makes
  a miss non-definitive, reported as such (the `findDraftById` pattern in
  `skills/email/tools/send-draft/handler.ts`). With one mailbox configured, `locate` is the
  mailbox itself and adds no calls.
- When a tool **is** given `mailbox` with an existing object ID, a 404 stays a 404: no
  retry against other mailboxes. A wrong explicit mailbox fails, it never "finds" the
  object elsewhere.

### D3. ceo-inbox tools

- Every tool takes an optional `mailbox` (the id). Every result that carries a message,
  draft or thread carries `mailbox` (id) and `mailbox_label`.
- **Schema order.** There is no one-optional-input limit on OpenRouter. The real hazard
  (#2325, curia-deploy#275, #2209) is that some providers decode tool arguments in the
  schema's declared order: once the model writes a later key, an earlier optional key can
  no longer be written and is silently dropped. Those providers (Morph, Wafer,
  InferenceNet) are excluded at the OpenRouter account level today, but the exposure
  returns if one joins the pool. So `mailbox` (and `move_to_mailbox`, calendar `mailbox`)
  is declared **after** every required input and the payload, and every tool this work
  touches is reordered to required-then-payload-then-optional, with a unit test over
  those manifests. The design also fails safe if it is dropped anyway: an existing object
  is located, a compose or calendar write returns `needs_mailbox`, and a list reads every
  mailbox. Nothing falls back to the default mailbox.
- `list` / `search` without `mailbox` query every mailbox in parallel and merge by date.
  Each mailbox's cursor is kept separately inside one composite page token. A failing
  mailbox does not hide the others; the result lists `mailbox_errors`.
- `read`, `download-attachment`, `archive`, `mark-read`, `mark-starred`, `label`,
  `update-folders`, `draft-edit`, `send-draft`: act in the mailbox holding the object
  (D2 `locate`, or the explicit `mailbox`).
- `label` / `update-folders`: **verify the message exists in the mailbox before resolving
  or creating any label** (today a label is created before the message is fetched, so a
  wrong-mailbox call leaves a stray label). Labels are created per account by name on first
  use, as today.
- `draft-reply`: always drafts in the mailbox the message is in. Reply-all excludes
  **every** principal address (all mailbox addresses plus verified principal email
  identities), not only `ceo_self_email`. `ceo_self_email` is retired.
- `draft-compose`: see D5. Requires a mailbox once more than one exists.
- `draft-edit` gains `move_to_mailbox` (D5).
- `sent-observe`: per mailbox (D8).
- Audit `tool.result` payloads for draft-reply / draft-compose / draft-edit carry
  `mailbox`. `DraftProvenance` matches on (mailbox, draftId).

### D4. Triage: cadence, fairness, start line, budget, duplicates

**Cadence.** New config-store key `ceo_inbox/triage`, string-encoded JSON
`{ "<mailbox>": "<cadence>" }`. A cadence is a frequency (`every 15m`, `every 30m`,
`hourly`, `every <N>h`, or `daily <HH:MM>`) with an optional window (`07:00-19:00`,
`weekdays`), in the principal's timezone. Default `hourly 06:00-23:00`, which is today's
behaviour. Pinned into ceo-inbox's context and changed in conversation like
`ceo_inbox/sending`. Missing or unknown → the default.

**A code heartbeat, then one loop.** The ceo-inbox YAML's `0 6-23 * * *` cron is replaced
by a system-layer **inbox heartbeat** that runs every 15 minutes, around the clock, with
no LLM (the `src/scheduler/backlog-heartbeat.ts` pattern). Each tick:

- works out which mailboxes are due (cadence and window elapsed since that mailbox's last
  completed drain, or a drain of it still has more), and whether the daily ceiling
  (below) is spent;
- for each due mailbox, asks Nylas for one unread message past the start line (one cheap
  call each);
- only if some due mailbox has mail, and no `inbox-drain` task is already running, wakes
  the agent with the triage task. Otherwise it records the tick and stops.

A quiet tick costs a few Nylas calls and no model tokens, so the finer, round-the-clock
heartbeat costs nothing when there is nothing to do; how much LLM work happens is set by
each mailbox's cadence. Overnight triage happens only if the principal sets a window that
includes it. Urgent pings it finds still follow the existing urgent-message rules. The
single `inbox-drain` task stays the single owner of a drain. On a triage call,
`ceo-inbox-list` (new input `triage: true`, used by the heartbeat's task text) decides in
**code**, with the same due computation the heartbeat used:

- Which mailboxes are due: cadence elapsed since that mailbox's last completed drain, or a
  drain of it is in progress (it returned `has_more` last batch). Per-mailbox
  `triage.last_drained_at` lives in config-store namespace `ceo_inbox`.
- The batch (still 5): round-robin across due mailboxes with unread mail, so a busy work
  inbox cannot starve personal. `has_more` is true if any due mailbox has more.
- **Start line:** only messages received after the mailbox's `triage_start_at` (set to the
  connect time when a mailbox is added; null for the migrated mailbox). Older unread mail is
  never auto-triaged. A principal-directed "sweep the last N days of work" moves the start
  line back.
- **Backlog alarm:** if a due mailbox's untriaged count past its start line exceeds 100,
  the list result says so once per backlog episode; the agent tells the principal (one
  digest line or Signal note, per the existing urgent/digest paths) and keeps draining at
  the normal pace.
- **Daily ceiling:** triage batches per day across all mailboxes are capped (config, default
  120 ≈ 600 messages). At the cap the list returns an empty batch with
  `budget_exhausted: true`; the agent tells the principal once and does not self-continue.
  Counted in code, so a model cannot drain past it.
- Per-run budget stays `max_turns: 30`, `max_cost_usd: 0.50`. The scheduled task text no
  longer says "the principal's inbox" but "the principal's mailboxes that are due".

**Same message in two mailboxes.** A message addressed to both principal addresses (or
Cc'ing the other one) arrives in both inboxes with different Nylas and thread IDs. In
triage mode, when a message's To/Cc/From names another configured mailbox's address, the
list fetches its headers (only these messages pay for it) and dedupes by RFC `Message-ID`,
**statefully, first seen wins**:

- The first triage pass to reach any copy triages the message and records its
  `Message-ID` (with the mailbox and message ID it was triaged as) in a small store with a
  30-day TTL. This keeps the faster cadence: a message that reached the hourly work inbox is
  not held for a daily personal pass, and a failing grant or a start line on one mailbox
  cannot leave the message untriaged.
- Actions that belong to an account follow the address the sender wrote to, not the
  mailbox triage happened to see first: a reply is drafted (and, if allowed, sent) on the
  copy in the mailbox named first in `To` (then `Cc`), located by `Message-ID`. If that
  copy can't be reached (grant failing, not yet synced), the reply goes in the mailbox
  being triaged and the summary says so.
- A later pass that meets the other copy finds the record, marks it read and labels it
  `↔ In <label>`, and takes no other action.

**Mail from the principal's other address** (forward-to-self, personal → work): never
drafted, never sent to, never escalated as Urgent. Classified 📌 Seen (stays in the inbox,
marked read) unless an active rule says otherwise. Mail from the principal's own address in
the same mailbox is unchanged.

**Calendar consults** carry `mailbox=<id>` (the mailbox the email is in). With D7 every
mailbox has a calendar, so both scheduling replies and invites consult as today; the
calendar side uses that mailbox's calendar for holds and RSVPs.

**Rules.** A rule section in `/shared/inbox/rules.md` may carry `- Mailbox: <id>[, <id>]`.
No line means every mailbox (today's behaviour, so existing rules are unchanged). When
creating a rule and more than one mailbox exists, ceo-inbox confirms the scope with the
principal. Per-sender standing instructions from entity-context stay mailbox-agnostic.

**Labels and notices.** Triage labels are per account and created on first use. Signal
urgent messages and digest lines name the mailbox when more than one exists
("🚨 Work — Jane — Q3 audit: …", "Sent for you from your work mailbox: …").

**A message that belongs to the other side** (a personal contact reporting a website
error): the reply stays in the arrival mailbox. Triage may propose the switch in its
summary (a short reply plus a new message from the other account). It never makes the
switch on its own: such a message is not `routine` for autonomous sending (send-draft tool
description) and any new message from the other account is a principal-directed compose.

### D5. Choosing the account for new mail and meetings; correcting it

**Evidence, computed by code.** A shared `mailboxEvidence(recipients)` returns, per mailbox,
for the given recipients: messages sent to them from that mailbox (count, last date, the
last three subjects), messages received from them, and whether their address domain equals
that mailbox's domain. Computed live from each mailbox's Sent and All Mail via Nylas search
(the acquaintance check already does a Sent search). No new stored tally.

**draft-compose.** With more than one mailbox, `mailbox` is required. Called without it,
the tool creates nothing and returns `needs_mailbox` with the evidence. The agent then
decides from the principal's words, the topic and the evidence, and calls again with
`mailbox`. Guidance in the tool description, not the prompt:

- The principal said which, or a standing preference (`behavioralPreferences`, e.g.
  "meetings always go on my work calendar"), a rule or a remembered per-contact preference
  covers it → use it, **without mentioning the account**.
- Evidence and topic all point the same way (the CFO, only ever written to from work, on
  the work domain) → use it, without mentioning the account.
- Evidence leans one way but a reasonable person could expect the other (a personal
  contact on a work topic, a first email to someone with no history) → use the likelier
  account and **say which**, in a few words: "Drafted from your work account."
- Split evidence that the topic doesn't settle (the shared accountant, a new contact with
  no history and no domain match) → ask the principal, through the coordinator, naming the
  options.
- To help the agent tell these apart, the tool's result says whether the evidence agreed
  with the chosen mailbox (`evidence: "agrees" | "leans_other" | "none" | "split"`). The
  agent still weighs the principal's words and preferences, which code can't see.

**Evidence is a service, not an agent skill.** `mailboxEvidence` lives on
`PrincipalMailboxes` (D2), so calendar tools compute it in code; the calendar agent and
meeting-debrief need no mail access.

**Calendar writes get the same code gate as compose.** With more than one mailbox,
`calendar-create-event` and `calendar-create-hold` on any of the principal's calendars
require `mailbox`; called without it they create nothing and return `needs_mailbox` with the
evidence for the attendees. This matters doubly on Google: the organizer calendar's account
is who the invitation comes from. Passing a principal `calendarId` does not stand in for
`mailbox`; the two must agree or the call is refused. Sources of the mailbox:

- A consult from ceo-inbox carries the email's mailbox.
- meeting-debrief's follow-ups use the mailbox of the calendar the debriefed meeting is on.
- A delegated request is decided like compose, with the same rule on when to mention the
  calendar.
- An event with no attendees (a focus block, a dentist appointment) has no evidence; the
  agent judges from the topic and standing preferences, mentions the calendar only when it
  was a guess, and asks when unsure.

The code gate (a stated `mailbox`) is unchanged by when Curia mentions it: the agent must
always choose; it only stays quiet about choices that weren't in doubt.

**Correction.** `draft-edit` with `move_to_mailbox`: recreate the draft (recipients,
subject, body, attachments) in the target mailbox, then delete the original only after the
create succeeds. **A move keeps the draft's authorship class** for send review: its audit
result records `moved_from` (mailbox, draft ID), and `DraftProvenance` gives the new draft
the source draft's class (Curia-written stays Curia-written, so a move is never a way to
lighter review). An unknown source class is treated as Curia's. A moved reply becomes a new message in the target account (the thread
lives in the source account); set `In-Reply-To` / `References` if Nylas drafts accept them
so the recipient's client still threads it, and say that it starts a new thread in that
account. For a calendar event: update-event cannot move accounts; the calendar agent
recreates on the right calendar and deletes the wrong one, telling attendees as Google
does.

**Learning from corrections.** After a correction, the agent stores the preference on the
contact with `memory-store` including the topic ("corporate audit → work; personal taxes
→ personal"); entity-context returns it next time. Prompted by the `move_to_mailbox`
result text, not the always-on prompt.

**Model strength.** Mailbox choice happens on delegated (non-triage) ceo-inbox and calendar
turns. Write scenario cases first (CFO, sister, shared accountant, work-team calendar,
correction) and run them at today's tiers. There is no per-mode tier, so if choices are
poor the options are raising the whole agent's tier (which also raises the hourly triage
cost) or adding per-mode tier support; bring the measured result and both options to the
maintainer then. Not built up front.

### D6. Sending (extends ADR-062)

- The gateway's principal-mailbox resolver becomes `(mailboxId) => client`.
  `sendPrincipalDraft` locates the draft (D2), and binds **the send level to the mailbox
  holding the draft** (closing the `readSendLevel(DEFAULT_MAILBOX)` seam at
  `outbound-gateway.ts:4312`). New mailboxes default to `on_request`.
- The send ledger entries carry `mailbox`. The thread cooldown keys on (mailbox, thread)
  **and** on the conversation's `Message-ID`/`References` chain, so the same conversation
  in two inboxes shares one cooldown. The autonomous daily cap stays **10 in total**
  (decided by the principal, 2026-11-12).
- **Hitting the cap is reported as the cap, not as a judgement.** Today a capped reply
  already gets its own reason text, but under the same "Left as a draft in your mailbox"
  heading as a reply Curia judged unsafe, one digest item per draft. Instead:
  - The first capped reply of a day files one notice: "Reached today's limit of 10
    replies sent on its own at 2:14 pm. Replies Curia would have sent are waiting in
    your Drafts." Digest items can't be edited once filed, so each later capped reply
    files a short item under its own heading ("Waiting only because of the daily limit:
    Jane re Q3 audit (work)"), never "Left as a draft". Names the mailbox when more than
    one exists.
  - Holds for judgement ("Left as a draft …: held because …") stay separate items.
  - The tool result to the agent marks the refusal `kind: "limit"` vs `"judgement"`, and
    ceo-inbox's triage summary lists the two groups apart.
  - The same split applies to the other limits that are not about the reply's content
    (thread cooldown): they read as "waiting because of a limit", never as "held".
- New autonomous-send limits (code, in `checkAutonomousLimits`): no recipient may be a
  principal address of another mailbox; never reply on its own to a message whose `From` is
  a principal address. (A draft addressed only to the principal is already refused.)
- `allowedThreadMembers` uses every principal address.
- **Which draft the principal means (decided by the principal, 2026-11-11).** Finding
  drafts to send ("send my draft", "the three I wrote this morning") looks across every
  mailbox. Curia asks only when more than one draft is still a candidate after the
  conversation is taken into account:
  - One candidate across all accounts → send it, no question.
  - One draft in each of two accounts and nothing in the conversation picks one → ask,
    naming both: "The work one to Jane re Q3 audit, or the personal one to Tim re beers?"
  - The conversation already settled it (Curia just described the work draft and the
    principal said "send it"), or the instruction names the account ("there's a draft in
    my work email, please send it") → send that one without asking.
  - A single send gets no extra confirmation. Afterwards Curia names the account only
    when the principal didn't name or imply it and drafts existed in more than one
    account (the same "mention only when it could surprise" rule as D5). ADR-062's
    read-back for two or more drafts stays, and names each draft's account when they
    span accounts.
  This is tool-description guidance plus scenario cases. The code's part: `ceo-inbox-list`
  / `search` with `folder: "DRAFTS"` and no `mailbox` return drafts from every mailbox,
  labelled; `send-draft` locates the draft by ID (D2) and refuses an ID found in two
  mailboxes.
- ADR-062's "a Curia email account whose address is the principal's" refusal covers every
  mailbox address.
- `ceo-inbox-sent-observe` ledger matching (`isCuriaSend`) matches within the mailbox.

### D7. Calendar

- **Registry:** `contact_calendars` gains `principal_mailbox_id` (FK, not null after
  backfill; every existing row was read through the single grant, so it backfills to the
  migrated mailbox): the grant the calendar is read and written through.
  `nylas_calendar_id` **stays globally unique**: a calendar is registered once, through one
  grant. Registering a calendar ID that is already registered through the other grant is
  refused with a message naming it. "One primary per contact" becomes one per
  (contact, mailbox).
- **The owning grant wins.** A calendar whose ID equals a mailbox's address (that
  account's own calendar) is always registered through, read through and written through
  that mailbox, even when it is also shared into the other account. Registration rewrites
  the row to the owner if needed. Writes and RSVPs therefore always come from the account
  that owns the calendar.
- **Home calendar per mailbox:** adding a mailbox registers that grant's Nylas primary
  calendar (by its real ID, never the alias `primary`) to the principal's contact as
  `is_primary` for that mailbox.
- **Client routing:** every calendar tool resolves the client from the calendar's registry
  row. A calendar ID not in the registry requires `mailbox` once more than one exists. The
  literal `primary` is never stored and never sent unscoped: refused without `mailbox`, and
  with it rewritten to that mailbox's home calendar ID before any call.
- **Prerequisite:** `NylasCalendarClient` returns each event's iCal UID (it doesn't today);
  the RSVP lookup and the dedupe below depend on it.
- **Availability: every calendar is read, the principal's preferences decide what blocks**
  (decided by the principal, 2026-11-12). `find-free-time` and `check-conflicts`, whenever
  any of the principal's calendars is in the request, read **all** the principal's home
  calendars across mailboxes. Code never leaves one out silently: a failing grant makes the
  result `partial` and names it; a removed mailbox's calendar is listed as removed (D1).
  - Whether an event is a real conflict is the principal's call, held as a calendaring
    standing preference (`behavioralPreferences`, e.g. "home-service visits on my personal
    calendar don't block me"), not a code rule. Events marked "Show as: Free" in Google
    already don't block, as today.
  - For the principal's own calendars the tools list events (title, calendar, time,
    busy/free) instead of bare free/busy, so the agent can see what is blocking.
    `check-conflicts` returns each conflict with its title and calendar; the agent decides,
    with the principal's preferences in view, whether "Cleaner 10–12" is a conflict.
  - `find-free-time` gains an optional `treat_as_free` (event IDs): after reading the
    blocking events, the agent reruns it with the ones the principal's preferences say
    don't count. The result still lists what was treated as free, so the reply can say
    "free (the cleaner is there, which you've said doesn't block you)" when that matters.
  - A whole calendar can be set not to block (a standing preference naming it); it is
    still read and its events still shown when asked, so the choice stays visible.
  - Free/busy stays the path for other people's calendars, which Curia can't list.
- **Holds:** placed on the home calendar of the chosen mailbox. Release on booking or
  accept searches holds on all the principal's calendars by conversation metadata (not only
  the same calendar). The nightly sweep covers every mailbox.
- **RSVP:** `calendar-respond-to-invite` answers as the mailbox the invite arrived in (the
  consult's `mailbox`), finding the event in that grant by the invite's iCal UID (verify the
  Nylas events filter on a live grant; fall back to today's time-window match within that
  grant only). The `account` input becomes the mailbox id and is enforced.
- **Same meeting on both calendars:** `calendar-list-events` over the principal's calendars
  collapses events with the same iCal UID into one entry listing both calendars.
  meeting-debrief's `seen:` / `prompted:` guards key on the iCal UID when present.
  contacts' 90-day meeting briefing counts the collapsed list.
- **Calendar agent prompt:** "the principal's calendar" becomes "the principal's
  calendars"; mailbox choice lives in tool descriptions (budget).
- Curia's own calendar (registered to the agent contact) is unchanged; its row is tied to
  the grant it is read through.

### D8. Sent-observe and voice learning

- Per-mailbox state: `sent_observe.<mailbox>.last_seen_at`, `.last_run_found_nothing_at`,
  `.backfill_before`, `.backfill_target`, `.held_since`, and the learning-state keys in
  `skills/_shared/learning-state.ts` that hold grant-scoped IDs (`matched_draft_ids`,
  `completion_candidates`, `asked_task_ids`, and any other key there holding message, draft
  or thread IDs); the migrated mailbox's keys are renamed from today's global ones (D1). One daily job loops over mailboxes; a failing
  mailbox does not block the others or move their watermarks.
- Voice-learning snapshots, shadow drafts and pending diffs carry `mailbox`. `voice-learn`
  keeps one writing-voice guide; the proposal may note differences by account ("at work you
  sign off …"). Matching (draft ↔ sent, shadow ↔ sent) stays within a mailbox.
- Task-completion-from-sent and shadow competence rows (`autonomy_action_log`) work as
  today, fed from every mailbox.
- **Memory provenance (cheap only):** wherever a write already records a free-text source,
  add the mailbox to it; build nothing new to carry it.
  - `memory-store` from ceo-inbox: **not done.** The stored source is the rate-limit key
    built in `execution.ts` (`agent:…/task:…/channel:…`), which can't know the mailbox;
    adding it would be new plumbing.
  - **Fact and relationship extraction** (decided by the principal, 2026-11-12): the
    checkpoint processor (`src/checkpoint/processor.ts`) already builds a source string
    (`system:checkpoint/conversation:…/agent:…/channel:…`) for `extract-facts` and
    `extract-relationships`. Append `/mailboxes:<ids>`: the mailbox ids in the
    conversation's ceo-inbox `tool.result` audit rows (they carry `mailbox`, D3), read with
    one query on the indexed `audit_log.conversation_id` (checkpoint turns hold no tool
    results). A triage batch can mix mailboxes, so this records the set, not a per-fact
    source. Per-fact attribution would need new plumbing, which the principal ruled out.
  - Nothing reads it yet; it is there if a need appears.

### D9. Principal identity and dispatch

- All mailbox addresses are verified principal identities (D1), so the acquaintance check,
  Principal Contact Details, gateway principal checks and Curia's own email channel treat
  them as the principal.
- The acquaintance check (`NylasPrincipalMailbox.hasSentTo`) searches every mailbox's Sent
  in parallel: any hit is true; all failed is "unknown" as today.

### D10. Console, setup, health, test mode, docs

- **Console / vault:** the fixed two-field `PrincipalMailboxSection` becomes a list like
  email accounts: add (id, label, grant ID → Test shows the grant's address and provider),
  relabel, set default, test, remove. Routes replace `PRINCIPAL_MAILBOX_KEYS`; the vault
  key regex allows `principal.mailbox.<id>.nylas_grant_id`.
- **Setup catalog:** new entry "Principal mailboxes and calendars" in
  `skills/setup/tools/setup-status/catalog.yaml` (completion: at least one mailbox that
  tests OK), with `credential_how_to` and a `docs_url` to a new curia-docs page.
- **Health:** per-mailbox canary (grant reachable + list one message + list calendars),
  check name per mailbox; an outage alerts once, not every run.
- **Test mode:** the recording principal mailbox and calendar become per mailbox.
- **Docs:** ADR-064 (registry; code chooses the account from the object; evidence-based
  choice for new objects); spec 15 (principal-mailbox sends per mailbox), spec 04
  (channels), spec 17 (debrief dedupe); curia-docs page; changelog fragment per PR.

### D11. Failure modes and their guards

| Failure | Guard |
|---|---|
| A write runs in the wrong account | Code picks the account from the object (D2); unknown id never falls back to default; explicit wrong mailbox → 404, no retry elsewhere |
| "work" wired to the personal grant | Address taken from the grant itself; duplicates refused (D1) |
| Stray label created in the wrong account | Message verified before label resolution (D3) |
| New draft or meeting in the wrong account | Required `mailbox` + evidence + standing preferences; mention when uncertain, ask when split; cheap move (D5) |
| Account announced on every obvious choice | Mention only on a judgement call (D5) |
| `mailbox` argument silently dropped by a provider | Declared after required inputs; a missing one locates, asks or reads all, never defaults (D3) |
| Send from the wrong account | Gateway sends from the draft's own mailbox; read-back names it (D6) |
| Cap-held replies mistaken for judgement holds | One "reached today's limit" notice, separate from holds (D6) |
| Work invite RSVP'd as personal | RSVP as the arrival mailbox, event found in that grant (D7) |
| Holds on the wrong calendar / orphaned | Holds on the chosen mailbox's calendar; release and sweep across all (D7) |
| `primary` hits the wrong account | Never sent bare; rewritten per mailbox (D7) |
| False "you're free" | Every home calendar always read; partial is reported (D7) |
| Cleaner's visit blocks a meeting | Conflicts judged against calendaring preferences with titles in view; `treat_as_free` (D7) |
| Rule meant for work fires on personal | `Mailbox:` scope; confirmed at creation (D4) |
| Personal ↔ work reply loop | No autonomous send to another principal address or in reply to one (D6); mail from the other address is Seen (D4) |
| Same message triaged twice | `Message-ID` dedupe across mailboxes (D4) |
| Same conversation, two cooldowns | Cooldown keyed on the conversation too (D6) |
| Reply-all Cc's the other address | All principal addresses excluded (D3) |
| Backlog flood on connect | Start line, backlog alarm, daily ceiling (D4) |
| One mailbox starves the other | Round-robin batches across due mailboxes (D4) |
| Shared watermark clobbered | Per-mailbox state (D8) |
| One grant revoked | Other mailbox keeps working; failures named; one alert (D3, D10) |
| Same meeting debriefed twice | iCal UID dedupe (D7) |
| Renamed mailbox orphans settings | Immutable id, editable label (D1) |
| Old job's address still treated as the principal | Removal asks "still yours?"; no → identity removed (D1) |
| Notices keep going to a removed address | Removal requires a new primary email first (D1) |
| Old rules or state attach to a new "Work" mailbox | Ids never reused; scoped rules deleted or rescoped at removal (D1) |
| Removed calendar reported as failing forever | Listed as removed, not partial (D1, D7) |
| Round-the-clock heartbeat burns tokens | Heartbeat is code; wakes the agent only when a due mailbox has mail (D4) |
| Half-converted code runs two mailboxes | One-mailbox cap until the last PR (D1) |

## Delivery

One issue (#2475, widened and resized to match this document), shipped as a stack of PRs
merged in order; single-mailbox installs work after each one, and the one-mailbox cap is
lifted only in the last.

1. **Registry and resolver:** table, migration of the existing install, `PrincipalMailboxes`
   service, verified identities, console list (add, relabel, set default, remove with its
   consequences), health, setup catalog. No behaviour change.
2. **ceo-inbox and sending:** tool `mailbox` inputs and results (schema order), `locate`,
   reply-all, label verification, gateway per-mailbox send level, ledger and limits, the
   limit-vs-judgement notice, compose evidence, `move_to_mailbox`, acquaintance check.
3. **Triage and sent-observe:** code heartbeat, cadence with windows, due/round-robin
   listing, start line, backlog alarm, daily ceiling, `Message-ID` dedupe, rules scope,
   per-mailbox sent-observe, extraction provenance.
4. **Calendar:** registry column, per-mailbox clients, availability across every calendar
   with event-level conflicts and `treat_as_free`, holds, RSVP, iCal UID dedupe, debrief.
   Lifts the one-mailbox cap.

## Left to the builder

- Exact names of new inputs, result fields, config keys and the composite page token.
- Whether `PrincipalMailboxes` lives under `src/channels/email/` or a new module.
- How the round-robin and due computation are split between the list handler and a helper.
- The defaults for backlog threshold (100) and daily ceiling (120 batches) may be tuned.
- Whether the upgrade migration runs in boot code or a one-shot script invoked at boot.
- Which Nylas behaviours need a one-time live check on a real Gmail grant (iCal UID filter,
  header fetch for `Message-ID`, reply headers on drafts) and the fallback where one fails.

## Calls made by Claude (not discussed with the principal)

- The migrated mailbox's id comes from its address domain (`gmail`, or the work domain's
  first word), never `primary` or `default`.
- A new mailbox's send level defaults to `on_request`; cadence defaults to
  `hourly 06:00-23:00` (today's behaviour).
- Removal: "is the address still yours?" defaults to no for a non-consumer domain; ids
  are tombstoned and never reused; removing the default picks the new one on the same
  screen; a removed primary email must be replaced first.
- Event-level conflicts via event listing plus `treat_as_free`, rather than a per-calendar
  on/off switch alone.
- The thread cooldown is grouped with the cap as "waiting because of a limit".
- Tools this work touches get required-first schema order with a manifest test; the
  repo-wide lint stays in #2325.
- Mailbox evidence is a live search, not a stored tally, offered as a service so calendar
  tools use it too.
- Duplicates: first triage pass to see a copy wins (stateful, 30-day record); replies still
  go from the address the sender wrote to; the other copy is marked read and labelled, not
  archived.
- A calendar is registered through one grant only; the owning account's grant wins.
- Calendar writes require a stated `mailbox` like compose, including no-attendee events.
- The upgrade migration never touches principal identities; adding a mailbox never changes
  the principal's primary email, and system notices follow the primary.
- A moved draft keeps its authorship class for send review.
- No per-mode model tier is built up front; scenario results decide.
- Mail from the principal's other address is 📌 Seen by default.
- One writing-voice guide with account notes, not two profiles.
- The one-mailbox cap until the stack completes.

## Acceptance criteria

- [ ] Two or more named principal mailboxes can be configured; an existing install upgrades
      with its mailbox as default, unchanged behaviour, no operator action.
- [ ] A mailbox's address is read from its grant; a duplicate or mismatched grant is refused.
- [ ] Every ceo-inbox tool accepts an optional `mailbox`; tools on an existing message or
      draft find its mailbox without being told; an ID found in two mailboxes is refused as
      ambiguous; an unknown mailbox never falls back to the default.
- [ ] `list` / `search` with no `mailbox` return labelled results from every mailbox; one
      mailbox failing does not hide the other's results and is reported.
- [ ] `draft-reply` drafts in the message's own mailbox and excludes every principal address
      from reply-all.
- [ ] `draft-compose` never creates a draft without a stated mailbox when more than one
      exists and returns evidence when asked without one. The agent's reply names the
      account on a judgement call and not when the principal or a standing preference
      settled it (scenario cases). `move_to_mailbox` moves a draft and deletes the original
      only after success.
- [ ] Every touched tool declares `mailbox` after its required inputs and payload (manifest
      test); a call without it never acts on the default mailbox by assumption.
- [ ] Sends use the draft's own mailbox and that mailbox's send level; no autonomous send to,
      or in reply to, another principal address; the cooldown spans the conversation across
      mailboxes; the batch read-back names each draft's account.
- [ ] Replies held by the daily cap produce one "reached today's limit" notice listing them,
      separate from judgement holds; the agent's result and triage summary keep the two
      apart.
- [ ] "Send my draft" with one draft across all accounts sends it; with one in each account
      and no deciding context Curia asks, naming both; when the conversation or the
      instruction names the account it sends without asking (scenario cases).
- [ ] A code heartbeat runs every 15 minutes, around the clock, and wakes the agent only when
      a due mailbox has unread mail past its start line and no drain is running; a quiet
      tick makes no model call.
- [ ] Triage honours per-mailbox cadence and window, round-robins due mailboxes, never
      auto-triages mail before a mailbox's start line, raises the backlog alarm once, and
      stops at the daily ceiling (all enforced in code).
- [ ] A message delivered to both mailboxes is triaged once.
- [ ] Rules with a `Mailbox:` line apply only there; rules without one apply everywhere.
- [ ] Sent-observe keeps independent state per mailbox; voice-learning records carry the
      mailbox; memory-store and checkpoint extraction sources carry the mailbox ids where
      the source string already exists.
- [ ] Each mailbox's calendar is connected; availability reads every home calendar and
      reports partial on failure; conflicts on the principal's calendars come back with
      titles, and `treat_as_free` lets a preference-excluded event (the cleaner) not block;
      events and holds land on the chosen mailbox's calendar; RSVPs answer as the arrival
      mailbox; bare `primary` is never sent unscoped.
- [ ] Removing a mailbox: asks whether the address is still the principal's and removes the
      identity on no; requires a new primary email if it was the primary; picks a new
      default on the same screen; deletes or rescopes rules scoped only to it; its
      calendars show as removed, not failing; its id is never reused and none of its state
      attaches to a later mailbox (unit tests).
- [ ] A meeting on both calendars is listed and debriefed once.
- [ ] The console can add, relabel, test, set default and remove a mailbox; setup catalog,
      curia-docs, ADR-064 and specs updated; per-mailbox health canary.
- [ ] Unit tests for mailbox resolution and `locate`, cross-mailbox list, triage due and
      round-robin, dedupe, the upgrade migration, availability union and calendar routing;
      new scenario cases written for account choice (CFO, sister, shared accountant,
      work-team calendar, correction) and cross-mailbox loops, run with the maintainer's
      agreement.
