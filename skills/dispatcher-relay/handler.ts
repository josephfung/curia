// handler.ts — dispatcher-relay skill.
//
// Re-publishes a Gate C–withheld auto-reply as outbound.message after the CEO
// approves via approve-action (#1733). Invoked only with humanApproved: true —
// allowed_callers is ["system"] so agents cannot call it directly.
//
// Publishes as the dispatch layer so channel adapters (email, Signal, HTTP
// EventRouter, etc.) receive the same event shape as handleAgentResponse.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import { createOutboundMessage } from '../../src/bus/events.js';

const MAX_BODY_LENGTH = 50_000;

export class DispatcherRelayHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.bus) {
      return { success: false, error: 'dispatcher-relay requires bus (capabilities: ["bus"])' };
    }

    const { channelId, to, body, conversationId, accountId } = ctx.input as {
      channelId?: string;
      to?: string;
      body?: string;
      conversationId?: string;
      accountId?: string;
    };

    if (!channelId || typeof channelId !== 'string') {
      return { success: false, error: 'Missing required input: channelId (string)' };
    }
    if (!to || typeof to !== 'string') {
      return { success: false, error: 'Missing required input: to (string)' };
    }
    if (!body || typeof body !== 'string') {
      return { success: false, error: 'Missing required input: body (string)' };
    }
    if (!conversationId || typeof conversationId !== 'string') {
      return { success: false, error: 'Missing required input: conversationId (string)' };
    }
    if (body.length > MAX_BODY_LENGTH) {
      return { success: false, error: `body must be ${MAX_BODY_LENGTH} characters or fewer` };
    }
    if (!ctx.taskEventId || typeof ctx.taskEventId !== 'string') {
      return { success: false, error: 'Missing required context: taskEventId (string)' };
    }

    const outbound = createOutboundMessage({
      conversationId,
      channelId,
      accountId,
      content: body,
      recipientId: to,
      taskEventId: ctx.taskEventId,
      parentEventId: ctx.taskEventId,
    });

    try {
      await ctx.bus.publish('dispatch', outbound);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, channelId, conversationId }, 'dispatcher-relay: failed to publish outbound.message');
      return { success: false, error: `Failed to publish outbound.message: ${message}` };
    }

    ctx.log.info(
      { channelId, conversationId, outboundEventId: outbound.id },
      'dispatcher-relay: published approved relay as outbound.message',
    );

    return {
      success: true,
      data: { delivered: true, outboundEventId: outbound.id, to },
    };
  }
}
