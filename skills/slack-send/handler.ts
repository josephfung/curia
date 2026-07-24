// handler.ts — slack-send skill implementation.
//
// Sends a 1:1 Slack DM via OutboundGateway → chat.postMessage. The gateway
// enforces content filter, blocked-contact, and autonomy. Pass the U… as both
// slackChannelId and slackUserId (Slack opens/uses the IM for a user id channel).
//
// Out of scope for v1: Enterprise Grid workspace user ids (W…) — rejected by
// the recipient regex so Gate C / proactive DMs fail closed for those ids.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import { registerOutboundContext } from '../../src/dispatch/context-bridge-parse.js';
import { boundTaskFromMetadata } from '../../src/agents/resumable-task.js';

/** Slack chat.postMessage hard limit. */
const MAX_MESSAGE_LENGTH = 40_000;
/**
 * Standard Slack user ids are uppercase U…. Case-sensitive on purpose: a
 * lowercase `u…` would pass a case-insensitive check but miss exact-match
 * principal identity comparison. Enterprise Grid `W…` ids are out of scope.
 */
const SLACK_USER_ID_REGEX = /^U[A-Z0-9]+$/;

export class SlackSendHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const { recipient, message, context_bridge: contextBridgeRaw } = ctx.input as {
      recipient?: string;
      message?: string;
      context_bridge?: string;
    };

    if (!message || typeof message !== 'string') {
      return { success: false, error: 'Missing required input: message (string)' };
    }

    if (!recipient || typeof recipient !== 'string') {
      return { success: false, error: 'Missing required input: recipient (Slack user id U…)' };
    }

    if (!SLACK_USER_ID_REGEX.test(recipient)) {
      return {
        success: false,
        error: `recipient must be a Slack user id (e.g. U012ABCDEF), got: ${recipient}`,
      };
    }

    if (message.length > MAX_MESSAGE_LENGTH) {
      return {
        success: false,
        error: `message must be ${MAX_MESSAGE_LENGTH} characters or fewer (got ${message.length})`,
      };
    }

    if (!ctx.outboundGateway) {
      return {
        success: false,
        error: 'slack-send skill requires outboundGateway access. Declare "outboundGateway" in capabilities.',
      };
    }

    ctx.log.info({ destinationType: '1:1' }, 'slack-send: dispatching Slack DM via gateway');

    try {
      // Overload: put U… in slackChannelId even though that field's type doc
      // describes D…/C…/G… conversation ids. chat.postMessage accepts a user
      // id as channel and opens/uses the IM (same precedent as
      // approval-channel-notify.ts). Principal eligibility / blocked-contact
      // resolve from slackUserId (also the U…), never from slackChannelId alone.
      const result = await ctx.outboundGateway.send(
        {
          channel: 'slack',
          slackChannelId: recipient,
          slackUserId: recipient,
          message,
        },
        {
          taskEventId: ctx.taskEventId,
          conversationId: ctx.conversationId,
        },
      );

      if (!result.success) {
        return {
          success: false,
          error: result.blockedReason ?? 'Slack send failed',
        };
      }

      await registerOutboundContext(ctx.outboundContext, contextBridgeRaw, {
        channelId: 'slack',
        content: message,
        agentId: ctx.agentId ?? 'coordinator',
        log: ctx.log,
        boundTask: boundTaskFromMetadata(ctx.taskMetadata as Record<string, unknown> | undefined),
      });

      return {
        success: true,
        data: {
          delivered_to: recipient,
          channel: 'slack',
        },
      };
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, destinationType: '1:1' }, 'slack-send: gateway threw unexpectedly');
      return { success: false, error: `Slack send failed: ${errMessage}` };
    }
  }
}
