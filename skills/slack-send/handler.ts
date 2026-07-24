// handler.ts — slack-send skill implementation.
//
// Sends a 1:1 Slack DM via OutboundGateway → chat.postMessage. The gateway
// enforces content filter, blocked-contact, and autonomy. Pass the U… as both
// slackChannelId and slackUserId (Slack opens/uses the IM for a user id channel).

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import { registerOutboundContext } from '../../src/dispatch/context-bridge-parse.js';
import { boundTaskFromMetadata } from '../../src/agents/resumable-task.js';

/** Slack chat.postMessage hard limit. */
const MAX_MESSAGE_LENGTH = 40_000;
/** Slack user ids are U… (enterprise workspace users may be W… — out of scope for v1). */
const SLACK_USER_ID_REGEX = /^U[A-Z0-9]+$/i;

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
      // chat.postMessage accepts a user id (U…) as channel and opens a DM.
      // Set both fields so principal / blocked-contact checks use the peer U….
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
