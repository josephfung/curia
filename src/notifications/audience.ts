// audience.ts — which of the two people each system notification is for (#2710, ADR-068).
//
// Curia tells two people about its own trouble, and only these two: the principal it works
// for, and the operator who set it up (an EA, an IT person, a technical friend) when that was
// someone else. A notification type has exactly one audience, fixed here. Callers state what
// happened and never choose a recipient, so "should the executive see this?" is answered once,
// in one table, rather than afresh at every call site.
//
// The table is a `Record` over the notification-type union, so a new type with no audience
// chosen fails typecheck. That is the whole enforcement: it cannot be forgotten, and it cannot
// be satisfied by a default.
//
// Two rules the table encodes, both from ADR-068:
//   - **No duplication.** When an operator is set, an operator-routed notice goes to the
//     operator only. Telling the executive is the operator's call, not Curia's.
//   - **A principal mailbox outage raises two types.** `principal_mailbox_outage` carries the
//     sign-in link that only the principal can use, so it is principal-routed; the same outage
//     raises `mailbox_outage` for the operator, whose body carries no link and no address.
import type { NotificationAudience, NotificationType } from '../bus/events.js';

export const NOTIFICATION_AUDIENCES: Record<NotificationType, NotificationAudience> = {
  // The principal's own business: their mail, their approvals, their learning proposals.
  contact_rate_limited: 'principal',
  approval_requested: 'principal',
  learning_proposal: 'principal',
  inbox_triage_paused: 'principal',
  principal_mailbox_outage: 'principal',
  // No longer emitted (#2159), kept so historical and replayed payloads still resolve.
  blocked_content: 'principal',
  approval_expired: 'principal',
  principal_note: 'principal',

  // Running the install: infrastructure, schedulers, and other people's sign-ins.
  database_unavailable: 'operator',
  mailbox_outage: 'operator',
  schedule_suspended: 'operator',
  schedule_recovered: 'operator',
  mailbox_signin_admin_blocked: 'operator',

  // The onboarding program's own trouble: it is the operator's job to unblock Setup.
  greeting_unanswered: 'operator',
  invitation_expired: 'operator',
  web_search_failed: 'operator',
  mailbox_signin_blocked: 'operator',
  deep_dive_failed: 'operator',
  deep_dive_delivery_failed: 'operator',
};

/** The audience for a notification type. Total over the union above by construction. */
export function notificationAudience(type: NotificationType): NotificationAudience {
  return NOTIFICATION_AUDIENCES[type];
}

/** Every type that is operator-routed, for tests and docs. Order is the table's. */
export function operatorNotificationTypes(): NotificationType[] {
  return (Object.keys(NOTIFICATION_AUDIENCES) as NotificationType[])
    .filter((type) => NOTIFICATION_AUDIENCES[type] === 'operator');
}

/** Every type that is principal-routed, for tests and docs. Order is the table's. */
export function principalNotificationTypes(): NotificationType[] {
  return (Object.keys(NOTIFICATION_AUDIENCES) as NotificationType[])
    .filter((type) => NOTIFICATION_AUDIENCES[type] === 'principal');
}
