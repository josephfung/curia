// web-send — reach the principal on the phone app (#2341, ADR-055).
//
// Principal only. A dead subscription or a push setup error is sent onward by
// this handler, on Signal, then SMS, then Slack, then email. A busy push
// service is not sent onward.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import type { OutboundSendRequest } from '../../src/skills/outbound-gateway.js';
import { isPrincipalDirectedSend, originatorOption, relayDeferredData, redactionData } from '../../src/skills/_shared/principal-directed.js';

const MAX_MESSAGE_LENGTH = 4000;

const FALLBACK: ReadonlyArray<{
  channel: 'signal' | 'sms' | 'slack' | 'email';
  request: (identifier: string, message: string) => OutboundSendRequest;
}> = [
  { channel: 'signal', request: (identifier, message) => ({ channel: 'signal', recipient: identifier, message }) },
  { channel: 'sms', request: (identifier, message) => ({ channel: 'sms', recipient: identifier, message }) },
  { channel: 'slack', request: (identifier, message) => ({ channel: 'slack', slackChannelId: identifier, slackUserId: identifier, message }) },
  { channel: 'email', request: (identifier, message) => ({ channel: 'email', to: identifier, subject: 'Message from Curia', body: message }) },
];

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
        {
          taskEventId: ctx.taskEventId,
          conversationId: ctx.conversationId,
          principalDirected: isPrincipalDirectedSend(ctx),
          ...originatorOption(ctx),
          humanApproved: ctx.humanApproved,
          holdRecipe: { toolName: 'web-send', partialPayload: ctx.input, description: 'Message on the phone app' },
        },
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
    for (const candidate of FALLBACK) {
      const resolved = await ctx.outboundGateway.resolveRecipientReference(candidate.channel, 'principal', { field: 'recipient' });
      if (!resolved.ok) continue;
      try {
        const sent = await ctx.outboundGateway.send(candidate.request(resolved.identifier, message), {
          taskEventId: ctx.taskEventId,
          conversationId: ctx.conversationId,
          principalDirected: true,
          humanApproved: ctx.humanApproved,
        });
        if (sent.success) {
          return {
            success: true,
            data: {
              channel: candidate.channel,
              app_notice: notice,
              ...redactionData(sent),
            },
          };
        }
      } catch (err) {
        ctx.log.error({ err, channel: candidate.channel }, 'web-send: fallback send threw');
      }
    }
    return { success: false, error: `${notice} No other channel could take the message.` };
  }
}
