// handler.ts — contact-link-identity skill implementation.
//
// Adds a channel identity (email, phone, Signal, SMS, Telegram, Slack) to an existing
// contact. The identity is recorded as agent_stated (#2041): an agent typed it. It is
// verified, as contact-create's are, once the duplicate check passes:
//   - an address another contact holds is refused;
//   - an address resembling another contact's is listed until the agent names that
//     contact in distinct_from.
//
// Re-stating an address already on this contact is how an agent vouches for one it
// typed earlier. An unverified outbound_recipient identity (recorded by the gateway
// after a first-time send) is verified in place, after the same duplicate check: verifying
// is the risky step, and the gateway records whatever address the agent typed, typos
// included. Other unverified sources (self_claimed, sms_participant) need the principal.
//
// A structural contact (the principal, an agent, a system contact: isStructuralContact)
// is never changed here — see structuralContactRefusal.
//
// This skill uses contactService, which is a universal service.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import type { DuplicateCheck } from '../../../../src/contacts/types.js';
import { LINKABLE_CHANNEL_IDENTITY_SET } from '../../../../src/contacts/linkable-channels.js';
import { normalizeAgentIdentifier } from '../../../../src/contacts/agent-identifier.js';
import { sameIdentifier } from '../../../../src/contacts/identifier-near-miss.js';
import {
  candidatesError,
  parseDistinctFrom,
  takenError,
  uncoveredCandidates,
} from '../../../../src/skills/_shared/duplicate-refusal.js';
import { structuralContactRefusal } from '../../../../src/skills/_shared/structural-contact-guard.js';

const NOT_LINKED = 'Nothing was linked.';
const NOT_VERIFIED = 'Nothing was verified.';
const NEXT =
  'Check the address: it resembles theirs. If it is right, call contact-link-identity again with distinct_from listing every ID above.';

/**
 * The duplicate check for one address on one contact. Returns the refusal to hand the
 * agent, or null when the write may go ahead. A check that cannot run refuses: the
 * write is never made unchecked.
 * `action` says what did not happen ("Nothing was linked.").
 */
async function duplicateRefusal(
  ctx: ToolContext,
  contactService: NonNullable<ToolContext['contactService']>,
  wanted: { contactId: string; channel: string; identifier: string },
  distinctFrom: ReadonlySet<string>,
  action: string,
): Promise<string | null> {
  let check: DuplicateCheck;
  try {
    check = await contactService.findLikelyDuplicates({
      identities: [{ channel: wanted.channel, identifier: wanted.identifier }],
      excludeContactId: wanted.contactId,
    });
  } catch (err) {
    ctx.log.error({ err, contact_id: wanted.contactId }, 'contact-link-identity: duplicate check failed — refusing (#2041)');
    return `The duplicate check could not run. ${action} Try again.`;
  }
  const taken = check.taken[0];
  if (taken) return takenError(taken, action);
  if (uncoveredCandidates(check.candidates, distinctFrom).length > 0) {
    ctx.log.info({ candidates: check.candidates.length }, 'contact-link-identity: refused — likely duplicate (#2041)');
    return candidatesError(check.candidates, action, NEXT);
  }
  return null;
}

export class ContactLinkIdentityHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const input = ctx.input as Record<string, unknown>;
    const { contact_id, channel, identifier, label } = input as {
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

    // Channel allowlist — single shared constant with the console HTTP API (#1514).
    if (!LINKABLE_CHANNEL_IDENTITY_SET.has(channel)) {
      return {
        success: false,
        error: `Invalid channel '${channel}'. Allowed: ${[...LINKABLE_CHANNEL_IDENTITY_SET].join(', ')}`,
      };
    }

    const normalized = normalizeAgentIdentifier(channel, identifier);
    if (!normalized.ok) return { success: false, error: `${normalized.error} ${NOT_LINKED}` };

    const distinctFrom = parseDistinctFrom(input['distinct_from']);
    if (!distinctFrom.ok) return { success: false, error: distinctFrom.error };

    // contactService is a universal service — always injected by ExecutionLayer
    if (!ctx.contactService) {
      return {
        success: false,
        error: 'contact-link-identity: contactService not available — this is a universal service, check ExecutionLayer configuration.',
      };
    }

    try {
      const target = await ctx.contactService.getContactWithIdentities(contact_id);
      if (!target) {
        return { success: false, error: `No contact has ID ${contact_id}. ${NOT_LINKED} contact-lookup returns the ID.` };
      }

      // A structural contact's addresses are not an agent's to change: an agent adding
      // (or verifying) one of the principal's would be able to impersonate the principal.
      // This covers a new address, a re-statement, and verifying an outbound_recipient
      // one. The same rule guards merge, unlink and set-identity-status.
      const structural = structuralContactRefusal(target.contact, NOT_LINKED, ctx.log, 'contact-link-identity');
      if (structural) return { success: false, error: structural };

      // Re-statement: the address is already on this contact.
      const existing = target.identities.find(
        (identity) => identity.channel === channel && sameIdentifier(channel, identity.channelIdentifier, normalized.identifier),
      );
      if (existing) {
        if (existing.verified) {
          return { success: true, data: { identity_id: existing.id, verified: true, already_linked: true } };
        }
        if (existing.source === 'outbound_recipient') {
          // An agent typed it on a first-time send; an agent re-stating it vouches for it.
          // The gateway recorded the address as typed, so a typo of someone else's address
          // is exactly what this can verify: run the check a new address gets first.
          const restateRefusal = await duplicateRefusal(
            ctx,
            ctx.contactService,
            { contactId: contact_id, channel, identifier: normalized.identifier },
            distinctFrom.tokens,
            NOT_VERIFIED,
          );
          if (restateRefusal) return { success: false, error: restateRefusal };
          const verified = await ctx.contactService.verifyIdentity(existing.id);
          ctx.log.info(
            { identityId: existing.id, contactId: contact_id },
            'contact-link-identity: re-stated outbound_recipient address verified (#2041)',
          );
          return { success: true, data: { identity_id: verified.id, verified: verified.verified, already_linked: true } };
        }
        return {
          success: false,
          error: 'That address is already on this contact, unverified. Only the principal can verify it, in the console. Nothing changed.',
        };
      }

      const refusal = await duplicateRefusal(
        ctx,
        ctx.contactService,
        { contactId: contact_id, channel, identifier: normalized.identifier },
        distinctFrom.tokens,
        NOT_LINKED,
      );
      if (refusal) return { success: false, error: refusal };

      ctx.log.info({ contact_id, channel }, 'Linking identity to contact');
      const identity = await ctx.contactService.linkIdentity({
        contactId: contact_id,
        channel,
        channelIdentifier: normalized.identifier,
        label: label ?? undefined,
        source: 'agent_stated',
      });

      ctx.log.info(
        { identityId: identity.id, contactId: contact_id, verified: identity.verified },
        'Identity linked successfully',
      );

      return { success: true, data: { identity_id: identity.id, verified: identity.verified, already_linked: false } };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        // Another contact took the address between the check and this link.
        return { success: false, error: `That ${channel} address was just added to another contact. ${NOT_LINKED}` };
      }
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, contact_id, channel }, 'Failed to link identity');
      return { success: false, error: `Failed to link identity: ${message}` };
    }
  }
}
