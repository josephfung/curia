// src/contacts/contact-resolver.ts
//
// ContactResolver: resolves inbound message senders to known contacts, enriching
// with KG facts for the coordinator's prompt context.
//
// Runs in the dispatch layer on every inbound message, BEFORE the coordinator sees it.
// Resolution is deterministic — a simple indexed DB query, no LLM involved.

import type { ContactService } from './contact-service.js';
import type { EntityMemory } from '../memory/entity-memory.js';
import type { Logger } from '../logger.js';
import type { InboundSenderContext } from './types.js';

/**
 * Resolves inbound message senders to known contacts.
 * Runs in the dispatch layer on every inbound message, BEFORE the coordinator sees it.
 * Resolution is deterministic — a simple indexed DB query, no LLM involved.
 */
export class ContactResolver {
  constructor(
    private contactService: ContactService,
    private entityMemory: EntityMemory | undefined,
    private logger: Logger,
  ) {}

  /**
   * Resolve a sender to a known contact.
   * Returns rich SenderContext (with KG facts) for known contacts,
   * or UnknownSenderContext for unrecognized senders.
   *
   * CLI and smoke-test channels always resolve as the primary user (CEO).
   */
  async resolve(channel: string, senderId: string): Promise<InboundSenderContext> {
    // CLI and smoke-test are always the primary user — no resolution needed
    if (channel === 'cli' || channel === 'smoke-test') {
      return {
        resolved: true,
        contactId: 'primary-user',
        displayName: 'CEO',
        role: 'ceo',
        verified: true,
        knowledgeSummary: '',
      };
    }

    const resolved = await this.contactService.resolveByChannelIdentity(channel, senderId);
    if (!resolved) {
      this.logger.info({ channel, senderId }, 'Unknown sender — no contact match');
      return { resolved: false, channel, senderId };
    }

    // Enrich with KG facts if available
    let knowledgeSummary = '';
    if (resolved.kgNodeId && this.entityMemory) {
      try {
        const knowledge = await this.entityMemory.query(resolved.kgNodeId);
        const factLines = knowledge.facts.map(f => `- ${f.label}`);
        const relLines = knowledge.relationships.map(r =>
          `- ${r.edge.type} → ${r.node.label}`
        );
        const lines = [...factLines, ...relLines];
        if (lines.length > 0) {
          knowledgeSummary = lines.join('\n');
        }
      } catch (err) {
        // KG enrichment is best-effort — don't fail resolution if the KG query errors
        this.logger.warn({ err, kgNodeId: resolved.kgNodeId }, 'Failed to enrich contact with KG facts');
      }
    }

    this.logger.info(
      { contactId: resolved.contactId, displayName: resolved.displayName, verified: resolved.verified },
      'Sender resolved to contact',
    );

    return {
      resolved: true,
      contactId: resolved.contactId,
      displayName: resolved.displayName,
      role: resolved.role,
      verified: resolved.verified,
      knowledgeSummary,
    };
  }
}
