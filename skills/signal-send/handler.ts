// handler.ts — signal-send skill implementation.
//
// Sends a Signal message to a 1:1 recipient (by E.164 phone number) or to a
// group (by base64 group ID). Before dispatching a group send, all members are
// checked against the contact system — unknown members are listed explicitly so
// the caller knows who needs verification. Blocked members are reported without
// disclosing their phone numbers (privacy safeguard).
//
// The OutboundGateway enforces the content filter and blocked-contact check
// for the final send, so this handler focuses on Signal-specific validation
// and the group trust pre-check.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { checkGroupMemberTrust } from '../../src/channels/signal/group-trust.js';

const MAX_MESSAGE_LENGTH = 10_000;

// E.164 format: optional +, country code, up to 15 digits total.
// We require the leading + to be strict — signal-cli expects fully qualified numbers.
const E164_REGEX = /^\+[1-9]\d{6,14}$/;

export class SignalSendHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { recipient, group_id, message } = ctx.input as {
      recipient?: string;
      group_id?: string;
      message?: string;
    };

    // --- Input validation ---

    if (!message || typeof message !== 'string') {
      return { success: false, error: 'Missing required input: message (string)' };
    }

    // Exactly one of recipient / group_id must be provided.
    if (!recipient && !group_id) {
      return { success: false, error: 'Either recipient or group_id is required' };
    }

    if (recipient && group_id) {
      return { success: false, error: 'Provide either recipient or group_id, not both' };
    }

    // Validate E.164 format for 1:1 sends.
    if (recipient && !E164_REGEX.test(recipient)) {
      return {
        success: false,
        error: `recipient must be a valid E.164 phone number (e.g. +14155552671), got: ${recipient}`,
      };
    }

    if (message.length > MAX_MESSAGE_LENGTH) {
      return {
        success: false,
        error: `message must be 10,000 characters or fewer (got ${message.length})`,
      };
    }

    // --- Infrastructure checks ---

    if (!ctx.outboundGateway) {
      return {
        success: false,
        error: 'signal-send skill requires outboundGateway access. Is infrastructure: true set in the manifest and outboundGateway passed to ExecutionLayer?',
      };
    }

    // --- Group trust pre-check ---
    // For group sends, resolve all members before calling the gateway. This lets us
    // provide actionable error messages (listing which members need verification)
    // rather than a generic failure from the gateway.

    if (group_id) {
      if (!ctx.contactService) {
        return {
          success: false,
          error: 'signal-send group sends require contactService. Is it configured in the ExecutionLayer?',
        };
      }

      let memberPhones: string[];
      try {
        memberPhones = await ctx.outboundGateway.getSignalGroupMembers(group_id);
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        ctx.log.warn({ err, groupId: '[redacted]' }, 'signal-send: failed to fetch group members');
        return { success: false, error: `Could not retrieve group members: ${errMessage}` };
      }

      let trust: Awaited<ReturnType<typeof checkGroupMemberTrust>>;
      try {
        trust = await checkGroupMemberTrust(memberPhones, ctx.contactService);
      } catch (err) {
        // Log structured details for ops visibility. memberPhones are internal (E.164 phone
        // numbers of group members) and safe to log; err.message could contain RPC internals
        // so we return a stable string to the caller instead of forwarding it.
        ctx.log.warn(
          { err, memberPhones, memberCount: memberPhones.length },
          'signal-send: group member trust check threw unexpectedly',
        );
        return { success: false, error: 'Failed to verify group member trust' };
      }

      if (!trust.trusted) {
        // Blocked members: report existence but NOT their phone numbers (privacy).
        if (trust.blockedMembers.length > 0) {
          return {
            success: false,
            error: `Cannot send to group: ${trust.blockedMembers.length} member(s) are blocked`,
          };
        }

        // Unknown/unverified members: list their numbers so the operator knows who to verify.
        if (trust.unknownMembers.length > 0) {
          return {
            success: false,
            error: `Cannot send to group: the following members have not been verified in contacts and must be verified before sending: ${trust.unknownMembers.join(', ')}`,
          };
        }
      }

      // Dispatch immediately after the trust check — minimises the TOCTOU window between
      // membership verification and the actual send. Group membership can change between
      // awaits; keeping the send here (rather than in the shared path below) ensures no
      // unrelated async work runs between the check and the dispatch.
      ctx.log.info({ destinationType: 'group' }, 'signal-send: dispatching Signal message via gateway');

      try {
        const result = await ctx.outboundGateway.send({
          channel: 'signal',
          groupId: group_id,
          message,
          triggerSource: ctx.triggerSource,
        });

        if (!result.success) {
          return { success: false, error: result.blockedReason ?? 'Signal send failed' };
        }

        return { success: true, data: { delivered_to: group_id, channel: 'signal' } };
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        ctx.log.error({ err, destinationType: 'group' }, 'signal-send: gateway threw unexpectedly');
        return { success: false, error: `Signal send failed: ${errMessage}` };
      }
    }

    // --- Dispatch via gateway (1:1) ---

    ctx.log.info({ destinationType: '1:1' }, 'signal-send: dispatching Signal message via gateway');

    try {
      const result = await ctx.outboundGateway.send({
        channel: 'signal',
        recipient: recipient,
        message,
        triggerSource: ctx.triggerSource,
      });

      if (!result.success) {
        return {
          success: false,
          error: result.blockedReason ?? 'Signal send failed',
        };
      }

      return {
        success: true,
        data: {
          delivered_to: recipient,
          channel: 'signal',
        },
      };
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, destinationType: '1:1' }, 'signal-send: gateway threw unexpectedly');
      return { success: false, error: `Signal send failed: ${errMessage}` };
    }
  }
}
