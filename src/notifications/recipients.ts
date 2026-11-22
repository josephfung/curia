// recipients.ts — turn a notification type into the one address it goes to (#2710, ADR-068).
//
// The audience comes from NOTIFICATION_AUDIENCES (./audience.ts); this module only finds the
// address for it. Operator-routed notices go to the operator's email from the settings store,
// and to the principal's when no operator is set — a "Myself" install, or one that predates the
// Setup page. Principal-routed notices always go to the principal.
//
// There is deliberately no fallback for an operator-routed notice whose operator address is
// set but undeliverable: falling back to the principal would break the no-duplication rule.
// A missing address on either side is reported as "no recipient", which the gateway audits
// (outbound.notification_undelivered) rather than sending to the wrong person.
import type { NotificationAudience, NotificationType } from '../bus/events.js';
import { notificationAudience } from './audience.js';

/** The two addresses a notice can go to, read fresh at send time. */
export interface NotificationRecipientDeps {
  /** The principal's primary verified email. Read live: it may bind after boot (#1514). */
  principalEmail: () => string | undefined;
  /** The operator's email from the settings store, or undefined when there is no operator.
   *  Must not throw: the `createOperatorEmailLookup` factory in ./operator-setting.ts logs a
   *  read failure and answers with the last address it read. */
  operatorEmail: () => Promise<string | undefined>;
}

export interface ResolvedNotificationRecipient {
  email: string;
  /** The audience the table chose. `email` is the principal's when the audience is
   *  `operator` and no operator is set, which is the documented fallback, not a fallback
   *  after a failed send. */
  audience: NotificationAudience;
}

/**
 * The address for a notification type, or null when there is none to send to. Never throws:
 * a lookup failure is the same as an absent address (nothing is sent, and nothing is sent to
 * the other person instead).
 */
export async function resolveNotificationRecipient(
  type: NotificationType,
  deps: NotificationRecipientDeps,
): Promise<ResolvedNotificationRecipient | null> {
  const audience = notificationAudience(type);
  if (audience === 'operator') {
    const operator = await deps.operatorEmail();
    if (operator) return { email: operator, audience };
  }
  const principal = deps.principalEmail();
  return principal ? { email: principal, audience } : null;
}
