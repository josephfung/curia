// approval-delivery.ts — send one pending approval on one channel (#2159).
//
// Approvals used to fan out from code: an email plus a Signal and a Slack DM for every
// request, about twenty principal-bound messages in a day and a half on one busy thread.
// Now the agent that owns the turn chooses ONE channel from the principal's standing
// preferences and calls deliver-approval, which lands here. Raise sites only create the row.
//
// One ping per approval. The row's notification_sent_at is claimed atomically before the
// send, so two callers (an agent and the expiry sweep's safety net, or a retry loop) cannot
// both deliver. A failed send releases the claim, so the agent can try its next channel and
// the safety net can still reach the principal.
//
// SMS is not an approval channel (GHSA-p49r-jqh2-v668): SMS does not authenticate the sender, so
// a texted "approve 3" cannot approve anything, and an approval sent there could not be answered
// there. An approval raised on an unauthenticated principal turn (`requesterUnverified`) goes only
// to Signal, Slack or the phone app, at most UNVERIFIED_CAP_PER_HOUR an hour, so a spoofer cannot
// flood the principal's verified channels; past the cap it waits in the digest.
//
// The principal sees the display the raise site had — contact references resolved to names
// (#2033) — registered here in memory at raise time. After a restart the registration is
// gone and the stored row payload is rendered instead; the description line still names
// who and what.

import type { ActionLogRepo } from './action-log-repo.js';
import type { ActionLogRow } from './action-log-types.js';
import type { OutboundGateway, OutboundSendRequest } from '../skills/outbound-gateway.js';
import { resolvePrincipalEmail, type ChannelIdentity, type PrincipalEmailRef } from '../contacts/types.js';
import type { Logger } from '../logger.js';
import { buildApprovalNotificationBody } from './approval-notification.js';
import { askPreamble } from './disclosure-decisions.js';

export type ApprovalChannel = 'signal' | 'web' | 'slack' | 'email';

/** Preference order when listing what is available. The agent still chooses. */
export const APPROVAL_CHANNELS: readonly ApprovalChannel[] = ['signal', 'web', 'slack', 'email'];

/** Channels that prove the principal is the one answering: the only ones an unverified request may use. */
export const VERIFIED_APPROVAL_CHANNELS: readonly ApprovalChannel[] = ['signal', 'web', 'slack'];

/** Unverified-request approvals sent (delivered or re-sent) per rolling hour before the rest wait in the digest. */
export const UNVERIFIED_CAP_PER_HOUR = 3;
const HOUR_MS = 60 * 60 * 1000;

/** The unverified channel a principal-matching message arrived on, for wording only. */
export type UnverifiedChannel = 'sms' | 'email';

export type DeliverResult =
  | { delivered: true; channel: ApprovalChannel }
  | {
    delivered: false;
    /**
     * `verified_channel_required`: an unverified request asked for a channel that does not
     * prove the principal (email); `available` lists the verified ones. `rate_limited`: the
     * hourly cap for unverified requests is used up; it waits in the digest.
     */
    reason: 'not_found' | 'already_delivered' | 'channel_unavailable' | 'send_failed' | 'verified_channel_required' | 'rate_limited';
    available: ApprovalChannel[];
  };

/** What the principal is shown for an approval, as the raise site saw it. */
export interface ApprovalDisplay {
  preamble: string;
  payload: Record<string, unknown>;
  extraLines?: string[];
  /**
   * The approval number the raise site read back after its insert (#2159 Phase 3), null when
   * it has none. The number SHOWN is always the row's own (it is what "approve 3" resolves
   * against); this one is only checked against it.
   */
  approvalNumber?: number | null;
}

export interface ApprovalDeliveryDeps {
  actionLogRepo: Pick<ActionLogRepo, 'findPendingByShortRef' | 'findPendingByApprovalNumber' | 'claimNotification' | 'releaseNotification' | 'bindDeliveryMessage'>;
  outboundGateway: Pick<OutboundGateway, 'send'>;
  /** The shared array index.ts refreshes when the principal's identities change. */
  principalIdentities: readonly ChannelIdentity[];
  /** Live ref, so a post-boot email bind takes effect (#1514). */
  principalEmail: string | PrincipalEmailRef;
  logger: Logger;
  /** The phone app can take an approval when a device is subscribed or the chat is open. */
  webReachable?: () => boolean | Promise<boolean>;
}

