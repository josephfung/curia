// handler.ts — contact-link-identity skill implementation.
//
// Adds a channel identity (email, phone, Signal, Telegram) to an existing
// contact. Uses source 'ceo_stated' since the coordinator acts on behalf
// of the CEO, which means the identity is auto-verified.
//
// This skill uses contactService, which is a universal service.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

export class ContactLinkIdentityHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { contact_id, channel, identifier, label } = ctx.input as {
      contact_id?: string;
      channel?: string;
      identifier?: string;
      label?: string;
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

    // Channel allowlist — only accept known channel types
    const ALLOWED_CHANNELS = ['email', 'phone', 'signal', 'telegram'];
    if (!ALLOWED_CHANNELS.includes(channel)) {
      return { success: false, error: `Invalid channel '${channel}'. Allowed: ${ALLOWED_CHANNELS.join(', ')}` };
    }

    // Infrastructure skills need contactService
    if (!ctx.contactService) {
      return {
        success: false,
        error: 'contact-link-identity skill requires contactService is a universal service — check ExecutionLayer configuration.',
      };
    }

    ctx.log.info({ contact_id, channel, identifier }, 'Linking identity to contact');

    try {
      const identity = await ctx.contactService.linkIdentity({
        contactId: contact_id,
        channel,
        channelIdentifier: identifier,
        label: label ?? undefined,
        source: 'ceo_stated',
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
