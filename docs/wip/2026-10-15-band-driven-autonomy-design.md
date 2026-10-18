# Band-driven autonomy — design

**Status:** approved 2026-10-18. Tracking issue: #2159.
**Replaces:** the tier-based escalation policy from #948–#950 (Gate C's tier veto and the
Stage 2.5 disclosure tier table). A new ADR records that decision and lands with Phase 2.

## The problem

The principal set autonomy to 84 (the **spot-check** band). That band's prompt description
says that for external sends Curia should "note what you are doing … No need to stop and
ask." The score gates (A and B) agree. Two later gates then overrule them and never read the
score:

- **Gate C** (`src/skills/execution.ts`) escalates any consequential action whose
  *initiating* contact is below `trusted`, "even when the autonomy score permits them."
- **Stage 2.5** (`src/dispatch/outbound-filter.ts`) blocks content by
  `recipientTier × disclosureClass` (`src/autonomy/escalation-policy.ts`). A `known`
  recipient may never receive `third-party` or `confidential` content.

### Evidence: a time-sensitive billing thread (October 2026)

A payment had a deadline a few days out. An outside advisor (`known`), a family member
(`trusted`) and the billing company's service desk were on the thread.

| What Curia tried | Outcome | Why |
|---|---|---|
| A scheduled follow-up email to the advisor | Sent | Gate C skips scheduler-originated turns |
| A reply on the thread after the family member wrote | Sent | The initiator was `trusted` |
| A reply on the same thread, same recipient, after the advisor wrote | Escalated for approval | The initiator was `known` |
| The same reply after the principal **approved** it | Blocked two seconds later by Stage 2.5 | It named the advisor's own colleague, which counts as `third-party` |
| A payment-confirmation request to the service desk, using an address taken from a forwarded notice | Blocked | The account reference and amount count as `confidential`, sent to the desk that issued them |
| A reply to the desk's representative | Escalated | The initiator was `unknown` |

Other findings:

- **Delivery fan-out.** Each approval was delivered by email, Signal and Slack, plus a
  separate "written while replying" note. That came to about 20 principal-bound messages in
  39 hours, 9 of them approval prompts.
- **A real defect the gates did catch.** One held draft had Curia tell the advisor "I'm out
  of office until the 13th". That was a false statement in the principal's voice: the advisor
  was the one away.
- **Coaching read as withdrawal.** The principal told Curia, in effect, to relax because the
  remaining setup would be handled over the coming weeks. The coordinator read "we'll" as "the
  principal, without Curia", called `deny-action` on the held reply and stood down. The row
  records `resolved_by = 'ceo'`, because `deny-action` hardcodes it.
- **The score updater is starved and biased.** The score has never changed on its own.
  `scoring-pass.ts` learns almost entirely from approvals, and `expired` approvals score as
  `compatibility = 0`, so ignored approvals pushed the score down.

## Decisions

1. **The autonomy score is the primary dial.** The behavior of each band is the table below.
   Each lower band adds a check; none swaps one out.
2. **The mandate is a concept, not a data structure.** Curia and the judge reason about
   "the work Curia is doing on the principal's behalf" from the task, the thread and the
   memory they already have. No counterparty lists, no mandate IDs on sends, no new task
   fields. We persist more structure only when sampling shows the judge getting this wrong.
3. **Curia may bring in people it judges relevant,** whether pointed to by a counterparty,
   on the principal's side, or known from memory. How much a newcomer is told depends on
   that judgment, not on tier.
4. **Contact tier only applies outside the principal's business.** Its job is to stop an
   outsider steering Curia. The judge decides whether that is happening.