// Approvals live 24–48h; anything older than this many registrations has long since been
// delivered or expired. Bounds memory without a timer.
const MAX_DISPLAYS = 500;

const REACT_CTA = 'React 👍 to approve or 👎 to deny this request.';

/** Leads every unverified-request approval, whoever raised it. */
export const UNVERIFIED_REQUEST_NOTE =
  'This request came from a message that matches your phone number or email address, but that channel can\'t prove you sent it. ' +
  'Approve only if it was you. If it wasn\'t, deny it: someone may be impersonating you.';

/** Sent once per window when the cap holds an unverified request back. */
export const UNVERIFIED_CAP_NOTICE =
  'More requests that claim to come from you, from a phone number or email address that can\'t be verified, are waiting. ' +
  'They are listed in the console and your next digest; none will be sent here for the rest of the hour.';

function redeliverPreamble(ref: string, answeredOn: UnverifiedChannel): string {
  const via = answeredOn === 'sms' ? 'SMS number' : 'email address';
  return `Someone answered approval ${ref} from your ${via}, which can't be verified. If that was you, approve it here.`;
}
// For approvals without a number (raised before migration 098, or when all 999 were in use).
const REPLY_CTA = 'Reply approve or deny, with the reference.';

/** What to reply to a numbered approval (#2159 Phase 3): the principal types the number. */
function replyByNumberCta(approvalNumber: number): string {
  return `Reply "approve ${approvalNumber}" or "deny ${approvalNumber}".`;
}

export class ApprovalDelivery {
  private readonly displays = new Map<string, ApprovalDisplay>();
  /** Channels that already failed per approval, so they are not offered again (bounded like displays). */
  private readonly failedChannels = new Map<string, Set<ApprovalChannel>>();
  /** When each unverified-request approval went out in the last hour, oldest first. In memory: a restart allows one more batch. */
  private unverifiedSentAt: number[] = [];
  /** When the cap notice last went out, so it goes once per window. */
  private capNoticeAt: number | null = null;

  constructor(private readonly deps: ApprovalDeliveryDeps) {}

  /** Remember what the principal should be shown for `shortRef`. Called by raise sites. */
  registerDisplay(shortRef: string, display: ApprovalDisplay): void {
    if (this.displays.size >= MAX_DISPLAYS) {
      // Maps iterate in insertion order: drop the oldest.
      const oldest = this.displays.keys().next().value;
      if (oldest !== undefined) this.displays.delete(oldest);
    }
    this.displays.set(shortRef, display);
  }

  /** Channels the principal has a verified, active identity on, in APPROVAL_CHANNELS order. */
  async availableChannels(): Promise<ApprovalChannel[]> {
    return [...(await this.resolveRecipients()).keys()];
  }

