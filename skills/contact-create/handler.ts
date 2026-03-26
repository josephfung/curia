// handler.ts — contact-create skill implementation.
//
// Creates a new contact and optionally links channel identities (email, phone,
// signal, telegram). Automatically creates a knowledge graph person node via
// the ContactService.
//
// This is an infrastructure skill — it requires contactService access.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

// Channel names that this skill accepts as optional inputs.
// Each maps to a channel type used by linkIdentity().
const CHANNEL_INPUTS = ['email', 'phone', 'signal', 'telegram'] as const;

export class ContactCreateHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { name, role, notes, email, phone, signal, telegram } = ctx.input as {
      name?: string;
      role?: string;
      notes?: string;
      email?: string;
      phone?: string;
      signal?: string;
      telegram?: string;
    };

    // Validate required inputs
    if (!name || typeof name !== 'string') {
      return { success: false, error: 'Missing required input: name (string)' };
    }

    // Infrastructure skills need contactService
    if (!ctx.contactService) {
      return {
        success: false,
        error: 'contact-create skill requires infrastructure access (contactService). Is infrastructure: true set in the manifest?',
      };
    }

    ctx.log.info({ name, role }, 'Creating contact');

    try {
      // Create the contact — this auto-creates a KG person node if entityMemory is available
      const contact = await ctx.contactService.createContact({
        displayName: name,
        role: role ?? undefined,
        notes: notes ?? undefined,
        source: 'ceo_stated',
      });

      // Link any provided channel identities
      const channelValues: Record<string, string | undefined> = { email, phone, signal, telegram };
      let identitiesAdded = 0;

      for (const channel of CHANNEL_INPUTS) {
        const identifier = channelValues[channel];
        if (identifier && typeof identifier === 'string') {
          await ctx.contactService.linkIdentity({
            contactId: contact.id,
            channel,
            channelIdentifier: identifier,
            source: 'ceo_stated',
          });
          identitiesAdded++;
        }
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
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, name }, 'Failed to create contact');
      return { success: false, error: `Failed to create contact: ${message}` };
    }
  }
}
