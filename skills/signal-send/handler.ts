// handler.ts — signal-send skill implementation.
//
// Sends a Signal message to a 1:1 recipient (by contact reference, or E.164 number) or to a
// group (by base64 group ID). Before dispatching a group send, all members are
// checked against the contact system — unknown members are listed explicitly so
// the caller knows who needs verification. Blocked members are reported without
// disclosing their phone numbers (privacy safeguard).
//
// The OutboundGateway enforces the content filter and blocked-contact check
// for the final send, so this handler focuses on Signal-specific validation
// and the group trust pre-check.
//
// 1:1 recipients are references by default (#2033, ADR-047): `recipient` takes a
// contact ID or "principal", resolved to that contact's verified Signal number.
// `recipient_number` is the deliberate raw path, for someone with no contact record.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import { checkGroupMemberTrust } from '../../src/channels/signal/group-trust.js';
import { registerOutboundContext } from '../../src/dispatch/context-bridge-parse.js';
import { boundTaskFromMetadata } from '../../src/agents/resumable-task.js';

const MAX_MESSAGE_LENGTH = 10_000;

// E.164 format: optional +, country code, up to 15 digits total.
// We require the leading + to be strict — signal-cli expects fully qualified numbers.
const E164_REGEX = /^\+[1-9]\d{6,14}$/;

export class SignalSendHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const { recipient, recipient_number: recipientNumber, group_id, message, context_bridge: contextBridgeRaw } = ctx.input as {
      recipient?: string;
      recipient_number?: string;
      group_id?: string;
      message?: string;
      context_bridge?: string;
    };

    // --- Input validation ---

    if (!message || typeof message !== 'string') {
      return { success: false, error: 'Missing required input: message (string)' };
    }

    // Exactly one of recipient / recipient_number / group_id must be provided.
    const destinations = [recipient, recipientNumber, group_id].filter((v) => v !== undefined && v !== null && v !== '');
    if (destinations.length === 0) {
      return {
        success: false,
        error: 'Missing destination: pass recipient (a contact ID, or "principal" for the principal), or group_id. Only for someone with no contact record, pass recipient_number.',
      };
    }
    if (destinations.length > 1) {
      return { success: false, error: 'Provide exactly one of recipient, recipient_number, or group_id' };
    }
    if (
      (recipient !== undefined && typeof recipient !== 'string')
      || (recipientNumber !== undefined && typeof recipientNumber !== 'string')
    ) {
      return { success: false, error: 'recipient and recipient_number must be strings' };
    }

    // Validate E.164 format for raw 1:1 sends. References are validated after resolution.
    if (recipientNumber && !E164_REGEX.test(recipientNumber)) {
      return {
        success: false,
        error: `recipient_number must be a valid E.164 phone number (e.g. +14155552671), got: ${recipientNumber}`,
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
        error: 'signal-send skill requires outboundGateway access. Declare "outboundGateway" in capabilities.',
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
        }, {
          taskEventId: ctx.taskEventId,
          conversationId: ctx.conversationId,
        });

        if (!result.success) {
          return { success: false, error: result.blockedReason ?? 'Signal send failed' };
        }

        // Register outbound context entry (best-effort, always fires).
        await registerOutboundContext(ctx.outboundContext, contextBridgeRaw, {
          channelId: 'signal',
          content: message,
          agentId: ctx.agentId ?? 'coordinator',
          log: ctx.log,
          boundTask: boundTaskFromMetadata(ctx.taskMetadata as Record<string, unknown> | undefined),
        });

        return { success: true, data: { delivered_to: group_id, channel: 'signal' } };
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        ctx.log.error({ err, destinationType: 'group' }, 'signal-send: gateway threw unexpectedly');
        return { success: false, error: `Signal send failed: ${errMessage}` };
      }
    }

    // --- Resolve the 1:1 recipient (#2033) ---
    // A reference fails closed: no contact, or no verified Signal number, means no send.

    let destination: string;
    let contactId: string | undefined;
    let identityName: string | undefined;
    if (recipient) {
      const resolved = await ctx.outboundGateway.resolveRecipientReference('signal', recipient, {
        field: 'recipient',
        rawField: 'recipient_number',
      });
      if (!resolved.ok) return { success: false, error: resolved.error };
      if (!E164_REGEX.test(resolved.identifier)) {
        // A stored identity that signal-cli cannot address: a data defect. Refuse rather
        // than guess, and log the contact for an operator (the ID may be the principal's).
        ctx.log.warn({ contactId: resolved.contactId }, 'signal-send: verified Signal identity is not E.164 — refusing (#2033)');
        return {
          success: false,
          error: `The contact's verified Signal identity is not an E.164 number, so nothing was sent. It needs correcting in Contacts.`,
        };
      }
      destination = resolved.identifier;
      // Echo the contact ID only for a UUID the agent passed. For the alias it is the
      // principal's, which spec 09 keeps out of the model's context.
      contactId = resolved.kind === 'contact' ? resolved.contactId : undefined;
      identityName = resolved.identityName;
    } else {
      destination = recipientNumber!;
    }

    // --- Dispatch via gateway (1:1) ---

    ctx.log.info({ destinationType: '1:1', byReference: !!recipient }, 'signal-send: dispatching Signal message via gateway');

    try {
      const result = await ctx.outboundGateway.send({
        channel: 'signal',
        recipient: destination,
        message,
      }, {
        taskEventId: ctx.taskEventId,
        conversationId: ctx.conversationId,
      });

      if (!result.success) {
        return {
          success: false,
          error: result.blockedReason ?? 'Signal send failed',
        };
      }

      // Register outbound context entry (best-effort, always fires).
      await registerOutboundContext(ctx.outboundContext, contextBridgeRaw, {
        channelId: 'signal',
        content: message,
        agentId: ctx.agentId ?? 'coordinator',
        log: ctx.log,
        boundTask: boundTaskFromMetadata(ctx.taskMetadata as Record<string, unknown> | undefined),
      });

      return {
        success: true,
        data: {
          // The resolved number. Reply-lock reads this field.
          delivered_to: destination,
          ...(contactId ? { contact_id: contactId } : {}),
          ...(identityName ? { recipient_identity: identityName } : {}),
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
