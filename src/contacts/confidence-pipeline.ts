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

import type { Logger } from '../logger.js';
import type { ContactService } from './contact-service.js';
import { computeConfidence } from './confidence-scorer.js';

export type ConfidenceSignal =
  | { type: 'message_seen'; count?: number }
  | { type: 'message_sent'; count?: number }
  | { type: 'trust_grant' }
  | { type: 'pairing_confirmed' };

export class ConfidencePipeline {
  constructor(
    private contactService: ContactService,
    private logger?: Logger,
  ) {}

  /**
   * Apply a scoring signal and recompute contact_confidence.
   *
   * For message signals, increments the relevant counter and (for inbound)
   * updates last_seen_at. For trust_grant and pairing_confirmed, the
   * underlying data has already been updated by the caller — we just
   * recompute the score.
   *
   * Skips principal contacts (systemRole = 'principal') — their confidence is hardcoded to 1.0
   * in ContactResolver.
   *
   * Returns the new confidence value (or 0 if skipped).
   */
  async incrementalUpdate(contactId: string, signal: ConfidenceSignal): Promise<number> {
    const contact = await this.contactService.getContact(contactId);
    if (!contact) {
      this.logger?.debug({ contactId }, 'confidence-pipeline: contact not found — skipping');
      return 0;
    }

    // Skip principal contacts — confidence is hardcoded in ContactResolver
    if (contact.systemRole === 'principal') return 1.0; // Principal confidence is hardcoded in ContactResolver

    const count = ('count' in signal ? signal.count : undefined) ?? 1;
    if (!Number.isInteger(count) || count < 1) {
      this.logger?.warn({ contactId, count }, 'confidence-pipeline: non-positive or non-integer count — skipping (likely a caller bug)');
      return 0;
    }

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
        // No stat updates — the caller already modified the contact's tier or
        // created the verified identity. We just recompute the score.
        break;
    }

    // Fetch identities for verification signals
    const result = await this.contactService.getContactWithIdentities(contactId);
    if (!result) {
      this.logger?.warn({ contactId }, 'confidence-pipeline: getContactWithIdentities returned null after getContact succeeded — possible data inconsistency');
      return 0;
    }
    const { identities } = result;

    // Compute the new confidence from the *post-update* state.
    // For message signals, add the delta to the stored count before computing.
    const newConfidence = computeConfidence({
      inboundMessageCount: contact.inboundMessageCount + inboundDelta,
      outboundMessageCount: contact.outboundMessageCount + outboundDelta,
      lastSeenAt: lastSeenAt ?? contact.lastSeenAt,
      tier: contact.tier,
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
    return newConfidence;
  }

  /**
   * Recompute contact_confidence from stored state. Idempotent.
   * Does not modify message counts or lastSeenAt — only updates contact_confidence.
   */
  async fullRecompute(contactId: string): Promise<number> {
    const result = await this.contactService.getContactWithIdentities(contactId);
    if (!result) {
      this.logger?.debug({ contactId }, 'confidence-pipeline: contact not found for recompute — skipping');
      return 0;
    }
    const { contact, identities } = result;

    // Skip principal
    if (contact.systemRole === 'principal') return 1.0;

    const newConfidence = computeConfidence({
      inboundMessageCount: contact.inboundMessageCount,
      outboundMessageCount: contact.outboundMessageCount,
      lastSeenAt: contact.lastSeenAt,
      tier: contact.tier,
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
  /**
   * Recompute confidence for every contact. Per-contact failures are caught and logged
   * rather than aborting the whole pass, but the failed count is returned (not just
   * swallowed) so callers — e.g. the one-shot rederive script — can surface partial
   * failure in their exit code instead of reporting a clean success.
   */
  async fullRecomputeAll(): Promise<{ recomputed: number; failed: number }> {
    const contacts = await this.contactService.listContacts();
    let recomputed = 0;
    let failed = 0;
    for (const contact of contacts) {
      try {
        await this.fullRecompute(contact.id);
        recomputed++;
      } catch (err) {
        failed++;
        this.logger?.error(
          { err, contactId: contact.id },
          'fullRecomputeAll: failed to recompute confidence for contact — skipping',
        );
      }
    }
    if (failed > 0) {
      this.logger?.warn(
        { total: contacts.length, succeeded: recomputed, failed },
        'fullRecomputeAll: completed with errors',
      );
    }
    return { recomputed, failed };
  }
}
