// handler.ts — sms-send skill implementation.
//
// Sends a 1:1 SMS via OutboundGateway → Telnyx. The gateway enforces content
// filter, blocked-contact, autonomy, and STOP/opt-out checks.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import { registerOutboundContext } from '../../src/dispatch/context-bridge-parse.js';
import { boundTaskFromMetadata } from '../../src/agents/resumable-task.js';

const MAX_MESSAGE_LENGTH = 1600;
const E164_REGEX = /^\+[1-9]\d{6,14}$/;

export class SmsSendHandler implements ToolHandler {
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
      return { success: false, error: 'Missing required input: recipient (E.164 string)' };
    }

    if (!E164_REGEX.test(recipient)) {
      return {
        success: false,
        error: `recipient must be a valid E.164 phone number (e.g. +14155552671), got: ${recipient}`,
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
        error: 'sms-send skill requires outboundGateway access. Declare "outboundGateway" in capabilities.',
      };
    }

    ctx.log.info({ destinationType: '1:1' }, 'sms-send: dispatching SMS via gateway');

    try {
      const result = await ctx.outboundGateway.send(
        {
          channel: 'sms',
          recipient,
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
          error: result.blockedReason ?? 'SMS send failed',
        };
      }

      await registerOutboundContext(ctx.outboundContext, contextBridgeRaw, {
        channelId: 'sms',
        content: message,
        agentId: ctx.agentId ?? 'coordinator',
        log: ctx.log,
        boundTask: boundTaskFromMetadata(ctx.taskMetadata as Record<string, unknown> | undefined),
      });

      return {
        success: true,
        data: {
          delivered_to: recipient,
          channel: 'sms',
        },
      };
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, destinationType: '1:1' }, 'sms-send: gateway threw unexpectedly');
      return { success: false, error: `SMS send failed: ${errMessage}` };
    }
  }
}
