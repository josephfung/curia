// handler.ts — deliver-approval (#2159).
//
// Sends a pending approval to the principal on ONE channel the agent chose from the
// principal's standing preferences. Raise sites no longer notify anyone; this is the ping.
// On a failure the error lists the channels still available, so the agent tries the next
// one in its preference order. Nothing is ever sent on two channels at once.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { APPROVAL_CHANNELS, type ApprovalChannel } from '../../../../src/autonomy/approval-delivery.js';

const CHANNEL_NAMES: Record<ApprovalChannel, string> = {
  signal: 'Signal',
  sms: 'SMS',
  slack: 'Slack',
  email: 'Email',
};

function list(channels: ApprovalChannel[]): string {
  return channels.length > 0 ? channels.join(', ') : 'none';
}

export class DeliverApprovalHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.approvalDelivery) {
      return { success: false, error: 'deliver-approval requires approvalDelivery capability' };
    }
    const shortRef = typeof ctx.input.short_ref === 'string' ? ctx.input.short_ref.trim() : '';
    if (shortRef === '') {
      return { success: false, error: 'short_ref is required (the reference from the blocked action)' };
    }
    const channel = ctx.input.channel;
    if (typeof channel !== 'string' || !(APPROVAL_CHANNELS as readonly string[]).includes(channel)) {
      return { success: false, error: `channel must be one of: ${APPROVAL_CHANNELS.join(', ')}` };
    }
    const chosen = channel as ApprovalChannel;

    try {
      const result = await ctx.approvalDelivery.deliver(shortRef, chosen);
      if (result.delivered) {
        return {
          success: true,
          data: `Delivered on ${CHANNEL_NAMES[chosen]}. It will be mentioned once more in the next digest; do not send reminders.`,
        };
      }
      switch (result.reason) {
        case 'send_failed':
          return { success: false, error: `${CHANNEL_NAMES[chosen]} delivery failed. Channels still available: ${list(result.available)}.` };
        case 'already_delivered':
          return { success: false, error: `Approval ${shortRef} was already delivered. Do not send it again; it will be mentioned in the next digest.` };
        case 'channel_unavailable':
          return { success: false, error: `The principal has no verified ${CHANNEL_NAMES[chosen]} identity. Channels available: ${list(result.available)}.` };
        case 'not_found':
          return { success: false, error: `No pending approval with reference ${shortRef}; it may have been resolved or expired.` };
        default: {
          // Exhaustive: a new reason must be given its own wording here.
          const unhandled: never = result.reason;
          ctx.log.error({ reason: unhandled }, 'deliver-approval: unhandled delivery result');
          return { success: false, error: 'deliver-approval failed' };
        }
      }
    } catch (err) {
      ctx.log.error({ err, shortRef, channel }, 'deliver-approval: unexpected failure');
      return { success: false, error: 'deliver-approval failed unexpectedly' };
    }
  }
}
