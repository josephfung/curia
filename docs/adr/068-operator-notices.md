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
  approver or a known contact in the knowledge graph. ADR-034/035 principal carve-outs and the
  autonomy bands are unchanged. (Delivery itself records the address as an ordinary email
  recipient — an `unknown`-tier contact row, as any first-time recipient gets — and that grants
  nothing.)
- A future contact or role model is deliberately deferred. It needs per-person console login
  first, because today's console is one shared secret and cannot tell the operator from the
  principal.

**Operator notices carry no principal content.** System names, ids, counts, error codes and
console links only: no job objectives, sender addresses, message text or model-written details.
Operator-routed `schedule_suspended` / `schedule_recovered` bodies therefore drop the job's
objective. Onboarding notices carry the event plus typed facts (the OAuth client id to trust); a
tool call's free-form `details` reach the task note, log and audit row by key name only. This is
enforced by the review checklist and by tests, not by types: a typed operator payload was
considered and rejected as premature while the user and role model may still change.

**Onboarding.** `notifyOperator` / `notifyOperatorOnce` (`src/onboarding/notify-operator.ts`)
become callers of `sendNotification`, keeping the once-per-run dedupe, the progress note on the
onboarding task and the `onboarding.operator_notice` audit callback. The four onboarding events
are now notification types in the one table. The `setupFor=self` rule in
`skills/onboarding/SKILL.md` still holds, since the principal is then the operator.

**Changing the operator.** The console's System → Operator page views, changes or clears the
operator after Setup, with an explicit Save (the console's no-save-on-blur rule) and the change
history from `settings_history` (ADR-067). Saving an operator email, in Setup or Settings, sends
one short confirmation notice to that address and reports whether it was published. This stands
in for the missing fallback: a mistyped address shows up immediately instead of swallowing
alerts.

## Consequences

- **One place decides who hears about what.** A new notification type is one table entry, and
  forgetting it is a compile error rather than a silent default. Changing a rule is one line
  reviewed against this ADR.
- **The executive whose EA set Curia up stops getting infrastructure mail.** That is the point,
  and the operator can forward what matters.
- **An install with no operator keeps today's behaviour.** The fallback is the principal, not a
  new failure mode, and the tests for the pre-operator world pass with only the recipient argument
  removed.
- **A mistyped operator address is caught at save time, not later.** The confirmation notice is
  the only signal, so it goes out on every operator save and the console shows the result. If the
  operator's mail is down at save time, the notice fails visibly and the setting still saves.
- **Two people can be told about one outage.** A principal mailbox outage raises two notices, by
  design: each type carries only what its audience can act on, and the link-bearing copy is
  principal-only. With no operator set the second notice is suppressed, so nothing duplicates.
- **The settings read happens per notice, and is cached against a failing database.** The
  `database_unavailable` notice is raised while that read is failing, so
  `createOperatorEmailLookup` answers with the last address it read (warmed at boot) rather than
  falling back to the principal mid-outage.
- **`OutboundNotificationPayload` is a changed public surface.** `ceoEmail` is replaced by
  `recipient` and `audience`; the change is noted in the changelog.
- **The operator's address becomes an unknown-tier contact after the first notice.** The outbound
  pipeline records every email recipient it successfully writes to; a system notice is no
  exception. It grants no tier, role or approval right, and the console's Operator page remains
  the only place the operator is defined.
