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

export type ApprovalChannel = 'signal' | 'sms' | 'slack' | 'email';

/** Preference order when listing what is available. The agent still chooses. */
export const APPROVAL_CHANNELS: readonly ApprovalChannel[] = ['signal', 'sms', 'slack', 'email'];

export type DeliverResult =
  | { delivered: true; channel: ApprovalChannel }
  | {
    delivered: false;
    reason: 'not_found' | 'already_delivered' | 'channel_unavailable' | 'send_failed';
    available: ApprovalChannel[];
  };

/** What the principal is shown for an approval, as the raise site saw it. */
export interface ApprovalDisplay {
  preamble: string;
  payload: Record<string, unknown>;
  extraLines?: string[];
}

export interface ApprovalDeliveryDeps {
  actionLogRepo: Pick<ActionLogRepo, 'findPendingByShortRef' | 'claimNotification' | 'releaseNotification' | 'bindDeliveryMessage'>;
  outboundGateway: Pick<OutboundGateway, 'send'>;
  /** The shared array index.ts refreshes when the principal's identities change. */
  principalIdentities: readonly ChannelIdentity[];
  /** Live ref, so a post-boot email bind takes effect (#1514). */
  principalEmail: string | PrincipalEmailRef;
  logger: Logger;
}

// Approvals live 24–48h; anything older than this many registrations has long since been
// delivered or expired. Bounds memory without a timer.
const MAX_DISPLAYS = 500;

const REACT_CTA = 'React 👍 to approve or 👎 to deny this request.';
const REPLY_CTA = 'Reply approve or deny, with the reference.';

export class ApprovalDelivery {
  private readonly displays = new Map<string, ApprovalDisplay>();
  /** Channels that already failed per approval, so they are not offered again (bounded like displays). */
  private readonly failedChannels = new Map<string, Set<ApprovalChannel>>();

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
  availableChannels(): ApprovalChannel[] {
    return APPROVAL_CHANNELS.filter((channel) => this.recipientFor(channel) !== null);
  }

  /** Send one pending approval on one channel. Never throws. */
  async deliver(shortRef: string, channel: ApprovalChannel): Promise<DeliverResult> {
    const { actionLogRepo, logger } = this.deps;
    const failed = this.failedChannels.get(shortRef);
    const available = this.availableChannels().filter((c) => !failed?.has(c));

    const row = await actionLogRepo.findPendingByShortRef(shortRef);
    if (!row) return { delivered: false, reason: 'not_found', available };
    if (row.notificationSentAt) return { delivered: false, reason: 'already_delivered', available };

    const recipient = this.recipientFor(channel);
    if (recipient === null) return { delivered: false, reason: 'channel_unavailable', available };

    // Build before claiming: a payload the renderer chokes on must not leave a claim behind,
    // which would make the row look delivered to the safety net forever.
    let request: OutboundSendRequest;
    try {
      request = this.buildRequest(row, channel, recipient);
    } catch (err) {
      logger.error({ err, rowId: row.id, shortRef, channel }, 'approval-delivery: could not build the approval message');
      return { delivered: false, reason: 'send_failed', available: available.filter((c) => c !== channel) };
    }

    // Claim before sending: of two concurrent callers, exactly one gets to ping.
    if (!(await actionLogRepo.claimNotification(row.id))) {
      return { delivered: false, reason: 'already_delivered', available };
    }

    let messageId: string | undefined;
    let queued = false;
    let failure: string | undefined;
    try {
      // isSystemNotification: an approval must reach the principal even below the send
      // threshold it is asking about. skipNotificationOnBlock: a blocked approval must not
      // report itself.
      const result = await this.deps.outboundGateway.send(request, { isSystemNotification: true, skipNotificationOnBlock: true });
      if (result.success) {
        messageId = result.messageId;
        // Durably queued while the transport is down (#1380): it goes out on reconnect, so
        // the claim stands. messageId is then a queue row id, not the provider's, so it is
        // not bound; the reaction mapper binds the real message from its "Reference:" line
        // when it is actually delivered.
        queued = result.queued === true;
      } else {
        failure = result.blockedReason ?? 'send failed';
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }

    if (failure !== undefined) {
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

    // A reaction on the delivered message resolves the approval (#1479). Email is answered
    // by reply, so it has nothing to bind.
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

  private recipientFor(channel: ApprovalChannel): string | null {
    if (channel === 'email') {
      const email = resolvePrincipalEmail(this.deps.principalEmail);
      if (email) return email;
    }
    const identity = this.deps.principalIdentities.find(
      (id) => id.channel === channel && id.verified && id.status === 'active',
    );
    return identity?.channelIdentifier ?? null;
  }

  private buildRequest(row: ActionLogRow, channel: ApprovalChannel, recipient: string): OutboundSendRequest {
    const registered = row.shortRef ? this.displays.get(row.shortRef) : undefined;
    if (!registered) {
      // After a restart (or eviction) the raise-time display is gone; the stored payload may
      // show contact references rather than names (#2033). The description still names who.
      this.deps.logger.debug({ rowId: row.id }, 'approval-delivery: no registered display — rendering the stored payload');
    }
    const display = registered ?? {
      preamble: row.description ?? `Curia wants to run ${row.toolName}.`,
      payload: row.payload ?? {},
    };
    const body = buildApprovalNotificationBody({
      preamble: display.preamble,
      shortRef: row.shortRef ?? String(row.id),
      expiresAt: row.expiresAt ?? new Date(),
      toolName: row.toolName,
      payload: display.payload,
      // Every channel here is one of the principal's own verified identities.
      recipientTier: 'principal',
      ...(display.extraLines ? { extraLines: display.extraLines } : {}),
      callToAction: channel === 'signal' || channel === 'slack' ? REACT_CTA : REPLY_CTA,
      logger: this.deps.logger,
    });
    switch (channel) {
      case 'email':
        return { channel: 'email', to: recipient, subject: `Approval needed — ${row.description ?? row.toolName}`, body };
      case 'slack':
        // chat.postMessage accepts a user id (U…) as the channel and opens a DM.
        return { channel: 'slack', slackChannelId: recipient, slackUserId: recipient, message: body };
      case 'sms':
        return { channel: 'sms', recipient, message: body };
      case 'signal':
        return { channel: 'signal', recipient, message: body };
    }
  }
}
