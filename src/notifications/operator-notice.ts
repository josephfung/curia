// operator-notice.ts — the "you're set as the operator" confirmation (#2710, ADR-068).
//
// Saving an operator email, in Setup or in the console, sends one short notice to that address.
// It is the smoke test for a typo: nothing else would reveal a mistyped address, and the
// alternative — copying operator notices to the principal as well — breaks the no-duplication
// rule. So the notice goes to the address that was just saved, and the console shows whether it
// was published.
//
// It is an ordinary system notice: operator-routed (`operator_configured` in
// NOTIFICATION_AUDIENCES), and sent through the one path, OutboundGateway.sendNotification.
import type { Logger } from '../logger.js';
import type { OperatorSetting } from '../settings/registry.js';
import type { OutboundGateway } from '../skills/outbound-gateway.js';

export interface OperatorConfirmationDeps {
  /**
   * The one system-notice path. Absent (no outbound gateway, as in a Signal-only install):
   * the save still succeeds, and the console reports that the notice could not be sent.
   */
  gateway?: Pick<OutboundGateway, 'sendNotification'>;
  /** The console's origin, for the notice's link. Absent: no link line. */
  appOrigin?: string;
  logger: Logger;
}

/**
 * Tell the operator their address is saved. Returns whether the notice was published (the
 * gateway accepted it; delivery is not confirmed). Never throws: a failed notice must not fail
 * the save that has already been written.
 */
export async function sendOperatorConfirmation(
  deps: OperatorConfirmationDeps,
  operator: OperatorSetting,
): Promise<boolean> {
  if (!deps.gateway) {
    deps.logger.warn(
      'operator notice: no outbound gateway — the operator was saved without a confirmation notice',
    );
    return false;
  }
  const link = deps.appOrigin?.trim();
  try {
    const sent = await deps.gateway.sendNotification({
      notificationType: 'operator_configured',
      subject: "You're set as Curia's operator",
      body: [
        `Hello ${operator.name},`,
        '',
        "You're set as Curia's operator.",
        '',
        'Curia emails you when something technical needs a person: its database being down, a Google',
        'Workspace policy blocking a mailbox sign-in, or a scheduled job that keeps failing.',
        '',
        'These notices are one-way. Curia acts on nothing you send back, and you are not a contact or',
        'an approver.',
        '',
        'This address is the only place they go, so change it in the console when it needs to change.',
        ...(link ? ['', `Console: ${link.replace(/\/+$/, '')}/`] : []),
      ].join('\n'),
    });
    if (!sent) {
      deps.logger.error(
        'operator notice: the confirmation could not be sent — the operator setting is saved',
      );
    }
    return sent;
  } catch (err) {
    deps.logger.error(
      { err },
      'operator notice: sending the confirmation threw — the operator setting is saved',
    );
    return false;
  }
}
