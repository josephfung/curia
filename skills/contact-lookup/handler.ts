// handler.ts — contact-lookup skill implementation.
//
// Looks up contacts by name, role, or channel identifier.
// The `by` field determines the search strategy:
//   - "name": case-insensitive name match via findContactByName()
//   - "role": exact role match via findContactByRole()
//   - "channel": resolves by "channel:identifier" via resolveByChannelIdentity()
//
// This skill uses contactService, which is a universal service.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';

/** Valid lookup strategies */
const VALID_BY_VALUES = new Set(['name', 'role', 'channel']);

export class ContactLookupHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const { query, by } = ctx.input as {
      query?: string;
      by?: string;
    };

    // Validate required inputs
    if (!query || typeof query !== 'string') {
      return { success: false, error: 'Missing required input: query (string)' };
    }
    if (!by || typeof by !== 'string') {
      return { success: false, error: 'Missing required input: by (string)' };
    }
    if (!VALID_BY_VALUES.has(by)) {
      return { success: false, error: `Invalid lookup type: "${by}". Must be one of: name, role, channel` };
    }

    // Input length limits — prevent oversized payloads reaching the DB
    if (query.length > 500) {
      return { success: false, error: 'Query must be 500 characters or fewer' };
    }

    // Infrastructure skills need contactService
    if (!ctx.contactService) {
      return {
        success: false,
        error: 'contact-lookup skill requires contactService is a universal service — check ExecutionLayer configuration.',
      };
    }

    ctx.log.info({ query, by }, 'Looking up contact');

    try {
      if (by === 'name') {
        const contacts = await ctx.contactService.findContactByName(query);
        // Enrich each contact with their channel identities so the coordinator
        // can see email addresses, phone numbers, etc. without a second lookup.
        const enriched = await Promise.all(contacts.map(c => enrichContact(ctx, c)));
        return {
          success: true,
          data: {
            contacts: enriched,
            count: contacts.length,
          },
        };
      }

      if (by === 'role') {
        const contacts = await ctx.contactService.findContactByRole(query);
        const enriched = await Promise.all(contacts.map(c => enrichContact(ctx, c)));
        return {
          success: true,
          data: {
            contacts: enriched,
            count: contacts.length,
          },
        };
      }

      // by === 'channel': parse query as "channel:identifier"
      const colonIndex = query.indexOf(':');
      if (colonIndex === -1) {
        return {
          success: false,
          error: 'Channel lookup query must be in format "channel:identifier" (e.g., "email:jenna@acme.com")',
        };
      }

      const channel = query.slice(0, colonIndex);
      const identifier = query.slice(colonIndex + 1);

      if (!channel || !identifier) {
        return {
          success: false,
          error: 'Channel lookup query must have both channel and identifier (e.g., "email:jenna@acme.com")',
        };
      }

      const resolved = await ctx.contactService.resolveByChannelIdentity(channel, identifier);
      if (!resolved) {
        return {
          success: true,
          data: { contacts: [], count: 0 },
        };
      }

      return {
        success: true,
        data: {
          contacts: [{
            contact_id: resolved.contactId,
            display_name: resolved.displayName,
            role: resolved.role,
            kg_node_id: resolved.kgNodeId,
            verified: resolved.verified,
          }],
          count: 1,
        },
      };
    } catch (err) {
      ctx.log.error({ err, query, by }, 'Contact lookup failed');
      return { success: false, error: 'Contact lookup failed. See logs for details.' };
    }
  }
}

/** Enrich a contact with its channel identities */
async function enrichContact(
  ctx: SkillContext,
  contact: { id: string; displayName: string; role: string | null; status: string; kgNodeId: string | null },
) {
  const summary = contactToSummary(contact);
  try {
    const data = await ctx.contactService!.getContactWithIdentities(contact.id);
    if (data) {
      return {
        ...summary,
        identities: data.identities.map(i => ({
          id: i.id,
          channel: i.channel,
          identifier: i.channelIdentifier,
          label: i.label,
          verified: i.verified,
        })),
      };
    }
    // getContactWithIdentities returned null — could be a stale ID, a referential
    // integrity gap, or a contact that genuinely has no identities. Log so it's
    // distinguishable from the error case or a normal empty-identities result.
    ctx.log.debug({ contactId: contact.id }, 'getContactWithIdentities returned null — contact may have no identities registered');
  } catch (err) {
    // Best effort — return without identities if lookup fails, but log so it's detectable
    ctx.log.warn({ err, contactId: contact.id }, 'Failed to enrich contact with identities');
  }
  return { ...summary, identities: [] };
}

/** Convert a Contact to a summary object for the skill output */
function contactToSummary(contact: { id: string; displayName: string; role: string | null; status: string; kgNodeId: string | null }) {
  return {
    contact_id: contact.id,
    display_name: contact.displayName,
    role: contact.role,
    status: contact.status,
    kg_node_id: contact.kgNodeId,
  };
}
