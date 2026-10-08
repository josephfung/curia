// handler.ts — contact-create skill implementation.
//
// Creates a new contact and optionally links channel identities (email, phone,
// signal, sms, slack, telegram). Automatically creates a knowledge graph person node
// via the ContactService.
//
// Cold outreach starts here (#2041). The send skills take a contact ID, so an agent
// adds someone new with this skill and sends to the contact_id it returns. Nothing
// is written until the duplicate check passes:
//   - an address another contact holds is refused;
//   - a contact that may be the same person (similar address, same number on another
//     channel, same name) is listed until the agent names it in distinct_from.
// Identities are recorded as agent_stated: an agent typed them, so they are not
// presented as the principal's own statement (ceo_stated).
//
// This skill uses contactService, which is a universal service.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import type { Contact, DuplicateCheck } from '../../../../src/contacts/types.js';
import { normalizeAgentIdentifier } from '../../../../src/contacts/agent-identifier.js';
import {
  candidatesError,
  parseDistinctFrom,
  takenError,
  uncoveredCandidates,
} from '../../../../src/skills/_shared/duplicate-refusal.js';

// Optional inputs, each linked as an identity on the channel of the same name.
const CHANNEL_INPUTS = ['email', 'phone', 'signal', 'sms', 'slack', 'telegram'] as const;

const NOT_CREATED = 'No contact was created.';
const NEXT =
  "If one of them is this person, use their contact ID instead (contact-link-identity adds a new address to it). " +
  'If you are sure this is someone new, call contact-create again with distinct_from listing every ID above.';

export class ContactCreateHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const input = ctx.input as Record<string, unknown>;
    const { name, role, notes } = input as { name?: string; role?: string; notes?: string };

    // Validate required inputs. A name that is only whitespace counts as missing: it
    // would sanitize to "Unknown" and match every contact already named that.
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return { success: false, error: 'Missing required input: name (string)' };
    }

    // Input length limits — prevent oversized payloads reaching the DB or LLM context
    if (name.length > 500) {
      return { success: false, error: 'Name must be 500 characters or fewer' };
    }
    if (role && role.length > 200) {
      return { success: false, error: 'Role must be 200 characters or fewer' };
    }
    if (notes && notes.length > 5000) {
      return { success: false, error: 'Notes must be 5000 characters or fewer' };
    }

    // Normalize every identifier before the duplicate check, so `(416) 555-0100`
    // finds a stored `+14165550100` and is stored in a shape the send skills reach.
    const identities: Array<{ channel: string; identifier: string }> = [];
    for (const channel of CHANNEL_INPUTS) {
      const raw = input[channel];
      if (raw === undefined || raw === null || raw === '') continue;
      if (typeof raw !== 'string') {
        return { success: false, error: `${channel} must be a string` };
      }
      if (raw.length > 500) {
        return { success: false, error: `${channel} identifier must be 500 characters or fewer` };
      }
      const normalized = normalizeAgentIdentifier(channel, raw);
      if (!normalized.ok) return { success: false, error: `${normalized.error} ${NOT_CREATED}` };
      identities.push({ channel, identifier: normalized.identifier });
    }

    const distinctFrom = parseDistinctFrom(input['distinct_from']);
    if (!distinctFrom.ok) return { success: false, error: distinctFrom.error };

    // contactService is a universal service — always injected by ExecutionLayer
    if (!ctx.contactService) {
      return {
        success: false,
        error: 'contact-create: contactService not available — this is a universal service, check ExecutionLayer configuration.',
      };
    }

    let check: DuplicateCheck;
    try {
      check = await ctx.contactService.findLikelyDuplicates({ displayName: name, identities });
    } catch (err) {
      // Fail closed: creating without the check is the transcription risk it exists for.
      ctx.log.error({ err }, 'contact-create: duplicate check failed — refusing (#2041)');
      return { success: false, error: `The duplicate check could not run. ${NOT_CREATED} Try again.` };
    }

    const taken = check.taken[0];
    if (taken) {
      ctx.log.info({ channel: taken.channel }, 'contact-create: refused — identifier held by another contact (#2041)');
      return { success: false, error: takenError(taken, NOT_CREATED) };
    }
    if (uncoveredCandidates(check.candidates, distinctFrom.tokens).length > 0) {
      ctx.log.info({ candidates: check.candidates.length }, 'contact-create: refused — likely duplicate (#2041)');
      return { success: false, error: candidatesError(check.candidates, NOT_CREATED, NEXT) };
    }

    ctx.log.info({ name, role, channels: identities.map((identity) => identity.channel) }, 'Creating contact');

    let created: { contact: Contact; kgNodeCreated: boolean };
    try {
      // Creates a KG person node too when entityMemory is available.
      created = await ctx.contactService.createContactWithKgOutcome({
        displayName: name,
        role: role ?? undefined,
        notes: notes ?? undefined,
        source: 'agent_stated',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, name }, 'Failed to create contact');
      return { success: false, error: `Failed to create contact: ${message}` };
    }
    const { contact, kgNodeCreated } = created;

    for (const identity of identities) {
      try {
        await ctx.contactService.linkIdentity({
          contactId: contact.id,
          channel: identity.channel,
          channelIdentifier: identity.identifier,
          source: 'agent_stated',
        });
      } catch (err) {
        // Leave nothing half-made: remove the contact this call created. Retire its KG
        // node only if this call minted it (an adopted node predates us; ADR-040).
        try {
          await ctx.contactService.deleteContact(contact.id, { archiveAnchoredNode: kgNodeCreated });
        } catch (cleanupErr) {
          ctx.log.error(
            { err: cleanupErr, orphanId: contact.id },
            'contact-create: could not remove the contact after a failed link — orphan left for cleanup',
          );
        }
        if ((err as { code?: string }).code === '23505') {
          // Another create won the address between the check and this link.
          ctx.log.info({ channel: identity.channel }, 'contact-create: identifier claimed concurrently — refused');
          return {
            success: false,
            error: `That ${identity.channel} address was just added to another contact. ${NOT_CREATED} Look the person up and use their contact ID.`,
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        ctx.log.error({ err, channel: identity.channel }, 'contact-create: failed to link identity');
        return { success: false, error: `Failed to create contact: ${message}` };
      }
    }

    ctx.log.info({ contactId: contact.id, identitiesAdded: identities.length }, 'Contact created successfully');

    return {
      success: true,
      data: {
        contact_id: contact.id,
        display_name: contact.displayName,
        role: contact.role,
        kg_node_id: contact.kgNodeId,
        identities_added: identities.length,
      },
    };
  }
}
