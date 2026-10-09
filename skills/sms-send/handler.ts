// handler.ts — sms-send skill implementation.
//
// Sends a 1:1 SMS via OutboundGateway → Telnyx. The gateway enforces content
// filter, blocked-contact, and autonomy. Carrier STOP (Telnyx 40300) surfaces as
// blockedReason so the agent can record a KG fact instead of retrying.
//
// The recipient is a reference (#2033, #2041, ADR-047): `recipient` takes a contact ID
// or "principal", resolved to that contact's verified SMS number. Someone who is not a
// contact yet is added first with contact-create. The retired raw input
// (recipient_number) is refused, never ignored.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import { registerOutboundContext } from '../../src/dispatch/context-bridge-parse.js';
import { boundTaskFromMetadata } from '../../src/agents/resumable-task.js';
import { isPrincipalDirectedSend } from '../../src/skills/_shared/principal-directed.js';
import {
  RECIPIENT_REFERENCE_SKILLS,
  findRetiredRecipientField,
  retiredRecipientFieldError,
} from '../../src/skills/_shared/recipient-reference.js';

const MAX_MESSAGE_LENGTH = 1600;
const E164_REGEX = /^\+[1-9]\d{6,14}$/;

export class SmsSendHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const skill = RECIPIENT_REFERENCE_SKILLS['sms-send']!;
    const retired = findRetiredRecipientField(skill, ctx.input);
    if (retired) return { success: false, error: retiredRecipientFieldError(skill, retired) };

    const { recipient, message, context_bridge: contextBridgeRaw } = ctx.input as {
      recipient?: unknown;
      message?: string;
      context_bridge?: string;
    };

    if (!message || typeof message !== 'string') {
      return { success: false, error: 'Missing required input: message (string)' };
    }

    if (recipient !== undefined && recipient !== null && typeof recipient !== 'string') {
      return { success: false, error: 'recipient must be a string' };
    }
    if (!recipient) {
      return {
        success: false,
        error: 'Missing recipient: pass recipient (a contact ID, or "principal" for the principal). Someone who is not a contact yet must be added first with contact-create, which returns their contact ID.',
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

    // Resolve the reference (#2033). No contact, or no verified SMS number, means no send.
    const resolved = await ctx.outboundGateway.resolveRecipientReference('sms', recipient as string, {
      field: 'recipient',
    });
    if (!resolved.ok) return { success: false, error: resolved.error };
    if (!E164_REGEX.test(resolved.identifier)) {
      // A stored identity Telnyx cannot address: a data defect. Refuse rather than
      // guess, and log the contact for an operator (the ID may be the principal's).
      ctx.log.warn({ contactId: resolved.contactId }, 'sms-send: verified SMS identity is not E.164 — refusing (#2033)');
      return {
        success: false,
        error: `The contact's verified SMS identity is not an E.164 number, so nothing was sent. It needs correcting in Contacts.`,
      };
    }
    const destination = resolved.identifier;
    // Echo the contact ID only for a UUID the agent passed. For the alias it is the
    // principal's, which spec 09 keeps out of the model's context.
    const contactId = resolved.kind === 'contact' ? resolved.contactId : undefined;
    const identityName = resolved.identityName;

    ctx.log.info({ destinationType: '1:1', byReference: true }, 'sms-send: dispatching SMS via gateway');

    try {
      const result = await ctx.outboundGateway.send(
        {
          channel: 'sms',
          recipient: destination,
          message,
        },
        {
          taskEventId: ctx.taskEventId,
          conversationId: ctx.conversationId,
          principalDirected: isPrincipalDirectedSend(ctx),
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
          // The resolved number. Reply-lock reads this field.
          delivered_to: destination,
          ...(contactId ? { contact_id: contactId } : {}),
          ...(identityName ? { recipient_identity: identityName } : {}),
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
