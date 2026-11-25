# ADR-068: Operator notices — route technical alerts to whoever set Curia up

Date: 2026-11-22
Status: Accepted
Amended: 2026-11-23 — the deep dive adds `deep_dive_failed` (the scan or drafting failed) and `deep_dive_delivery_failed` (drafts written, hand-off lost), both operator-routed (#2362)

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
| `deep_dive_failed`, `deep_dive_delivery_failed` (onboarding deep dive, #2362; added later) | operator |
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
become callers of `sendNotification`, keeping the once-per-run dedupe and the progress note on
the onboarding task. The four onboarding events
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
- **The state records what was raised.** `operatorNotified` is the once-per-run guard. A notice
  whose task note could not be written gives its event back, so a retry raises it.

**Changing the operator.** The console's System → Operator page views, changes or clears the
operator after Setup, with an explicit Save (the console's no-save-on-blur rule) and the change
history from `settings_history` (ADR-067).

**No confirmation notice, and no delivery tracking.** Saving an operator sends nothing to them,
and nothing records whether a notice arrived. These are email notifications: `sendNotification`
reports whether a notice was published, a failed send is logged at error level by the email
adapter, and that is all. A confirmation email with a stored "sent / pending / failed" status, retries
at boot and Start, and outcome tracking through the outbound queue was built and then removed in
review as far more machinery than a notification warrants. A mistyped operator address goes
unnoticed until someone looks, as it would for any mail setting.

**Deliverability is checked once, in the gateway.** A notice published before an email adapter
has subscribed reaches no one, so `sendNotification` checks `canDeliver` first and audits the miss
as `delivery_unavailable`. Callers that do work before publishing (the outage notifier mints a
single-use sign-in link) ask `gateway.canDeliverNotifications()` first.

## Consequences

- **One place decides who hears about what.** A new notification type is one table entry, and
  forgetting it is a compile error rather than a silent default. Changing a rule is one line
  reviewed against this ADR.
- **The executive whose EA set Curia up stops getting infrastructure mail.** That is the point,
  and the operator can forward what matters.
- **An install with no operator keeps today's behaviour.** The fallback is the principal, not a
  new failure mode, and the tests for the pre-operator world pass with only the recipient argument
  removed.
- **A mistyped operator address is not caught.** Nothing confirms the address. The console's
  Operator page shows it, and notices that fail to send are logged at error level.
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
- **The operator cache is refreshed on every write.** `createOperatorEmailLookup` answers with
  the last value it read or was told, so `database_unavailable` — raised while that read is
  failing — still reaches the current operator rather than a former one. A read that fails
  before any success is logged at error level, because the fallback may then be the wrong
  person.
