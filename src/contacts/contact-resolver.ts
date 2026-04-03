// src/contacts/contact-resolver.ts
//
// ContactResolver: resolves inbound message senders to known contacts, enriching
// with KG facts for the coordinator's prompt context.
//
// Runs in the dispatch layer on every inbound message, BEFORE the coordinator sees it.
// Resolution is deterministic — a simple indexed DB query, no LLM involved.

import type { ContactService } from './contact-service.js';
import type { AuthorizationService } from './authorization.js';
import type { EntityMemory } from '../memory/entity-memory.js';
import type { Logger } from '../logger.js';
import type { AuthorizationResult, InboundSenderContext } from './types.js';

/**
 * Resolves inbound message senders to known contacts.
 * Runs in the dispatch layer on every inbound message, BEFORE the coordinator sees it.
 * Resolution is deterministic — a simple indexed DB query, no LLM involved.
 */
export class ContactResolver {
  constructor(
    private contactService: ContactService,
    private entityMemory: EntityMemory | undefined,
    private authService: AuthorizationService | undefined,
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
    // CLI and smoke-test are always the primary user (CEO).
    // Look up the real CEO contact in the DB so downstream skills (calendar, entity-context)
    // get a proper UUID — passing the synthetic 'primary-user' string to UUID columns causes
    // PostgreSQL errors. Fall back to the synthetic ID only if no CEO contact exists yet.
    if (channel === 'cli' || channel === 'smoke-test') {
      try {
        const ceoContacts = await this.contactService.findContactByRole('ceo');
        const ceo = ceoContacts[0];
        if (ceo) {
          return {
            resolved: true,
            contactId: ceo.id,
            displayName: ceo.displayName,
            role: 'ceo',
            status: 'confirmed' as const,
            verified: true,
            kgNodeId: ceo.kgNodeId,
            knowledgeSummary: '',
            authorization: null,
          };
        }
        // DB call succeeded but no CEO contact row exists yet (fresh install before seeding).
        // Skills that need a real UUID will return empty results — best we can do.
        this.logger.warn({ channel }, 'contact-resolver: no CEO contact found in DB, using synthetic primary-user ID');
      } catch (err) {
        // Only suppress errors that look like DB-layer errors (pg driver attaches a .code).
        // Anything else (TypeError, programming bug in findContactByRole, etc.) should propagate
        // so it is not silently misclassified as a transient DB blip.
        const isDbError = err !== null && typeof err === 'object' && 'code' in err;
        if (!isDbError) {
          throw err;
        }
        // DB error: log at error level so Sentry captures it, then fall through to synthetic ID.
        // The CLI continuing to work in degraded mode is acceptable; operators still need to know.
        this.logger.error({ err }, 'contact-resolver: DB error looking up CEO contact — falling back to synthetic ID');
      }
      return {
        resolved: true,
        contactId: 'primary-user',
        displayName: 'CEO',
        role: 'ceo',
        status: 'confirmed' as const,
        verified: true,
        kgNodeId: null,
        knowledgeSummary: '',
        authorization: null,
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

    // Evaluate authorization if auth service is available.
    // Isolated in its own try/catch: a DB failure here must not lose the identity
    // resolution above. The coordinator still sees who the sender is — just without
    // permission context (authorization=null).
    let authorization: AuthorizationResult | null = null;
    if (this.authService) {
      try {
        const overrides = await this.contactService.getAuthOverrides(resolved.contactId);
        authorization = this.authService.evaluate({
          role: resolved.role,
          status: resolved.status ?? 'confirmed',
          channel,
          overrides,
        });
      } catch (err) {
        // Authorization eval failure should not lose identity resolution.
        // Log and continue with authorization=null — the coordinator still sees
        // who the sender is, just without permission context.
        this.logger.error(
          { err, contactId: resolved.contactId },
          'Authorization evaluation failed — proceeding without auth context',
        );
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
      status: resolved.status ?? 'confirmed',
      verified: resolved.verified,
      kgNodeId: resolved.kgNodeId,
      knowledgeSummary,
      authorization,
    };
  }
}
