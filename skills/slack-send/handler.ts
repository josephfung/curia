// handler.ts — slack-send skill implementation.
//
// Sends a 1:1 Slack DM via OutboundGateway → chat.postMessage. The gateway
// enforces content filter, blocked-contact, and autonomy. Pass the U… as both
// slackChannelId and slackUserId (Slack opens/uses the IM for a user id channel).
//
// Out of scope for v1: Enterprise Grid workspace user ids (W…) — rejected by
// the recipient regex so Gate C / proactive DMs fail closed for those ids.
//
// The recipient is a reference (#2033, #2041, ADR-047): `recipient` takes a contact ID
// or "principal", resolved to that contact's verified Slack user id. Someone who is not
// a contact yet is added first with contact-create. The retired raw input
// (recipient_user_id) is refused, never ignored.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import { registerOutboundContext } from '../../src/dispatch/context-bridge-parse.js';
import { boundTaskFromMetadata } from '../../src/agents/resumable-task.js';
import { isPrincipalDirectedSend } from '../../src/skills/_shared/principal-directed.js';
import {
  RECIPIENT_REFERENCE_SKILLS,
  findRetiredRecipientField,
  retiredRecipientFieldError,
} from '../../src/skills/_shared/recipient-reference.js';

/** Slack chat.postMessage hard limit. */
const MAX_MESSAGE_LENGTH = 40_000;
/**
 * Standard Slack user ids are uppercase U…. Case-sensitive on purpose: a
 * lowercase `u…` would pass a case-insensitive check but miss exact-match
 * principal identity comparison. Enterprise Grid `W…` ids are out of scope.
 */
const SLACK_USER_ID_REGEX = /^U[A-Z0-9]+$/;

export class SlackSendHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const skill = RECIPIENT_REFERENCE_SKILLS['slack-send']!;
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
        error: 'slack-send skill requires outboundGateway access. Declare "outboundGateway" in capabilities.',
      };
    }

    // Resolve the reference (#2033). No contact, or no verified Slack id, means no send.
    const resolved = await ctx.outboundGateway.resolveRecipientReference('slack', recipient as string, {
      field: 'recipient',
    });
    if (!resolved.ok) return { success: false, error: resolved.error };
    if (!SLACK_USER_ID_REGEX.test(resolved.identifier)) {
      // W… Enterprise Grid ids stay out of scope on the reference path too.
      ctx.log.warn({ contactId: resolved.contactId }, 'slack-send: verified Slack identity is not a U… user id — refusing (#2033)');
      return {
        success: false,
        error: `The contact's verified Slack identity is not a U… user id, so nothing was sent. Enterprise Grid (W…) ids are not supported.`,
      };
    }
    const destination = resolved.identifier;
    // Echo the contact ID only for a UUID the agent passed. For the alias it is the
    // principal's, which spec 09 keeps out of the model's context.
    const contactId = resolved.kind === 'contact' ? resolved.contactId : undefined;
    const identityName = resolved.identityName;

    ctx.log.info({ destinationType: '1:1', byReference: true }, 'slack-send: dispatching Slack DM via gateway');

    try {
      // Overload: put U… in slackChannelId even though that field's type doc
      // describes D…/C…/G… conversation ids. chat.postMessage accepts a user
      // id as channel and opens/uses the IM (same precedent as
      // approval-channel-notify.ts). Principal eligibility / blocked-contact
      // resolve from slackUserId (also the U…), never from slackChannelId alone.
      const result = await ctx.outboundGateway.send(
        {
          channel: 'slack',
          slackChannelId: destination,
          slackUserId: destination,
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
          // The resolved user id. Reply-lock reads this field.
          delivered_to: destination,
          ...(contactId ? { contact_id: contactId } : {}),
          ...(identityName ? { recipient_identity: identityName } : {}),
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