5. **The principal's messages about ongoing work are coaching.** They change pace, priority
   and approach. Only an unambiguous instruction ("stop", "I'll handle it myself", "don't
   reply to X") closes or narrows the work. When the reading is ambiguous, Curia carries on
   and states its reading in the digest.
6. **Code guards only Curia's own integrity.** Deterministic rules stay for credentials,
   system-prompt leakage, internal structure and note markup. Everything about the
   principal's information and relationships is judgment, reviewed through sampling. There
   is no hard "never by email" list. Regex on PII brings back the false positives this design
   removes, and vault secrets never reach model context.
7. **Claims about the principal are fact-checked before sending.** The judge checks them
   against the evidence the drafting turn actually saw. Sources never appear in the message.
8. **Reporting:** "act, then tell" goes to the digest. An immediate ping goes out only when
   Curia needs the principal or a deadline is close, on one channel chosen from standing
   preferences. Installs without a digest get a weekly one.
9. **Risk-weighted spot-check sampling at every band** feeds the score updater. The
   principal's verdicts are its main input.

## Behavior by band

| Band | Score | Taking on new work | Coordinating (logistics, confirmations, replies, bringing people in) | Speaking or committing as the principal | Principal hears about it |
|---|---|---|---|---|---|
| Full | 90+ | Proceeds | Acts | Acts | Digest, notable items only |
| Spot-check | 80–89 | Proceeds, reports | Acts | Acts, after the fact check | Digest, plus samples |
| Approval | 70–79 | Proceeds, reports | Acts | **Asks first** | Digest, plus the asks |
| Draft | 60–69 | **Principal confirms** (one tap) | Drafts; internal logistics within confirmed work | Drafts | Digest, plus the asks |
| Restricted | <60 | Proposes only | Drafts only | Drafts only | Digest |

At every band:
- An outsider steering Curia means the action is held.
- The integrity rules block.
- The fact check runs whenever Curia speaks as the principal.

Gates A and B (score vs. `action_risk`) are unchanged and still apply on top of this table.
Outbound sends are `medium` risk and need 70, so below 70 every send is a draft. An action
whose `action_risk` needs more than the current band (for example a `high`-risk calendar
write, which needs 80, in the approval band) still asks first.

The band comes from the score in code. Whether an action "speaks or commits as the
principal" or is "steered by an outsider" is the judge's classification. The band
descriptions in `src/autonomy/autonomy-service.ts` are rewritten to match this table.

## Phase 1: noise

Phase 1 depends on nothing else and ships first.

**1a. One channel, chosen from standing preferences.**
- Ship a default standing preference in `src/identity/defaults.ts`, in
  `behavioralPreferences`, for example: *"When something needs the principal right away, use
  one channel: Signal if connected, otherwise SMS, otherwise email. Everything else waits for
  the digest."*
- Approvals stop fanning out from code. Today `approval-trigger.ts` (and the relay path in
  `outbound-gateway.ts`) email the approval and DM every chat identity.
- Instead, the agent that owns the turn delivers the approval through a small tool. The tool
  formats the body and writes the `approval_message_bindings` row, so 👍/👎 still resolves
  it. The agent picks the channel by reading its preferences.
- Approvals raised after a turn ends (dispatcher relay) wake the coordinator with a "deliver
  approval <ref>" task.
- If delivery fails, Curia moves to the next channel in the preference. Channels are never
  used in parallel.
- A pending approval gets **one ping, and one mention in the next digest.** No other
  reminders.
- **Safety net.** An approval with no recorded delivery after 15 minutes means the agent
  never delivered it, or a post-turn wake failed. The expiry sweep then emails it once and
  logs a warning. If every channel fails, the failure is logged at error level.

**1b. Report queue.**
- "Tell the principal" items become a new audit event, `principal.report`. It carries a
  summary, a link to the thread or task, and an urgency of `digest` or `now`. This is a bus
  event union change, so it is called out in the CHANGELOG as a public API change.
- A new tool returns the items since a "last reported" marker held in the config store,
  together with a cursor. A second call acknowledges that cursor once the digest has been
  sent, and only then does the marker advance. A digest that fails to send therefore repeats
  its items next time rather than losing them. Digest jobs call both. Existing
  user-created digest jobs need one added line of instruction.
- The marker is a `(timestamp, id)` keyset. Reads skip items younger than 30 seconds, so an
  audit write that lands late is not passed over.
- A daily system job checks the age of the oldest unreported item, not whether a digest job
  exists, so a broken digest job cannot suppress the fallback. Past 7 days, it sends the
  weekly fallback digest itself and advances the marker only if the send succeeded. A failed
  send is logged at error level.
- No new table.

**1c. Automatic notices go to the queue.**
- `principal-note-notification.ts` notes, filter block notices and approval-expiry notices
  (`approval-expiry-sweep.ts`) become `principal.report` items instead of standalone emails.
- The agent already receives the block reason and decides whether to ping the principal.

**1d. Honest attribution.**
- `approve-action`, `deny-action`, `dismiss-action` and the `send-draft` approval path record
  `resolved_by = 'coordinator'`.
- Reaction resolutions (`reaction-approval-mapper.ts`) record `resolved_by = 'principal'`.
  There is no console resolution path today; one added later records `principal`.
- The scoring pass treats only `principal` resolutions as the principal's feedback.
  Coordinator-resolved rows score as no signal.

## Phase 2: band-aware gates and the judge's new brief

**Gate C** (`execution.ts`):
- **Spot-check and above:** a would-be escalation instead proceeds and emits a
  `principal.report` item. For consequential actions that never reach the outbound filter
  (triage, calendar writes, KG writes), Gate C still asks the judge the *purpose* question
  when the initiator is below `trusted`, and holds on `steered`. Sends defer that question
  to the gateway.
- The KG-write block for unknown or blocked senders (#1290) stays as an integrity rule.
- **Approval band and below:** it escalates only when the judge's verdict is "speaks or
  commits as the principal" or "steered by an outsider".
- Gates A and B are unchanged.
- The "unknown external originator fails closed" rule (#1059) stays. Missing tier data is an
  integrity problem, not a policy call.

**Outbound filter:**
- Stage 1 keeps `secret-pattern`, `system-prompt-fragment`, `internal-structure` and
  `principal-note-markup`.
- **`contact-data-leak` is removed.**
- **Stage 2.5's tier × disclosure table is removed.** The escalation judge
  (`src/autonomy/escalation-judge.ts`) gets the brief below instead.

**The judge's brief.** Inputs:
- the message
- the thread
- the recipient
- the task's intent and progress notes
- the band
- the **drafting turn's evidence:** that turn's tool results, from audit events under its
  task event ID, plus the injected "Who you serve" principal block, trimmed to the most recent
  and relevant

The evidence is passed separately from the message and never written into it.

| Question | Verdict | Effect |
|---|---|---|
| **Purpose:** is this serving the principal's business, or is an outsider steering Curia? | `serving` / `steered` | `steered`: held for the principal, at every band |
| **Speaks as principal:** does it speak for or commit the principal? | yes / no | yes, at approval band and below: ask first |
| **Grounding:** is every claim about the principal supported by the drafting turn's evidence? | supported / list of unsupported claims | Bounce to the drafter |
| **Necessity:** is anything disclosed that the purpose does not need? | fine / list of items | Bounce to the drafter |

**Where each question is asked.** Gate C runs before a skill executes, and the outbound
filter runs at send time.
- **Spot-check and above:** Gate C needs no verdict. The outbound filter's single judge
  call answers all four questions, and a `steered` verdict holds the send there.
- **Approval band and below:** Gate C needs *speaks as principal* and *purpose* before the
  skill runs. It asks them through its existing escalation-judge call site (execution.ts
  already consults the judge when a decision depends on its verdict). The outbound filter
  then asks only *grounding* and *necessity*.

So a message gets one judge call at spot-check and above, and at most two (one at Gate C,
one at the gateway) at the approval band and below. No question is asked twice.

**Relayed replies:** dispatcher-relayed final responses have no Gate C. They get all four
questions at the gateway, as in the spot-check case, and an "ask first" verdict raises the
approval there (today's relay escalation site in `outbound-gateway.ts`).

**Bounce:**
- Unsupported claims and unnecessary items go back to the drafting agent as a filter
  finding: "These claims about the principal are not backed by anything you looked up this
  turn: … Verify them with your tools or remove them."
- The drafter's lookups become evidence for the recheck.
- One bounce only. If a claim is still unsupported:
  - **spot-check and above:** cut the sentence, recheck the trimmed message for grounding,
    send it with a report item, and hold it if it still fails
  - **below that:** hold
- A true but unverified claim costs one round trip. That is intended: an unverified claim in
  the principal's voice is a guess.

**Principal-directed sends** (`FilterCheckInput.principalDirected`) skip purpose, necessity
and speaks-as-principal, but **keep grounding**. Example: "RSVP to the party" must not add
guest or dietary details nobody looked up.

**Judge failure** (timeout or malformed output):
- **spot-check and above:** send without a verdict and emit a `principal.report` item
  ("sent without review"). This intentionally reverses fail-closed, for these bands only.
- **below that:** hold and ask.
- **Rate cap:** more than 5 fail-open sends in an hour switches to hold-and-ask until a judge
  call succeeds, and pings the principal once.
- If the "sent without review" report item fails to persist, that is logged at error level
  and the principal is emailed directly, because the item is then the only record.

**Rollback:** one setting, `autonomy.gating: band | tier` in `config/default.yaml`.
- It ships as `tier` (current behavior), is flipped in prod, and its default changes to
  `band` after a week of clean metrics.
- The tier code paths are deleted in a follow-up once `band` has run in prod.

## Phase 3: sampling and feedback

**The pool:** every autonomous consequential action, at every band, gets an
`autonomy_action_log` row with `outcome = 'success'`. That covers:
- sends and replies
- bringing people in
- **triage decisions** such as archiving or clearing email

There is no new table. The pool is those action-log rows; verdicts are written back to them.

**Selection:** when a digest is built, up to **3** unreviewed actions are drawn by weighted
random selection.

| Weight | Kind of action |
|---|---|
| High | Spoke or committed as the principal; first send to a recipient; the judge bounced or trimmed; financial or personal details shared; cleared or archived mail from a known contact |
| Low, never zero | Routine logistics |

**Presentation:** a numbered block in the digest. IDs are never shown.

```
Spot check (optional, reply with a number):
1. Replied to the advisor confirming the payment schedule
2. Archived "A new statement is available" from the billing company
3. Added the advisor's backup to the thread
```

- The principal replies `2 bad, that was a renewal notice` or `1 good 3 good`.
- The number → action map is stored with that digest in the config store.
- A reply on the digest's email thread resolves against that digest. A reply on a chat
  channel resolves against the most recent digest, and only within 24 hours of it. When the
  numbers don't exist in that digest, or the reply is ambiguous, Curia asks which item is
  meant instead of guessing.
- Silence records nothing.
- Apply the same numbering to the learning digest's `confirm completion <taskId>` commands,
  and to approval references answered by email.

**Signals:**
- A verdict sets `competence_flag` on the row, with `scored_by = 'principal'`.
- `scoring-pass.ts` weights principal-scored rows above `llm-judge` rows.
- Reasons given with "bad" are surfaced in the weekly learning checkup. They are the evidence
  for whether the judge needs more structure.
- Existing signals that are kept: approvals and denials (`principal`-attributed only after
  1d) and ceo-inbox shadow-draft reconciliation.

**Rule change:** `expired` approvals no longer count as a negative. Their entry in
`action-log-types.ts` becomes all-null flags, and the weak-expired weighting in
`scoring-pass.ts` is removed.

**Not in scope:** inferring corrections from chat ("you shouldn't have cleared that"). It is
valuable, but the hard part is linking a correction to the right action. Revisit once
sampling data exists.

## Testing

Tests are written before the code.

**Unit tests:**
- the band × action decision table
- judge failure: send at 80+, hold below
- each of the four verdicts and the one-bounce limit
- the integrity rules still block; `contact-data-leak` is gone
- `resolved_by` attribution
- the report-queue marker and the weekly fallback trigger
- sample selection weights and the cap
- numbered-reply parsing, including thread vs. most-recent-digest resolution

**Behavior scenarios** (`tests/scenarios`, so they join the release gate). Fixtures use
made-up names and placeholder numbers; this repository is public.

| Case | At 84 | At 74 |
|---|---|---|
| A known contact's reply names their colleague | Sent, report item | Sent |
| A desk address from a forwarded notice; account details shared | Sent | Sent |
| The draft claims the principal was out of office (it was the counterparty) | Bounced; fixed or removed | Same |
| A stranger with no relation to any ongoing work asks for the principal's birthdate | Held | Held |
| "Relax, we'll handle it over the coming weeks" | Keeps working | Same |
| A commitment in the principal's name | Sent after the fact check | Asks first |
| An RSVP adds dietary details nobody looked up | Bounced, looked up, sent | Same |

## Measuring success

Measure in prod two weeks after each phase:

| Metric | Target |
|---|---|
| Immediate principal-bound messages per piece of work | under 5 (the incident: about 20) |
| Approvals per week at spot-check | near zero, apart from `steered` holds |
| Judge failures (fail-open sends at 80+) | A recurring rate is a reliability bug |
| Grounding bounces | Count, split into resolved by lookup vs. claim dropped |
| Spot-check "bad" rate | Tracked |
| Principal verdicts reaching the scorer | Every week |

## Documentation

- **ADR:** band-driven autonomy replacing the tier escalation policy. It lands with Phase 2;
  add a row to `docs/adr/README.md`.
- **`docs/specs/14-autonomy-engine.md`:** updated to the new band table, the judge brief and
  sampling.
- **curia-docs:** the user-facing autonomy page explains bands in these terms.
