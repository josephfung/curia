// handler.ts — contact-link-identity skill implementation.
//
// Adds a channel identity (email, phone, Signal, Telegram, Slack) to an existing
// contact. Source is `agent_created`: an agent supplied the identifier, after a
// duplicate check. That source is auto-verified so a following send can deliver.
// It does not mean the principal confirmed the address (#2041, ADR-047).
//
// This skill uses contactService, which is a universal service.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { LINKABLE_CHANNEL_IDENTITY_SET } from '../../../../src/contacts/linkable-channels.js';
import {
  isConfirmNew,
  outreachDuplicateError,
} from '../../../../src/contacts/outreach-duplicates.js';

export class ContactLinkIdentityHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const { contact_id, channel, identifier, label, confirm_new: confirmNew } = ctx.input as {
      contact_id?: string;
      channel?: string;
      identifier?: string;
      label?: string;
      confirm_new?: unknown;
    };

    // Validate required inputs
    if (!contact_id || typeof contact_id !== 'string') {
      return { success: false, error: 'Missing required input: contact_id (string)' };
    }
    if (!channel || typeof channel !== 'string') {
      return { success: false, error: 'Missing required input: channel (string)' };
    }
    if (!identifier || typeof identifier !== 'string') {
      return { success: false, error: 'Missing required input: identifier (string)' };
    }

    // Input length limits — prevent oversized payloads reaching the DB
    if (identifier.length > 500) {
      return { success: false, error: 'Identifier must be 500 characters or fewer' };
    }
    if (label && label.length > 200) {
      return { success: false, error: 'Label must be 200 characters or fewer' };
    }

    // Channel allowlist — single shared constant with the console HTTP API (#1514).
    if (!LINKABLE_CHANNEL_IDENTITY_SET.has(channel)) {
      return {
        success: false,
        error: `Invalid channel '${channel}'. Allowed: ${[...LINKABLE_CHANNEL_IDENTITY_SET].join(', ')}`,
      };
    }

    // contactService is a universal service — always injected by ExecutionLayer
    if (!ctx.contactService) {
      return {
        success: false,
        error: 'contact-link-identity: contactService not available — this is a universal service, check ExecutionLayer configuration.',
      };
    }

    const trimmed = identifier.trim();
    let existing;
    try {
      existing = await ctx.contactService.resolveByChannelIdentity(channel, trimmed);
    } catch (err) {
      ctx.log.error({ err, contact_id, channel }, 'contact-link-identity: lookup failed');
      return { success: false, error: 'Failed to check for an existing contact. Nothing was linked.' };
    }
    if (existing?.contactId === contact_id) {
      return { success: false, error: 'That identifier is already on this contact. Nothing was linked.' };
    }

    let duplicates;
    try {
      duplicates = await ctx.contactService.findOutreachDuplicates({
        identifiers: [{ channel, identifier: trimmed }],
        excludeContactId: contact_id,
      });
    } catch (err) {
      ctx.log.error({ err, contact_id, channel }, 'contact-link-identity: duplicate check failed');
      return { success: false, error: 'Failed to check for an existing contact. Nothing was linked.' };
    }
    if (duplicates.exact.length > 0 || (duplicates.likely.length > 0 && !isConfirmNew(confirmNew))) {
      return { success: false, error: outreachDuplicateError(duplicates, 'linked') };
    }

    ctx.log.info({ contact_id, channel }, 'Linking identity to contact');

    try {
      const identity = await ctx.contactService.linkIdentity({
        contactId: contact_id,
        channel,
        channelIdentifier: trimmed,
        label: label ?? undefined,
        source: 'agent_created',
      });

      ctx.log.info(
        { identityId: identity.id, contactId: contact_id, verified: identity.verified },
        'Identity linked successfully',
      );

      return {
        success: true,
        data: {
          identity_id: identity.id,
          verified: identity.verified,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, contact_id, channel }, 'Failed to link identity');
      return { success: false, error: `Failed to link identity: ${message}` };
    }
  }
}
