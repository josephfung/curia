// mailbox-outage-notifier.ts — alert the principal once per principal-mailbox outage (#2475).
//
// The canary calls record() after probing each mailbox. The first failure of an episode sends
// one email through OutboundGateway.sendNotification (LLM-free, same pattern as
// DbAvailabilityMonitor); later failures stay quiet until a probe passes, which ends the
// episode. If the alert could not be sent (no principal email yet, bus down) the next failing
// probe tries again, so it is not lost.
//
// The alert names the mailbox by label only: never its address or Nylas grant id.
import type { Logger } from '../logger.js';
import type { OutboundGateway } from '../skills/outbound-gateway.js';

export interface MailboxOutageNotifierDeps {
  gateway: Pick<OutboundGateway, 'sendNotification'>;
  /** Live lookup: the principal's email may be bound after boot. */
  principalEmail: () => string | undefined;
  /**
   * Whether a published notification is delivered right now: the primary ('curia') email adapter
   * has subscribed (EmailAdapter.deliversNotifications). A publish before that reaches no one, so
   * it is not counted as sent and the next failing probe tries again. Absent: assumed delivered.
   */
  canDeliver?: () => boolean;
  logger: Logger;
}

export class MailboxOutageNotifier {
  /** Mailbox ids whose current outage episode has already been alerted. */
  private readonly alerted = new Set<string>();
  private readonly log: Logger;

  constructor(private readonly deps: MailboxOutageNotifierDeps) {
    this.log = deps.logger;
  }

  /** `authFailure`: the probe got a 401/403, which reconnecting fixes. Anything else (a
   *  timeout, a Nylas server error) gets connectivity guidance instead. */
  async record(mailboxId: string, label: string, ok: boolean, opts: { authFailure?: boolean } = {}): Promise<void> {
    if (ok) {
      if (this.alerted.delete(mailboxId)) {
        this.log.info({ mailboxId }, 'Principal mailbox recovered');
      }
      return;
    }
    if (this.alerted.has(mailboxId)) return;

    const ceoEmail = this.deps.principalEmail();
    if (!ceoEmail) {
      this.log.warn({ mailboxId }, 'Principal mailbox is failing but the principal email is not bound yet; will alert on a later probe');
      return;
    }

    if (this.deps.canDeliver && !this.deps.canDeliver()) {
      this.log.warn({ mailboxId }, 'Principal mailbox is failing but no email adapter delivers alerts yet; will alert on a later probe');
      return;
    }

    const sent = await this.deps.gateway.sendNotification({
      notificationType: 'principal_mailbox_outage',
      ceoEmail,
      subject: `Curia cannot reach your "${label}" mailbox`,
      body: [
        `Curia's health check for your "${label}" mailbox failed.`,
        '',
        'Mail and calendar for that account are not being read or written until it is reachable again.',
        ...(opts.authFailure
          ? [
            "Nylas refused the connection, which usually means it was revoked or expired: reconnect the account in Nylas, then use Replace grant on the mailbox in the console (Settings → Personality → Email & Calendar).",
            'If the account no longer exists, remove the mailbox there so Curia stops checking it.',
          ]
          : [
            'Nylas did not answer in time or reported an error of its own. This is often temporary: check the Nylas status page, and that the Nylas API key in the console is still valid.',
          ]),
        '',
        'You will not get another alert for this mailbox until it has recovered and failed again.',
      ].join('\n'),
    });
    if (sent) {
      this.alerted.add(mailboxId);
      this.log.error({ mailboxId }, 'Principal mailbox outage: alert sent');
    } else {
      this.log.error({ mailboxId }, 'Principal mailbox outage: alert could not be sent; will retry on the next failing probe');
    }
  }
}
