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
// after a first-time send) is verified in place. Other unverified sources
// (self_claimed, sms_participant) need the principal.
//
// A structural contact (systemRole set: principal, agent, system) is never changed
// here — see the guard below.
//
// This skill uses contactService, which is a universal service.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import type { DuplicateCheck } from '../../../../src/contacts/types.js';
import { LINKABLE_CHANNEL_IDENTITY_SET } from '../../../../src/contacts/linkable-channels.js';
import { normalizeAgentIdentifier } from '../../../../src/contacts/agent-identifier.js';
import { sameIdentifier } from '../../../../src/contacts/identifier-near-miss.js';
import {
  candidatesError,
  isPrincipalContact,
  parseDistinctFrom,
  takenError,
  uncoveredCandidates,
} from '../../../../src/skills/_shared/duplicate-refusal.js';

const NOT_LINKED = 'Nothing was linked.';
const NEXT =
  'Check the address: it resembles theirs. If it is right, call contact-link-identity again with distinct_from listing every ID above.';

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

      // A structural contact's addresses are not an agent's to change. The principal's
      // verified identities are trusted as the principal by Gate C and by the "principal"
      // send alias, so an agent adding (or verifying) one would be able to impersonate
      // the principal. This covers a new address, a re-statement, and verifying an
      // outbound_recipient one. The principal's contact ID stays out of the error and the
      // log: it must not reach the model's context (spec 09).
      if (target.contact.systemRole !== null) {
        if (isPrincipalContact(target.contact)) {
          ctx.log.info({ channel }, 'contact-link-identity: refused — principal addresses are not agent-managed (#2041)');
          return {
            success: false,
            error: `The principal's addresses are managed by the principal, in the console. ${NOT_LINKED}`,
          };
        }
        ctx.log.info(
          { contact_id, channel, systemRole: target.contact.systemRole },
          'contact-link-identity: refused — system contact addresses are not agent-managed (#2041)',
        );
        return {
          success: false,
          error: `This is a system contact; its addresses are not managed by agents. ${NOT_LINKED}`,
        };
      }

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

      let check: DuplicateCheck;
      try {
        check = await ctx.contactService.findLikelyDuplicates({
          identities: [{ channel, identifier: normalized.identifier }],
          excludeContactId: contact_id,
        });
      } catch (err) {
        ctx.log.error({ err, contact_id }, 'contact-link-identity: duplicate check failed — refusing (#2041)');
        return { success: false, error: `The duplicate check could not run. ${NOT_LINKED} Try again.` };
      }
      const taken = check.taken[0];
      if (taken) return { success: false, error: takenError(taken, NOT_LINKED) };
      if (uncoveredCandidates(check.candidates, distinctFrom.tokens).length > 0) {
        ctx.log.info({ candidates: check.candidates.length }, 'contact-link-identity: refused — likely duplicate (#2041)');
        return { success: false, error: candidatesError(check.candidates, NOT_LINKED, NEXT) };
      }

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
