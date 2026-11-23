// mailbox-outage-notifier.ts — alert on a principal-mailbox outage, once per episode
// (#2475, #2710).
//
// The canary calls record() after probing each mailbox. The first failure of an episode sends
// one email through OutboundGateway.sendNotification (LLM-free, same pattern as
// DbAvailabilityMonitor); later failures stay quiet until a probe passes, which ends the
// episode. If the alert could not be sent (no address yet, bus down) the next failing probe
// tries again, so it is not lost.
//
// A principal mailbox has two audiences and the gateway picks each from the notification type
// (NOTIFICATION_AUDIENCES, ADR-068):
//   - principal_mailbox_outage — the principal, and only they can use its reconnect link.
//   - mailbox_outage — the operator, with no link and no address.
// The operator notice is raised only when an operator is set, so a "Myself" install gets one
// email rather than two about the same outage (the no-duplication rule).
//
// Both alerts name the mailbox by label only: never its address or Nylas grant id.
import type { Logger } from '../logger.js';
import type { OutboundGateway } from '../skills/outbound-gateway.js';

export interface MailboxOutageNotifierDeps {
  gateway: Pick<OutboundGateway, 'sendNotification' | 'canDeliverNotifications'>;
  /**
   * Whether an operator is set (ADR-067's `operator` setting). When one is, the same outage
   * also raises the operator's link-free notice; when none is, that notice would go to the
   * principal and duplicate the one they already got. Absent: treated as no operator.
   */
  hasOperator?: () => Promise<boolean>;
  /**
   * A fresh 7-day sign-in link that reconnects this mailbox, or null when sign-in is not ready
   * (the email then keeps the grant-paste wording). Called once per alert, auth failures only.
   * The link goes in the email alone: never in a log or the canary detail.
   */
  mintReconnectLink?: (mailboxId: string, label: string) => Promise<string | null>;
  /** How long the alert waits for mintReconnectLink. Default MINT_RECONNECT_LINK_TIMEOUT_MS. */
  mintTimeoutMs?: number;
  logger: Logger;
}

/** The mint reads the registry and the DB; a stall past this sends the grant-paste wording. */
export const MINT_RECONNECT_LINK_TIMEOUT_MS = 10_000;

class MintTimeoutError extends Error {
  constructor() {
    super('Minting the reconnect link timed out');
    this.name = 'MintTimeoutError';
  }
}

export class MailboxOutageNotifier {
  /** Mailbox ids whose current outage episode has already been alerted. */
  private readonly alerted = new Set<string>();
  /** Mailbox ids whose operator copy has been published for the current episode. Kept apart
   *  from `alerted` so a failed operator send is retried on the next probe without telling the
   *  principal twice (#2710). */
  private readonly operatorAlerted = new Set<string>();
  private readonly log: Logger;

  constructor(private readonly deps: MailboxOutageNotifierDeps) {
    this.log = deps.logger;
  }

