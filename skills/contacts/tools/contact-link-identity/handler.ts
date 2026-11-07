// handler.ts — contact-link-identity skill implementation.
//
// Adds a channel identity (email, phone, Signal, SMS, Telegram, Slack) to an existing
// contact. The identity is recorded as agent_stated (#2041): an agent typed it. It is
// verified, as contact-create's are, once the duplicate check passes:
//   - an address another contact holds is refused;
//   - an address resembling another contact's is listed until the agent names that
//     contact in distinct_from;
// and once it is found in the conversation's sources (#2061): a message a person sent,
// or a source-tool result. An address found in neither is refused.
//
// A phone-family number that matches a verified, active E.164 identity already on the
// contact on a sibling channel (a `phone` number linked as `sms`) is linked as a
// derived row (#2447): it is an exact copy of a verified number, so it needs no source
// in the conversation. The duplicate check still runs.
//
// Re-stating an address already on this contact is how an agent vouches for one it
// typed earlier. An unverified outbound_recipient identity (recorded by the gateway
// after a first-time send) is verified in place, after the same two checks: verifying
// is the risky step, and the gateway records whatever address the agent typed, typos
// included. Any other unverified source (agent_called, self_claimed, sms_participant, …)
// is verified the same way on a live principal turn (#2515): the principal is vouching
// for it right now, directly or through a synchronous delegation. Outside one it is
// refused, and the refusal says how the principal can verify it.
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
import { deriveIdentity, derivationSources } from '../../../../src/contacts/phone-family-derivation.js';
import {
  candidatesError,
  distinctFromToken,
  parseDistinctFrom,
  takenError,
  uncoveredCandidates,
} from '../../../../src/skills/_shared/duplicate-refusal.js';
import { structuralContactRefusal } from '../../../../src/skills/_shared/structural-contact-guard.js';
import { identifierHasSource, unsourcedIdentifierError } from '../../../../src/skills/_shared/identifier-source.js';
import { isLivePrincipalTurn } from '../../../../src/contacts/principal.js';

const NOT_LINKED = 'Nothing was linked.';
const NOT_VERIFIED = 'Nothing was verified.';
const NEXT_SAME_NUMBER =
  'If this number belongs to both, call contact-link-identity again with distinct_from listing every ID above.';
const NEXT =
  'Check the address: it resembles theirs. If it is right, call contact-link-identity again with distinct_from listing every ID above.';
// "The console" alone is ambiguous: the principal may be talking to Curia in the console's chat.
const NEEDS_PRINCIPAL =
  'That address is already on this contact, unverified, and only the principal can vouch for it. ' +
  'Nothing changed. The principal can verify it by asking Curia directly in a live conversation, ' +
  "or in the contact's identity editor in the console's Contacts screen.";

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

/** The provenance check (#2061): a refusal, or null when the identifier has a source. */
async function unsourcedRefusal(ctx: ToolContext, channel: string, identifier: string, action: string): Promise<string | null> {
  if (await identifierHasSource(ctx, channel, identifier)) return null;
  ctx.log.info({ channel }, 'contact-link-identity: refused — identifier has no source (#2061)');
  return unsourcedIdentifierError(channel, action);
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
        // Who vouches for it: an agent, for an address an agent typed on a first-time send;
        // the principal, for any other source, but only while they are giving the
        // instruction (#2515). A woken, scheduled or bullpen task has principal lineage at
        // most, which is not enough: the same line the `elevated` gate draws (ADR-017),
        // including its refusal of a woken task even if a live-turn flag leaked onto it.
        const principalDirected = isLivePrincipalTurn(ctx.liveTurn, ctx.taskMetadata)
          && ctx.taskMetadata?.['wakeContext'] === undefined;
        if (existing.source === 'outbound_recipient' || principalDirected) {
          // Verifying is the risky step: the gateway records an address as typed, and an
          // address found by an agent can be a near miss of someone else's. Run the check
          // a new address gets first, and require it to have a source in the conversation.
          const restateRefusal = await duplicateRefusal(
            ctx,
            ctx.contactService,
            { contactId: contact_id, channel, identifier: normalized.identifier },
            distinctFrom.tokens,
            NOT_VERIFIED,
          );
          if (restateRefusal) return { success: false, error: restateRefusal };
          const restateUnsourced = await unsourcedRefusal(ctx, channel, normalized.identifier, NOT_VERIFIED);
          if (restateUnsourced) return { success: false, error: restateUnsourced };
          const verified = await ctx.contactService.verifyIdentity(existing.id);
          ctx.log.info(
            { identityId: existing.id, contactId: contact_id, source: existing.source, principalDirected },
            'contact-link-identity: re-stated unverified address verified (#2041, #2515)',
          );
          return { success: true, data: { identity_id: verified.id, verified: verified.verified, already_linked: true } };
        }
        ctx.log.info(
          { identityId: existing.id, contactId: contact_id, source: existing.source },
          'contact-link-identity: refused — unverified address re-stated outside a live principal turn (#2515)',
        );
        return { success: false, error: NEEDS_PRINCIPAL };
      }

      // The number is already verified on a sibling channel of this contact: derive it.
      const source = derivationSources(target.contact, target.identities, channel, normalized.identifier)[0];
      if (source) {
        const derived = await deriveIdentity(ctx.contactService, {
          contact: target.contact,
          channel,
          source,
          isDistinct: (candidate) => distinctFrom.tokens.has(distinctFromToken(candidate).toLowerCase()),
          ...(label ? { label } : {}),
        });
        if (!derived.ok) {
          const taken = derived.check.taken[0];
          if (taken) return { success: false, error: takenError(taken, NOT_LINKED) };
          ctx.log.info({ candidates: derived.check.candidates.length }, 'contact-link-identity: derivation refused — likely duplicate (#2447)');
          return { success: false, error: candidatesError(derived.check.candidates, NOT_LINKED, NEXT_SAME_NUMBER) };
        }
        ctx.log.info(
          { identityId: derived.identity.id, contactId: contact_id, channel, sourceChannel: source.channel },
          'contact-link-identity: linked as derived from a verified number on the contact (#2447)',
        );
        return {
          success: true,
          data: { identity_id: derived.identity.id, verified: true, already_linked: false, derived_from: source.channel },
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
      const unsourced = await unsourcedRefusal(ctx, channel, normalized.identifier, NOT_LINKED);
      if (unsourced) return { success: false, error: unsourced };

      ctx.log.info({ contact_id, channel }, 'Linking identity to contact');
      const identity = await ctx.contactService.linkIdentity({
        contactId: contact_id,
        channel,
        channelIdentifier: normalized.identifier,
        label: label ?? undefined,
        source: 'agent_stated',
        verified: true,
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