  /** Send one pending approval on one channel. Never throws. */
  async deliver(shortRef: string, channel: ApprovalChannel): Promise<DeliverResult> {
    const { actionLogRepo, logger } = this.deps;
    const failed = this.failedChannels.get(shortRef);
    // One lookup per delivery: `web` reachability is a live query, so it is not repeated
    // for the chosen channel, and not cached across deliveries either.
    const recipients = await this.resolveRecipients();
    const available = [...recipients.keys()].filter((c) => !failed?.has(c));

    const row = await actionLogRepo.findPendingByShortRef(shortRef);
    if (!row) return { delivered: false, reason: 'not_found', available };
    if (row.notificationSentAt) return { delivered: false, reason: 'already_delivered', available };

    const unverified = row.requesterUnverified === true;
    if (unverified && !VERIFIED_APPROVAL_CHANNELS.includes(channel)) {
      return { delivered: false, reason: 'verified_channel_required', available: available.filter((c) => VERIFIED_APPROVAL_CHANNELS.includes(c)) };
    }

    const recipient = recipients.get(channel) ?? null;
    if (recipient === null) {
      return { delivered: false, reason: 'channel_unavailable', available: unverified ? available.filter((c) => VERIFIED_APPROVAL_CHANNELS.includes(c)) : available };
    }
    if (unverified && !(await this.takeUnverifiedSlot(channel, recipient, row.id))) {
      return { delivered: false, reason: 'rate_limited', available: [] };
    }

    // Build before claiming: a payload the renderer chokes on must not leave a claim behind,
    // which would make the row look delivered to the safety net forever.
    let request: OutboundSendRequest;
    try {
      request = this.buildRequest(row, channel, recipient);
    } catch (err) {
      logger.error({ err, rowId: row.id, shortRef, channel }, 'approval-delivery: could not build the approval message');
      if (unverified) this.unverifiedSentAt.pop();
      return { delivered: false, reason: 'send_failed', available: available.filter((c) => c !== channel) };
    }

    // Claim before sending: of two concurrent callers, exactly one gets to ping.
    if (!(await actionLogRepo.claimNotification(row.id))) {
      if (unverified) this.unverifiedSentAt.pop();
      return { delivered: false, reason: 'already_delivered', available };
    }

    let messageId: string | undefined;
    let threadId: string | undefined;
    let queued = false;
    let failure: string | undefined;
    try {
      // isSystemNotification: an approval must reach the principal even below the send
      // threshold it is asking about. skipNotificationOnBlock: a blocked approval must not
      // report itself.
      const result = await this.deps.outboundGateway.send(request, { isSystemNotification: true, skipNotificationOnBlock: true });
      if (result.success) {
        messageId = result.messageId;
        threadId = result.threadId;
        // Durably queued while the transport is down (#1380): it goes out on reconnect, so
        // the claim stands. messageId is then a queue row id, not the provider's, so it is
        // not bound; the reaction mapper binds the real message from its "Approval <n>" (or,
        // unnumbered, "Reference:") line when it is actually delivered.
        queued = result.queued === true;
      } else {
        failure = result.blockedReason ?? 'send failed';
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }

    if (failure !== undefined) {
      if (unverified) this.unverifiedSentAt.pop();
      await this.release(row.id);
      const remaining = this.markFailed(shortRef, channel, available);
      if (remaining.length === 0) {
        // The safety net will still retry, but every channel the agent could use has failed.
        logger.error({ rowId: row.id, shortRef, channel, failure }, 'approval-delivery: every channel failed for this approval');
      } else {
        logger.warn({ rowId: row.id, shortRef, channel, failure }, 'approval-delivery: send failed — claim released');
      }
      return { delivered: false, reason: 'send_failed', available: remaining };
    }

    // A principal's reply on the approval email's thread is marked as answering it (#2333).
    if (threadId && !queued && channel === 'email') {
      try {
        await actionLogRepo.bindDeliveryMessage(row.id, 'email-thread', threadId);
      } catch (err) {
        logger.warn({ err, rowId: row.id }, 'approval-delivery: delivered, but the email thread binding failed — a reply is not marked as answering it');
      }
    }
    // A reaction on the delivered message resolves the approval (#1479). Email is answered
    // by reply, so it has no message to bind.
    if (messageId && !queued && (channel === 'signal' || channel === 'slack')) {
      try {
        await actionLogRepo.bindDeliveryMessage(row.id, channel, messageId);
      } catch (err) {
        logger.warn({ err, rowId: row.id, channel }, 'approval-delivery: delivered, but the reaction binding failed — a reply still works');
      }
    }
    logger.info({ rowId: row.id, shortRef, channel, queued }, queued ? 'approval-delivery: queued until the channel reconnects' : 'approval-delivery: delivered');
    return { delivered: true, channel };
  }

  /**
   * Send a pending approval again, on the first verified channel, because someone answered it
   * ("approve 3") from a channel that cannot prove it was the principal (GHSA-p49r-jqh2-v668).
   * It does not claim the row (it was usually delivered already) and counts against the hourly
   * cap. `ref` is the approval number or short reference as the answer gave it. Never throws.
   */
  async redeliverForVerification(ref: string, answeredOn: UnverifiedChannel): Promise<DeliverResult> {
    const { actionLogRepo, logger } = this.deps;
    try {
      const trimmed = ref.trim();
      const row = /^\d{1,3}$/.test(trimmed)
        ? await actionLogRepo.findPendingByApprovalNumber(Number(trimmed))
        : await actionLogRepo.findPendingByShortRef(trimmed);
      const recipients = await this.resolveRecipients();
      const verified = [...recipients.keys()].filter((c) => VERIFIED_APPROVAL_CHANNELS.includes(c));
      if (!row) return { delivered: false, reason: 'not_found', available: verified };
      const channel = verified[0];
      if (channel === undefined) return { delivered: false, reason: 'verified_channel_required', available: [] };
      const recipient = recipients.get(channel)!;
      if (!(await this.takeUnverifiedSlot(channel, recipient, row.id))) return { delivered: false, reason: 'rate_limited', available: [] };

      const shown = row.approvalNumber != null ? String(row.approvalNumber) : (row.shortRef ?? String(row.id));
      const request = this.buildRequest(row, channel, recipient, redeliverPreamble(shown, answeredOn));
      const result = await this.deps.outboundGateway.send(request, { isSystemNotification: true, skipNotificationOnBlock: true });
      if (!result.success) {
        this.unverifiedSentAt.pop();
        logger.warn({ rowId: row.id, channel, failure: result.blockedReason }, 'approval-delivery: re-send for verification failed');
        return { delivered: false, reason: 'send_failed', available: verified.filter((c) => c !== channel) };
      }
      if (result.messageId && result.queued !== true && (channel === 'signal' || channel === 'slack')) {
        try {
          await actionLogRepo.bindDeliveryMessage(row.id, channel, result.messageId);
        } catch (err) {
          logger.warn({ err, rowId: row.id, channel }, 'approval-delivery: re-sent, but the reaction binding failed — a reply still works');
        }
      }
      logger.info({ rowId: row.id, channel, answeredOn }, 'approval-delivery: re-sent for verification after an unverified answer');
      return { delivered: true, channel };
    } catch (err) {
      logger.error({ err, answeredOn }, 'approval-delivery: re-send for verification failed');
      return { delivered: false, reason: 'send_failed', available: [] };
    }
  }

  /**
   * Take one of the hour's unverified-request slots. When none is left, send the cap notice on
   * this verified channel once per window and return false. The caller gives the slot back
   * (pops it) when its send fails.
   */
  private async takeUnverifiedSlot(channel: ApprovalChannel, recipient: string, rowId: number): Promise<boolean> {
    const now = Date.now();
    this.unverifiedSentAt = this.unverifiedSentAt.filter((t) => now - t < HOUR_MS);
    if (this.unverifiedSentAt.length < UNVERIFIED_CAP_PER_HOUR) {
      this.unverifiedSentAt.push(now);
      return true;
    }
    this.deps.logger.warn({ rowId, channel }, 'approval-delivery: hourly cap for unverified requests reached — left for the digest');
    if (this.capNoticeAt !== null && now - this.capNoticeAt < HOUR_MS) return false;
    this.capNoticeAt = now;
    try {
      const result = await this.deps.outboundGateway.send(
        this.plainRequest(channel, recipient, UNVERIFIED_CAP_NOTICE),
        { isSystemNotification: true, skipNotificationOnBlock: true },
      );
      if (!result.success) this.deps.logger.warn({ channel, failure: result.blockedReason }, 'approval-delivery: cap notice not sent');
    } catch (err) {
      this.deps.logger.warn({ err, channel }, 'approval-delivery: cap notice not sent');
    }
    return false;
  }

  /** Remember a failed channel for this approval; returns the channels still worth trying. */
  private markFailed(shortRef: string, channel: ApprovalChannel, available: ApprovalChannel[]): ApprovalChannel[] {
    let failed = this.failedChannels.get(shortRef);
    if (!failed) {
      if (this.failedChannels.size >= MAX_DISPLAYS) {
        const oldest = this.failedChannels.keys().next().value;
        if (oldest !== undefined) this.failedChannels.delete(oldest);
      }
      failed = new Set();
      this.failedChannels.set(shortRef, failed);
    }
    failed.add(channel);
    return available.filter((c) => !failed.has(c));
  }

  private async release(rowId: number): Promise<void> {
    try {
      await this.deps.actionLogRepo.releaseNotification(rowId);
    } catch (err) {
      // The row now looks delivered when it was not: nothing else will retry it.
      this.deps.logger.error({ err, rowId }, 'approval-delivery: could not release the claim after a failed send — the approval will not be retried');
    }
  }

  /** Each channel with a recipient right now, in APPROVAL_CHANNELS order. */
  private async resolveRecipients(): Promise<Map<ApprovalChannel, string>> {
    const recipients = new Map<ApprovalChannel, string>();
    for (const channel of APPROVAL_CHANNELS) {
      const recipient = await this.recipientFor(channel);
      if (recipient !== null) recipients.set(channel, recipient);
    }
    return recipients;
  }

  private async recipientFor(channel: ApprovalChannel): Promise<string | null> {
    if (channel === 'web') return (await this.deps.webReachable?.()) ? 'principal' : null;
    if (channel === 'email') {
      const email = resolvePrincipalEmail(this.deps.principalEmail);
      if (email) return email;
    }
    const identity = this.deps.principalIdentities.find(
      (id) => id.channel === channel && id.verified && id.status === 'active',
    );
    return identity?.channelIdentifier ?? null;
  }

  private buildRequest(row: ActionLogRow, channel: ApprovalChannel, recipient: string, lead?: string): OutboundSendRequest {
    const registered = row.shortRef ? this.displays.get(row.shortRef) : undefined;
    if (!registered) {
      // After a restart (or eviction) the raise-time display is gone; the stored payload may
      // show contact references rather than names (#2033). The description still names who.
      this.deps.logger.debug({ rowId: row.id }, 'approval-delivery: no registered display — rendering the stored payload');
    }
    const display = registered ?? {
      // A personal-data ask leads with its question (#2312), rebuilt from what the row stores.
      preamble: row.disclosureAsk ? askPreamble(row.disclosureAsk) : row.description ?? `Curia wants to run ${row.toolName}.`,
      payload: row.payload ?? {},
    };
    // The row's number, never the display's: "approve 3" resolves against the row, so showing
    // any other number could point the principal at a different approval. The two come from
    // the same row and should always agree; a mismatch means a bug upstream.
    const approvalNumber = row.approvalNumber;
    if (display.approvalNumber != null && display.approvalNumber !== approvalNumber) {
      this.deps.logger.error(
        { rowId: row.id, shortRef: row.shortRef, rowNumber: approvalNumber, displayNumber: display.approvalNumber },
        'approval-delivery: registered approval number disagrees with the row — showing the row\'s',
      );
    }
    const reactable = channel === 'signal' || channel === 'slack';
    const leads = [lead, row.requesterUnverified === true ? UNVERIFIED_REQUEST_NOTE : undefined].filter((l): l is string => l !== undefined);
    const body = buildApprovalNotificationBody({
      preamble: [...leads, display.preamble].join('\n\n'),
      shortRef: row.shortRef ?? String(row.id),
      approvalNumber,
      expiresAt: row.expiresAt ?? new Date(),
      toolName: row.toolName,
      payload: display.payload,
      // Every channel here is one of the principal's own verified identities.
      recipientTier: 'principal',
      ...(display.extraLines ? { extraLines: display.extraLines } : {}),
      callToAction: reactable ? REACT_CTA : approvalNumber != null ? replyByNumberCta(approvalNumber) : REPLY_CTA,
      logger: this.deps.logger,
    });
    if (channel === 'email') {
      return { channel: 'email', to: recipient, subject: `Approval needed — ${row.description ?? row.toolName}`, body };
    }
    return this.plainRequest(channel, recipient, body);
  }

  /** A plain message to the principal on an approval channel. */
  private plainRequest(channel: ApprovalChannel, recipient: string, message: string): OutboundSendRequest {
    switch (channel) {
      case 'email':
        return { channel: 'email', to: recipient, subject: 'A note from Curia', body: message };
      case 'slack':
        // chat.postMessage accepts a user id (U…) as the channel and opens a DM.
        return { channel: 'slack', slackChannelId: recipient, slackUserId: recipient, message };
      case 'signal':
        return { channel: 'signal', recipient, message };
      case 'web':
        return { channel: 'web', recipient: 'principal', message };
    }
  }
}