  /** `authFailure`: the probe got a 401/403, which reconnecting fixes. Anything else (a
   *  timeout, a Nylas server error) gets connectivity guidance instead. */
  async record(mailboxId: string, label: string, ok: boolean, opts: { authFailure?: boolean } = {}): Promise<void> {
    if (ok) {
      this.operatorAlerted.delete(mailboxId);
      if (this.alerted.delete(mailboxId)) {
        this.log.info({ mailboxId }, 'Principal mailbox recovered');
      }
      return;
    }

    // The principal's alert is one per episode. The operator's copy is retried separately, so a
    // probe after a failed operator send still tries it without repeating the principal's.
    // Nothing can deliver a notice yet: stop before minting a single-use sign-in link that would
    // be discarded, and before writing an undelivered audit row on every failing probe (#2710).
    // The gateway checks again on the way out; this is the cheap pre-check.
    if (!this.deps.gateway.canDeliverNotifications()) {
      this.log.warn({ mailboxId }, 'Principal mailbox is failing but no email adapter delivers alerts yet; will alert on a later probe');
      return;
    }

    if (this.alerted.has(mailboxId)) {
      if (!this.operatorAlerted.has(mailboxId)) await this.notifyOperatorOfOutage(mailboxId, label, true);
      return;
    }

    // A mint failure must never stop the alert: any problem, a stall included, falls back to the
    // grant-paste wording. A mint that finishes after the deadline leaves an unused link that expires.
    let reconnectLink: string | null = null;
    if (opts.authFailure && this.deps.mintReconnectLink) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new MintTimeoutError()), this.deps.mintTimeoutMs ?? MINT_RECONNECT_LINK_TIMEOUT_MS);
        });
        const mint = this.deps.mintReconnectLink(mailboxId, label);
        // A late rejection after the deadline won is already handled here, never unhandled.
        mint.catch(() => undefined);
        reconnectLink = await Promise.race([mint, deadline]);
      } catch (err) {
        // Error name only: the message could carry a token or address.
        this.log.warn({ mailboxId, errorName: err instanceof Error ? err.name : 'UnknownError' }, 'Could not mint a reconnect link for the outage alert; sending the grant-paste wording');
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    const sent = await this.deps.gateway.sendNotification({
      notificationType: 'principal_mailbox_outage',
      subject: `Curia cannot reach your "${label}" mailbox`,
      body: [
        `Curia's health check for your "${label}" mailbox failed.`,
        '',
        'Mail and calendar for that account are not being read or written until it is reachable again.',
        ...(opts.authFailure
          ? [
            ...(reconnectLink
              ? [
                'Nylas refused the connection, which usually means the sign-in was revoked or expired. Sign in again with this link (valid for 7 days, works once):',
                reconnectLink,
              ]
              : [
                "Nylas refused the connection, which usually means it was revoked or expired: reconnect the account in Nylas, then use Edit on the mailbox to paste its new grant ID in the console (Settings → Behaviour → Email & Calendar).",
              ]),
            'If the account no longer exists, remove the mailbox there so Curia stops checking it.',
          ]
          : [
            'Nylas did not answer in time or reported an error of its own. This is often temporary: check the Nylas status page, and that the Nylas API key in the console is still valid.',
          ]),
        '',
        'You will not get another alert for this mailbox until it has recovered and failed again.',
      ].join('\n'),
    });
    if (!sent) {
      this.log.error({ mailboxId }, 'Principal mailbox outage: alert could not be sent; will retry on the next failing probe');
    } else {
      this.alerted.add(mailboxId);
      this.log.error({ mailboxId }, 'Principal mailbox outage: alert sent');
    }
    // The operator hears the same outage without the link: only the principal can sign in to
    // their own mailbox. Sent whether or not the principal's alert went out (#2710 review): a
    // refused principal alert must not keep the operator from hearing about it too.
    await this.notifyOperatorOfOutage(mailboxId, label, sent);
  }

  /**
   * The operator's copy of an outage, sent once per episode when an operator is set. Only the
   * mailbox's label is named — never its address, and never the reconnect link, which only the
   * principal can use. A failed send is left unrecorded so the next failing probe retries it;
   * the gateway logs it at error level and audits it.
   */
  private async notifyOperatorOfOutage(mailboxId: string, label: string, principalTold: boolean): Promise<void> {
    if (this.operatorAlerted.has(mailboxId)) return;
    if (!this.deps.gateway.canDeliverNotifications()) return;
    // The dependency contract is "never throws" (createOperatorEmailLookup answers false rather
    // than throwing), so a read failure has already been handled where it happened.
    if (!this.deps.hasOperator || !(await this.deps.hasOperator())) return;

    const sent = await this.deps.gateway.sendNotification({
      notificationType: 'mailbox_outage',
      subject: `Curia cannot reach the principal's "${label}" mailbox`,
      body: [
        `Curia's health check for the principal's "${label}" mailbox is failing.`,
        '',
        'Mail and calendar for that account are not being read or written until it is reachable again.',
        principalTold
          ? 'Curia has already told the mailbox owner; nothing here needs you.'
          : 'Curia could not send the mailbox owner their alert yet and will keep trying. Only they can sign in to their mailbox again.',
        '',
        'You will not get another notice for this mailbox until it has recovered and failed again.',
      ].join('\n'),
    });
    if (sent) {
      this.operatorAlerted.add(mailboxId);
      return;
    }
    this.log.error(
      { mailboxId },
      'Principal mailbox outage: the operator notice could not be sent; retrying on the next failing probe',
    );
  }
}
