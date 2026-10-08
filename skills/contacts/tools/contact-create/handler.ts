// handler.ts — contact-create skill implementation.
//
// Creates a new contact and optionally links channel identities (email, phone,
// signal, telegram). Automatically creates a knowledge graph person node via
// the ContactService.
//
// Source is `agent_created`: an agent supplied the identifier, after a duplicate
// check. That source is auto-verified so a following send-by-reference can
// deliver. It does not mean the principal confirmed the address (#2041, ADR-047).
//
// This skill uses contactService, which is a universal service.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import {
  isConfirmNew,
  outreachDuplicateError,
} from '../../../../src/contacts/outreach-duplicates.js';

// Channel names that this skill accepts as optional inputs.
// Each maps to a channel type used by linkIdentity().
const CHANNEL_INPUTS = ['email', 'phone', 'signal', 'telegram'] as const;

export class ContactCreateHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const input = ctx.input && typeof ctx.input === 'object' ? (ctx.input as Record<string, unknown>) : {};
    const { name, role, notes, email, phone, signal, telegram, confirm_new: confirmNew } = input as {
      name?: string;
      role?: string;
      notes?: string;
      email?: string;
      phone?: string;
      signal?: string;
      telegram?: string;
      confirm_new?: unknown;
    };

    // Validate required inputs
    if (!name || typeof name !== 'string') {
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
    const channelValues: Record<string, string | undefined> = { email, phone, signal, telegram };
    for (const ch of CHANNEL_INPUTS) {
      const val = channelValues[ch];
      if (val && val.length > 500) {
        return { success: false, error: `${ch} identifier must be 500 characters or fewer` };
      }
    }

    // contactService is a universal service — always injected by ExecutionLayer
    if (!ctx.contactService) {
      return {
        success: false,
        error: 'contact-create: contactService not available — this is a universal service, check ExecutionLayer configuration.',
      };
    }

    const identifiers = CHANNEL_INPUTS.flatMap((channel) => {
      const identifier = channelValues[channel];
      return identifier && typeof identifier === 'string' && identifier.trim()
        ? [{ channel, identifier: identifier.trim() }]
        : [];
    });

    let duplicates;
    try {
      duplicates = await ctx.contactService.findOutreachDuplicates({ displayName: name, identifiers });
    } catch (err) {
      ctx.log.error({ err, name }, 'contact-create: duplicate check failed');
      return { success: false, error: 'Failed to check for an existing contact. Nothing was created.' };
    }
    // An exact address match is the same person. A near-miss waits for confirm_new.
    if (duplicates.exact.length > 0 || (duplicates.likely.length > 0 && !isConfirmNew(confirmNew))) {
      return { success: false, error: outreachDuplicateError(duplicates, 'created') };
    }

    ctx.log.info({ name, role }, 'Creating contact');

    try {
      // Create the contact — this auto-creates a KG person node if entityMemory is available.
      // agent_created, not ceo_stated: an agent typed this (#2041).
      const contact = await ctx.contactService.createContact({
        displayName: name,
        role: role ?? undefined,
        notes: notes ?? undefined,
        source: 'agent_created',
      });

      // Link any provided channel identities
      let identitiesAdded = 0;

      for (const { channel, identifier } of identifiers) {
        await ctx.contactService.linkIdentity({
          contactId: contact.id,
          channel,
          channelIdentifier: identifier,
          source: 'agent_created',
        });
        identitiesAdded++;
      }

      ctx.log.info(
        { contactId: contact.id, identitiesAdded },
        'Contact created successfully',
      );

      return {
        success: true,
        data: {
          contact_id: contact.id,
          display_name: contact.displayName,
          role: contact.role,
          kg_node_id: contact.kgNodeId,
          identities_added: identitiesAdded,
          source: 'agent_created',
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, name }, 'Failed to create contact');
      return { success: false, error: `Failed to create contact: ${message}` };
    }
  }
}
