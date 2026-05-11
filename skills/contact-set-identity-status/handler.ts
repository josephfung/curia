// handler.ts — contact-set-identity-status skill implementation.
//
// Sets the status of a contact's channel identity (email, phone, etc.).
// Status is orthogonal to the verified flag — an address can be
// verified-but-bounced or unverified-but-active.
//
// See: https://github.com/josephfung/curia/issues/377

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import type { IdentityStatus } from '../../src/contacts/types.js';
import { IdentityNotFoundError } from '../../src/contacts/types.js';

const VALID_STATUSES = new Set<string>(['active', 'defunct', 'bounced']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ContactSetIdentityStatusHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { identity_id, status } = ctx.input as {
      identity_id?: string;
      status?: string;
    };

    // -- Input validation --

    if (!identity_id || typeof identity_id !== 'string') {
      return { success: false, error: 'Missing required input: identity_id (string)' };
    }
    if (!UUID_RE.test(identity_id)) {
      return {
        success: false,
        error: "identity_id must be a valid UUID. Use contact-lookup to obtain identity UUIDs.",
      };
    }

    if (!status || typeof status !== 'string') {
      return { success: false, error: 'Missing required input: status (string)' };
    }
    if (!VALID_STATUSES.has(status)) {
      return {
        success: false,
        error: `status must be 'active', 'defunct', or 'bounced'. Got: '${status}'`,
      };
    }

    if (!ctx.contactService) {
      return {
        success: false,
        error: 'contact-set-identity-status: contactService not available — this is a universal service, check ExecutionLayer configuration.',
      };
    }

    ctx.log.info({ identity_id, status }, 'Setting identity status');

    try {
      const updated = await ctx.contactService.setIdentityStatus(
        identity_id,
        status as IdentityStatus,
      );

      ctx.log.info(
        { identityId: updated.id, contactId: updated.contactId, status: updated.status },
        'Identity status updated',
      );

      return {
        success: true,
        data: {
          identity_id: updated.id,
          channel: updated.channel,
          identifier: updated.channelIdentifier,
          status: updated.status,
          contact_id: updated.contactId,
        },
      };
    } catch (err) {
      if (err instanceof IdentityNotFoundError) {
        ctx.log.info({ identity_id }, 'Identity not found');
        return {
          success: false,
          error: `No identity exists with id ${identity_id}. Use contact-lookup to verify the UUID.`,
        };
      }
      ctx.log.error({ err, identity_id }, 'Failed to set identity status');
      return { success: false, error: 'Failed to set identity status. See logs for details.' };
    }
  }
}
