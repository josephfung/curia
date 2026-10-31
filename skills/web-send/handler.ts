// web-send — reach the principal on the phone app (#2341, ADR-055).
//
// Principal only. A dead subscription, a push setup error, or a push the
// service did not accept is sent onward by this handler, through the same
// gateway checks as the phone send. The order is the configured channels,
// with a standing preference's named channel first. No subscription is a
// failure and is not sent onward.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import type { OutboundGateway, OutboundSendRequest } from '../../src/skills/outbound-gateway.js';
import { isPrincipalDirectedSend, originatorOption, relayDeferredData, redactionData } from '../../src/skills/_shared/principal-directed.js';
import { FALLBACK_CHANNELS, type FallbackChannel } from '../../src/agents/principal-reach.js';

const MAX_MESSAGE_LENGTH = 4000;

const FALLBACK_REQUEST: Record<FallbackChannel, (identifier: string, message: string) => OutboundSendRequest> = {
  signal: (identifier, message) => ({ channel: 'signal', recipient: identifier, message }),
  sms: (identifier, message) => ({ channel: 'sms', recipient: identifier, message }),
  slack: (identifier, message) => ({ channel: 'slack', slackChannelId: identifier, slackUserId: identifier, message }),
  email: (identifier, message) => ({ channel: 'email', to: identifier, subject: 'Message from Curia', body: message }),
};

function sendOptions(ctx: ToolContext): NonNullable<Parameters<OutboundGateway['send']>[1]> {
  return {
    taskEventId: ctx.taskEventId,
    conversationId: ctx.conversationId,
    principalDirected: isPrincipalDirectedSend(ctx),
    ...originatorOption(ctx),
    humanApproved: ctx.humanApproved,
    holdRecipe: { toolName: 'web-send', partialPayload: ctx.input, description: 'Message on the phone app' },
  };
}

function fallbackOrder(gateway: OutboundGateway): readonly FallbackChannel[] {
  return typeof gateway.configuredFallbackChannels === 'function'
    ? gateway.configuredFallbackChannels()
    : FALLBACK_CHANNELS;
}

export class WebSendHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const { recipient, message } = ctx.input as { recipient?: unknown; message?: unknown };
    if (typeof message !== 'string' || message.trim().length === 0) {
      return { success: false, error: 'Missing required input: message (string)' };
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return { success: false, error: `message must be ${MAX_MESSAGE_LENGTH} characters or fewer (got ${message.length})` };
    }
    if (recipient !== 'principal') {
      return { success: false, error: 'web-send only reaches the principal. Pass recipient "principal".' };
    }
    if (!ctx.outboundGateway) {
      return { success: false, error: 'web-send requires outboundGateway access.' };
    }

    let result: Awaited<ReturnType<typeof ctx.outboundGateway.send>>;
    try {
      result = await ctx.outboundGateway.send(
        { channel: 'web', recipient: 'principal', message },
        sendOptions(ctx),
      );
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, 'web-send: gateway threw unexpectedly');
      return { success: false, error: `Phone app send failed: ${errMessage}` };
    }

    if (result.deferredToDigest) {
      return { success: true, data: { channel: 'web', ...relayDeferredData(result) } };
    }
    if (result.success) {
      return {
        success: true,
        data: { channel: 'web', ...redactionData(result) },
      };
    }
    if (result.webDelivery === 'unavailable' || result.webDelivery === 'unconfigured' || result.webDelivery !== 'fallback') {
      return { success: false, error: result.blockedReason ?? 'Phone app send failed' };
    }

    const notice = result.webDeliveryDetail ?? result.blockedReason ?? 'The phone could not be reached.';
    const options = sendOptions(ctx);
    for (const channel of fallbackOrder(ctx.outboundGateway)) {
      const resolved = await ctx.outboundGateway.resolveRecipientReference(channel, 'principal', { field: 'recipient' });
      if (!resolved.ok) continue;
      try {
        const sent = await ctx.outboundGateway.send(FALLBACK_REQUEST[channel](resolved.identifier, message), options);
        if (sent.deferredToDigest) {
          return { success: true, data: { channel, app_notice: notice, ...relayDeferredData(sent) } };
        }
        if (sent.success) {
          return {
            success: true,
            data: {
              channel,
              app_notice: notice,
              ...redactionData(sent),
            },
          };
        }
      } catch (err) {
        ctx.log.error({ err, channel }, 'web-send: fallback send threw');
      }
    }
    return { success: false, error: `${notice} No other channel could take the message.` };
  }
}
