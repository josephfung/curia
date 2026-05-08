// src/contacts/confidence-pipeline.ts
//
// Orchestrator for contact confidence scoring. Reads contact state from
// ContactService, calls the pure computeConfidence() formula, and persists
// the result via updateScoringFields().
//
// Two update modes:
// - incrementalUpdate(): applies a delta to stored stats, then recomputes
// - fullRecompute(): reads stored stats and recomputes (idempotent)
//
// Both call the same formula — convergence is guaranteed by construction.

import type { ContactService } from './contact-service.js';
import { computeConfidence } from './confidence-scorer.js';

export type ConfidenceSignal =
  | { type: 'message_seen'; count?: number }
  | { type: 'message_sent'; count?: number }
  | { type: 'trust_grant' }
  | { type: 'pairing_confirmed' };

export class ConfidencePipeline {
  constructor(private contactService: ContactService) {}

  /**
   * Apply a scoring signal and recompute contact_confidence.
   *
   * For message signals, increments the relevant counter and (for inbound)
   * updates last_seen_at. For trust_grant and pairing_confirmed, the
   * underlying data has already been updated by the caller — we just
   * recompute the score.
   *
   * Skips CEO contacts (role = 'ceo') — their confidence is hardcoded to 1.0
   * in ContactResolver.
   */
  async incrementalUpdate(contactId: string, signal: ConfidenceSignal): Promise<void> {
    const contact = await this.contactService.getContact(contactId);
    if (!contact) return;

    // Skip CEO contacts — confidence is hardcoded in ContactResolver
    if (contact.role === 'ceo') return;

    const count = ('count' in signal ? signal.count : undefined) ?? 1;
    if (count < 1) return; // Guard against non-positive counts

    // Determine stat deltas based on signal type
    let inboundDelta = 0;
    let outboundDelta = 0;
    let lastSeenAt: Date | undefined;

    switch (signal.type) {
      case 'message_seen':
        inboundDelta = count;
        lastSeenAt = new Date();
        break;
      case 'message_sent':
        outboundDelta = count;
        // Does NOT update lastSeenAt — "last seen" means last inbound
        break;
      case 'trust_grant':
      case 'pairing_confirmed':
        // No stat updates — the caller already modified trust_level or
        // created the verified identity. We just recompute the score.
        break;
    }

    // Fetch identities for verification signals
    const result = await this.contactService.getContactWithIdentities(contactId);
    if (!result) return;
    const { identities } = result;

    // Compute the new confidence from the *post-update* state.
    // For message signals, add the delta to the stored count before computing.
    const newConfidence = computeConfidence({
      inboundMessageCount: contact.inboundMessageCount + inboundDelta,
      outboundMessageCount: contact.outboundMessageCount + outboundDelta,
      lastSeenAt: lastSeenAt ?? contact.lastSeenAt,
      trustLevel: contact.trustLevel,
      verifiedIdentityCount: identities.filter(i => i.verified).length,
      hasCeoStatedIdentity: identities.some(i => i.source === 'ceo_stated'),
      now: new Date(),
    });

    // Persist — uses atomic increments for counts
    await this.contactService.updateScoringFields(contactId, {
      inboundMessageCountDelta: inboundDelta,
      outboundMessageCountDelta: outboundDelta,
      contactConfidence: newConfidence,
      lastSeenAt,
    });
  }

  /**
   * Recompute contact_confidence from stored state. Idempotent.
   * Does not modify message counts or lastSeenAt — only updates contact_confidence.
   */
  async fullRecompute(contactId: string): Promise<number> {
    const result = await this.contactService.getContactWithIdentities(contactId);
    if (!result) return 0;
    const { contact, identities } = result;

    // Skip CEO
    if (contact.role === 'ceo') return 1.0;

    const newConfidence = computeConfidence({
      inboundMessageCount: contact.inboundMessageCount,
      outboundMessageCount: contact.outboundMessageCount,
      lastSeenAt: contact.lastSeenAt,
      trustLevel: contact.trustLevel,
      verifiedIdentityCount: identities.filter(i => i.verified).length,
      hasCeoStatedIdentity: identities.some(i => i.source === 'ceo_stated'),
      now: new Date(),
    });

    // Only update confidence — don't touch counts or lastSeenAt
    await this.contactService.updateScoringFields(contactId, {
      contactConfidence: newConfidence,
    });

    return newConfidence;
  }

  /**
   * Recompute all contacts. Returns the number of contacts processed.
   * Intended for backfill scripts and formula-tuning — not the hot path.
   */
  async fullRecomputeAll(): Promise<number> {
    const contacts = await this.contactService.listContacts();
    let count = 0;
    for (const contact of contacts) {
      await this.fullRecompute(contact.id);
      count++;
    }
    return count;
  }
}
