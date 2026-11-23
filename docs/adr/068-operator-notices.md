# ADR-068: Operator notices — route technical alerts to whoever set Curia up

Date: 2026-11-22
Status: Accepted

## Context

When someone other than the executive installed Curia — an EA, an IT person, a technical friend
— every technical alert still went to the executive, by email, through
`OutboundGateway.sendNotification`. That covered the database being down, a Google admin policy
blocking a mailbox sign-in, and suspended or recovered scheduled jobs. Setup already told the
operator *"Later, it will bring admin and support questions to you"* and recorded their name and
email, and nothing used that email.

The onboarding operator notices (`greeting_unanswered`, `invitation_expired`,
`web_search_failed`, `mailbox_signin_blocked`) were delivered to nobody: they wrote a note on the
onboarding task under `TODO(#2365)`.

Three questions shaped the design (#2365, settled on #2709's settings store and this issue):

- Who counts as the operator, and what may they do?
- Which messages go to them?
- How do they not collide with the principal carve-outs in ADR-034/035 and the autonomy bands?

## Decision

**One notification path, one audience per type.** `sendNotification` no longer accepts a
recipient. Callers state the notification type, subject and body. `NOTIFICATION_AUDIENCES`
(`src/notifications/audience.ts`) is a `Record` over the notification-type union mapping each type
to exactly one audience, `operator` or `principal`, so a type with no chosen audience fails
typecheck. The gateway resolves the address:

- `principal`: the principal's primary verified email, as before.
- `operator`: the `operator` setting's email (ADR-067). With no operator set — a "Myself"
  install, or one that predates the Setup page — it is the principal's email, so those installs
  behave exactly as they did.

The published payload carries the resolved `recipient` and the `audience` that chose it;
`ceoEmail` is gone (a bus-event change, called out in the changelog).

**Routing.**

| Notification type | Audience |
|---|---|
| `database_unavailable` | operator |
| `mailbox_signin_admin_blocked` | operator |
| `schedule_suspended`, `schedule_recovered` | operator |
| `mailbox_outage` (new: a principal mailbox outage, without the reconnect link) | operator |
| `principal_mailbox_outage` (with the reconnect link) | principal |
| `greeting_unanswered`, `invitation_expired`, `web_search_failed`, `mailbox_signin_blocked` (onboarding; new types) | operator |
| `operator_configured` (new: the operator's own confirmation notice) | operator |
| `inbox_triage_paused`, `contact_rate_limited`, `approval_requested`, `learning_proposal` | principal |
| `blocked_content`, `approval_expired`, `principal_note` (no longer emitted; kept so replayed payloads resolve) | principal |

A principal mailbox outage raises both types: only the principal can sign in to their own
mailbox, so the reconnect link must never reach anyone else. The operator copy is raised only
when an operator is *set*, so a "Myself" install gets one email about the outage rather than two.
The band-review cap email and the weekly-report fallback digest are direct sends to the
principal and are unchanged.

**No duplication.** When an operator is set, an operator-routed notice goes to the operator only.
Telling the executive is the operator's call. A notice that reaches nobody is logged at error
level and audited as `outbound.notification_undelivered` (type, audience and reason: no address,
or the bus refused the publish), with no fallback to the principal: a fallback would break this
rule. A notice with no address at all — no operator and no bound principal email — takes the same
audited path rather than a guess.

**The operator is told, never talked with.**

- Curia sends the operator one-way email notices and acts on nothing they send back.
- The operator holds no role, tier, trust or approval rights: they are not a principal, an
  approver, or a contact for any purpose. ADR-034/035 principal carve-outs and the autonomy
  bands are unchanged.
- **A system notice creates no contact.** The outbound pipeline normally records every recipient
  it writes to, at `known` tier — which would clear the unknown-sender hold for the operator's
  replies, let agents address them, and leave a row behind when they leave. So
  `promoteOrCreateRecipientContact` is skipped for a send carrying `isSystemNotification`, on
  both the direct path and the durable-queue flush (the flag travels with the queued row in its
  JSONB payload, stripped before a channel client sees it). The principal is already a contact,
  so principal-routed notices are unaffected.
- A future contact or role model is deliberately deferred. It needs per-person console login
  first, because today's console is one shared secret and cannot tell the operator from the
  principal.

**Operator notices carry no principal content.** System names, ids, counts, error classes and
console links only: no job objectives, sender addresses, message text or model-written details.

- `schedule_suspended` / `schedule_recovered` bodies drop the job's objective, and report the
  failure by **class** — `timeout`, `llm_failure`, `tool_failure`, `other` — never the message.
  The job's `last_error` is the stashed `agent.error` message, or up to 500 characters of the
  agent's own response when none arrived, so it can quote the principal's mail. The class rides
  on `schedule.suspended`'s payload (`lastErrorClass`), taken from the live structured error (or
  `timeout` for the watchdog's stuck-run suspension); the detail stays behind the console link.
- Onboarding notices carry the event plus typed facts (the OAuth client id to trust); a tool
  call's free-form `details` reach the task note, log and audit row by key name only.
- The one piece of principal-authored text allowed through is a mailbox's **label** ("Work") in
  the outage notices. It is a short console-set name, not content, and the alternative — "a
  principal mailbox" — would leave the operator unable to tell two failing mailboxes apart.

This is enforced by the review checklist and by tests, not by types: a typed operator payload was
considered and rejected as premature while the user and role model may still change.

**Onboarding.** `notifyOperator` / `notifyOperatorOnce` (`src/onboarding/notify-operator.ts`)
become callers of `sendNotification`, keeping the once-per-run dedupe, the progress note on the
onboarding task and the `onboarding.operator_notice` audit callback. The four onboarding events
are notification types in the one table. The `setupFor=self` rule in
`skills/onboarding/SKILL.md` still holds, since the principal is then the operator.

- **One path, one dedupe.** The `onboarding-progress` tool reaches the gateway through
  `OnboardingService.raiseOperatorNotice`, which is `notifyOperatorOnce` — so a model that raises
  the same event repeatedly emails the operator once, exactly as the watcher and the subscribers
  do. Before this, a repeat call only added another task note.
- **The tool may raise one event.** `web_search_failed` is trouble only the model can see. The
  other three are detected in code, so letting the model raise them would let a prompt-injected
  turn email a real-looking admin ask ("mark the app Trusted"), and duplicate the watcher's own
  notice. The manifest and `SKILL.md` say so. A repeated call answers `alreadyRaised: true` and
  succeeds, so the model has no reason to loop.
- **The state records what was raised, and whether it arrived.** `operatorNotified` is the
  once-per-run guard; `operatorNoticeFailed` names events whose notice reached nobody, so the run
  state does not claim the operator heard it. `notifyOperator` returns `{ recorded, emailed }`.

**Changing the operator.** The console's System → Operator page views, changes or clears the
operator after Setup, with an explicit Save (the console's no-save-on-blur rule) and the change
history from `settings_history` (ADR-067).

**The confirmation notice is owed, not fired and forgotten.** Saving an operator address sends
one short notice to it, because nothing else would reveal a typo: a wrong address swallows every
operator notice silently, and there is deliberately no fallback to the principal to notice it for
us. But the address is usually saved before Curia can send anything — "Who it's for" is the first
Setup step, and a fresh install has no email account until it restarts. So the notice is owed:

- A second settings key, `operator_confirmation: { email, attemptedAt, sentAt }`, records the
  last attempt for an address. `sentAt: null` means it reached nobody.
- It is attempted wherever delivery is possible — at boot once the email adapters start, on Start
  onboarding (`POST /api/onboarding/start`, not the Setup page opening, which is before any email
  account exists), and immediately from the console's own Operator page — and retried on the next
  attempt while it is owed.
- **A publish is not a delivery.** The email adapter sends the notice while the bus delivers the
  `outbound.notification` event, and it reports a refused or failed send to the gateway. A report
  that arrives while `sendNotification` is still publishing that event makes it return false, so
  the caller records the miss directly (the confirmation stays `failed`, an onboarding notice is
  recorded as not emailed). A report that arrives after it returned goes through the gateway's
  `onNotificationUndelivered` hook, which puts the confirmation back to `failed` — otherwise a mistyped address would read as confirmed for good, on exactly the
  installs where operator notices never arrive. The hook carries the address the notice went to,
  and the record is only cleared when it matches: a late failure for the previous operator address
  must not invalidate a newer confirmation that worked. The console says "queued" until a real
  delivery receipt exists.
- The console shows `sent`, `pending` (owed, nothing could send it yet) or `failed`, with the
  time. Setup says "we'll email … once Curia's own email is set up" and never frames an
  undeliverable notice as a mistake in the address, because at step 1 nothing has gone wrong.
- A save never blocks on the notice, and never comes at the cost of the rest of the step: the
  principal and their profile are written whatever happens to it.
- An unchanged save sends nothing, so a console session cannot email an arbitrary address on
  every press.

**A check that must not lie about delivery.** `sendNotification` reports whether the notice was
*published*, not delivered, so:
- Deliverability is checked once, in the gateway (`canDeliver`), instead of at each call site: a
  notice published before an email adapter subscribed would otherwise be reported as sent.
- The email adapter — the only place the real outcome is known — audits a missed delivery as
  `outbound.notification_undelivered` with `delivery_failed` or `delivery_refused`. A verified
  principal-account refusal is `delivery_refused` (a rule working); an account it could not verify
  is `delivery_failed`, because that is a check that failed, not a verdict.
- Callers that do work before publishing ask `gateway.canDeliverNotifications()` first, so a
  notice that cannot go anywhere does not burn a single-use sign-in link or write an audit row on
  every retry. The in-gateway check stays as the backstop.
- A refusal is not exempted. A send through an account bound to the principal's own mailbox is
  refused unless every recipient is the principal (#2474, ADR-062); an operator notice is not
  such a send, and must not put Curia's admin mail in the principal's Sent folder. It is audited
  as `delivery_refused` instead of failing silently.
- The console says "queued" rather than "delivered" wherever only a publish is known.

## Consequences

- **One place decides who hears about what.** A new notification type is one table entry, and
  forgetting it is a compile error rather than a silent default. Changing a rule is one line
  reviewed against this ADR.
- **The executive whose EA set Curia up stops getting infrastructure mail.** That is the point,
  and the operator can forward what matters.
- **An install with no operator keeps today's behaviour.** The fallback is the principal, not a
  new failure mode, and the tests for the pre-operator world pass with only the recipient argument
  removed.
- **A mistyped address that mail refuses shows at save time.** The confirmation notice is the
  only signal, so it is attempted on every operator save and the console shows the result: a send
  that is refused or fails reads as `failed`, and the setting still saves. A mistyped address that
  accepts mail cannot be detected — it is a delivery attempt, not a check that the right person
  got it (see "The confirmation is a smoke test" below).
- **Two people can be told about one outage.** A principal mailbox outage raises two notices, by
  design: each type carries only what its audience can act on, and the link-bearing copy is
  principal-only. With no operator set the second notice is suppressed, so nothing duplicates.
- **The settings read happens per notice, and is cached against a failing database.** The
  `database_unavailable` notice is raised while that read is failing, so
  `createOperatorEmailLookup` answers with the last address it read (warmed at boot) rather than
  falling back to the principal mid-outage.
- **`OutboundNotificationPayload` is a changed public surface.** `ceoEmail` is replaced by
  `recipient` and `audience`; the change is noted in the changelog.
- **A notice no longer records its recipient at all.** The guard is at the gateway, so it holds
  for every system notice, queued or immediate; the console's Operator page remains the only
  place the operator is defined, and it grants nothing.
- **The confirmation is a smoke test, not a delivery receipt.** It proves the address was
  accepted by the sending pipeline. A notice that fails is visible in `operator_confirmation`
  and in the audit row, and retried — but a mailbox that silently drops mail still fails
  silently, as it does for any sender.
- **The operator cache is refreshed on every write.** `createOperatorEmailLookup` answers with
  the last value it read or was told, so `database_unavailable` — raised while that read is
  failing — still reaches the current operator rather than a former one. A read that fails
  before any success is logged at error level, because the fallback may then be the wrong
  person.
