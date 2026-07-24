// approval-channel-notify.ts — deliver approval requests on Slack/Signal (#1479).
//
// Email notifications remain the primary alert path (outbound.notification).
// When the principal has verified Slack/Signal identities, also DM them so a
// 👍/👎 reaction can resolve the pending approval via targetMessageId correlation.

import type { ChannelIdentity } from '../contacts/types.js';
import type { Logger } from '../logger.js';
import type { OutboundGateway } from '../skills/outbound-gateway.js';
import type { ActionLogRepo } from './action-log-repo.js';

export interface ApprovalChannelNotifyOpts {
  outboundGateway: OutboundGateway;
  actionLogRepo: ActionLogRepo;
  actionLogId: number;
  body: string;
  principalIdentities: readonly ChannelIdentity[];
  logger: Logger;
}

/**
 * Best-effort Slack + Signal DMs for a pending approval. Binds each successful
 * delivery's provider message id so inbound.reaction can correlate.
 * Failures are logged and never thrown — email notify is independent.
 */
export async function deliverApprovalToChatChannels(
  opts: ApprovalChannelNotifyOpts,
): Promise<{ signal: boolean; slack: boolean }> {
  const { outboundGateway, actionLogRepo, actionLogId, body, principalIdentities, logger } = opts;
  let signal = false;
  let slack = false;

  const signalId = principalIdentities.find(
    (id) => id.channel === 'signal' && id.verified && id.status === 'active',
  )?.channelIdentifier;

  if (signalId) {
    try {
      const result = await outboundGateway.send(
        { channel: 'signal', recipient: signalId, message: body },
        { isSystemNotification: true },
      );
      if (result.success && result.messageId) {
        await actionLogRepo.bindDeliveryMessage(actionLogId, 'signal', result.messageId);
        signal = true;
        logger.info(
          { actionLogId, messageId: result.messageId },
          'approval-channel-notify: Signal approval DM delivered and bound',
        );
      } else if (result.success && !result.messageId) {
        logger.warn(
          { actionLogId },
          'approval-channel-notify: Signal DM sent but messageId missing — reaction correlation unavailable',
        );
      } else {
        logger.warn(
          { actionLogId, blockedReason: result.blockedReason },
          'approval-channel-notify: Signal approval DM failed',
        );
      }
    } catch (err) {
      logger.warn({ err, actionLogId }, 'approval-channel-notify: Signal approval DM threw');
    }
  }

  const slackUserId = principalIdentities.find(
    (id) => id.channel === 'slack' && id.verified && id.status === 'active',
  )?.channelIdentifier;

  if (slackUserId) {
    try {
      // chat.postMessage accepts a user id (U…) as channel and opens a DM.
      const result = await outboundGateway.send(
        {
          channel: 'slack',
          slackChannelId: slackUserId,
          slackUserId,
          message: body,
        },
        { isSystemNotification: true },
      );
      if (result.success && result.messageId) {
        await actionLogRepo.bindDeliveryMessage(actionLogId, 'slack', result.messageId);
        slack = true;
        logger.info(
          { actionLogId, messageId: result.messageId },
          'approval-channel-notify: Slack approval DM delivered and bound',
        );
      } else if (result.success && !result.messageId) {
        logger.warn(
          { actionLogId },
          'approval-channel-notify: Slack DM sent but messageId missing — reaction correlation unavailable',
        );
      } else {
        logger.warn(
          { actionLogId, blockedReason: result.blockedReason },
          'approval-channel-notify: Slack approval DM failed',
        );
      }
    } catch (err) {
      logger.warn({ err, actionLogId }, 'approval-channel-notify: Slack approval DM threw');
    }
  }

  return { signal, slack };
}
