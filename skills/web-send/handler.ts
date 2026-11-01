// web-send — reach the principal on the phone app (#2341, ADR-055).
//
// Principal only. A dead subscription, a push setup error, or a push the
// service did not accept is sent onward by this handler, through the same
// gateway checks as the phone send. The order is the configured channels.
// Standing preferences are not parsed. No subscription is a failure and is
// not sent onward. A hold or a content-filter block stops the fallback.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import type { OutboundGateway, OutboundSendRequest, OutboundSendResult } from '../../src/skills/outbound-gateway.js';
import { RELAY_DEFERRED_NOTE, isPrincipalDirectedSend, originatorOption, relayDeferredData, redactionData } from '../../src/skills/_shared/principal-directed.js';
import { FALLBACK_CHANNELS, type FallbackChannel } from '../../src/agents/principal-reach.js';
import { registerOutboundContext } from '../../src/dispatch/context-bridge-parse.js';
import { boundTaskFromMetadata } from '../../src/agents/resumable-task.js';

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
    const { recipient, message, context_bridge: contextBridgeRaw } = ctx.input as {
      recipient?: unknown;
      message?: unknown;
      context_bridge?: unknown;
    };
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
    if (result.webDelivery !== 'fallback') {
      return { success: false, error: result.blockedReason ?? 'Phone app send failed' };
    }

    const notice = result.webDeliveryDetail ?? result.blockedReason ?? 'The phone could not be reached.';
    const options = sendOptions(ctx);
    const order = fallbackOrder(ctx.outboundGateway);
    const skipped = FALLBACK_CHANNELS.filter((channel) => !order.includes(channel));
    const preferenceNote = skipped.length > 0
      ? `Standing preferences were not applied. Skipped ${skipped.join(', ')} because they are not configured.`
      : 'Standing preferences were not applied.';
    for (const channel of order) {
      const resolved = await ctx.outboundGateway.resolveRecipientReference(channel, 'principal', { field: 'recipient' });
      if (!resolved.ok) continue;
      try {
        const sent = await ctx.outboundGateway.send(FALLBACK_REQUEST[channel](resolved.identifier, message), options);
        if (sent.gated || (sent.blockedRules !== undefined && sent.blockedRules.length > 0)) {
          return { success: false, error: sent.blockedReason ?? 'The message was not sent.' };
        }
        if (sent.deferredToDigest) {
          // Both notes: the queue one keeps the agent from re-sending, and the
          // preference one still applies to the channel the digest will use.
          return {
            success: true,
            data: {
              channel,
              delivered_to: resolved.identifier,
              app_notice: notice,
              deferred_to_digest: true,
              note: `${RELAY_DEFERRED_NOTE} ${preferenceNote}`,
            },
          };
        }
        if (sent.success) {
          await registerFallback(ctx, channel, message, contextBridgeRaw, resolved, sent);
          return {
            success: true,
            data: {
              channel,
              delivered_to: resolved.identifier,
              app_notice: notice,
              note: preferenceNote,
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

async function registerFallback(
  ctx: ToolContext,
  channel: FallbackChannel,
  message: string,
  contextBridgeRaw: unknown,
  resolved: { identifier: string; contactId?: string },
  sent: OutboundSendResult,
): Promise<void> {
  if (sent.deferredToDigest) return;
  await registerOutboundContext(ctx.outboundContext, contextBridgeRaw, {
    channelId: channel,
    content: sent.sentContent ?? message,
    agentId: ctx.agentId ?? 'coordinator',
    log: ctx.log,
    boundTask: boundTaskFromMetadata(ctx.taskMetadata as Record<string, unknown> | undefined),
    recipientContactIds: resolved.contactId ? [resolved.contactId] : [],
    outreach: { turn: ctx, via: channel, addresses: [resolved.identifier] },
  });
}
