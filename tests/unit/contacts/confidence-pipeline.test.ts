import { describe, it, expect, beforeEach } from 'vitest';
import { ContactService } from '../../../src/contacts/contact-service.js';
import { ConfidencePipeline } from '../../../src/contacts/confidence-pipeline.js';
import type { Contact } from '../../../src/contacts/types.js';

describe('ConfidencePipeline', () => {
  let service: ContactService;
  let pipeline: ConfidencePipeline;

  beforeEach(() => {
    service = ContactService.createInMemory();
    pipeline = new ConfidencePipeline(service);
  });

  async function createTestContact(overrides: { source?: string } = {}): Promise<Contact> {
    return service.createContact({
      displayName: 'Test Contact',
      source: overrides.source ?? 'email_participant',
    });
  }

  describe('incrementalUpdate — message_seen', () => {
    it('increments inbound count and updates lastSeenAt', async () => {
      const contact = await createTestContact();
      await pipeline.incrementalUpdate(contact.id, { type: 'message_seen' });

      const updated = await service.getContact(contact.id);
      expect(updated!.inboundMessageCount).toBe(1);
      expect(updated!.lastSeenAt).not.toBeNull();
      expect(updated!.contactConfidence).toBeGreaterThan(0);
    });

    it('respects count parameter for bulk import', async () => {
      const contact = await createTestContact();
      await pipeline.incrementalUpdate(contact.id, { type: 'message_seen', count: 15 });

      const updated = await service.getContact(contact.id);
      expect(updated!.inboundMessageCount).toBe(15);
    });

    it('returns the updated confidence value', async () => {
      const contact = await createTestContact();
      const result = await pipeline.incrementalUpdate(contact.id, { type: 'message_seen' });
      // message_seen with recency contribution should be > 0
      expect(typeof result).toBe('number');
      expect(result).toBeGreaterThan(0);
      // Must match the stored contactConfidence
      const updated = await service.getContact(contact.id);
      expect(result).toBeCloseTo(updated!.contactConfidence);
    });
  });

  describe('incrementalUpdate — message_sent', () => {
    it('increments outbound count but does not update lastSeenAt', async () => {
      const contact = await createTestContact();
      await pipeline.incrementalUpdate(contact.id, { type: 'message_sent' });

      const updated = await service.getContact(contact.id);
      expect(updated!.outboundMessageCount).toBe(1);
      expect(updated!.lastSeenAt).toBeNull();
      expect(updated!.contactConfidence).toBeGreaterThan(0);
    });

    it('respects count parameter', async () => {
      const contact = await createTestContact();
      await pipeline.incrementalUpdate(contact.id, { type: 'message_sent', count: 5 });

      const updated = await service.getContact(contact.id);
      expect(updated!.outboundMessageCount).toBe(5);
    });
  });

  describe('incrementalUpdate — trust_grant', () => {
    it('recomputes confidence with trust level signal', async () => {
      const contact = await createTestContact();
      await service.setTier(contact.id, 'trusted');
      await pipeline.incrementalUpdate(contact.id, { type: 'trust_grant' });

      const updated = await service.getContact(contact.id);
      expect(updated!.contactConfidence).toBeGreaterThan(0);
    });
  });

  describe('incrementalUpdate — pairing_confirmed', () => {
    it('recomputes confidence with verified identity signal', async () => {
      const contact = await createTestContact();
      await service.linkIdentity({
        contactId: contact.id,
        channel: 'email',
        channelIdentifier: 'test@example.com',
        source: 'email_participant',
      });
      await pipeline.incrementalUpdate(contact.id, { type: 'pairing_confirmed' });

      const updated = await service.getContact(contact.id);
      expect(updated!.contactConfidence).toBeGreaterThan(0);
    });
  });

  describe('fullRecompute', () => {
    it('produces same score as incremental path for identical history', async () => {
      const contact = await createTestContact();
      await pipeline.incrementalUpdate(contact.id, { type: 'message_seen', count: 5 });
      await pipeline.incrementalUpdate(contact.id, { type: 'message_sent', count: 3 });
      const afterIncremental = await service.getContact(contact.id);

      await pipeline.fullRecompute(contact.id);
      const afterRecompute = await service.getContact(contact.id);

      expect(afterRecompute!.contactConfidence).toBeCloseTo(afterIncremental!.contactConfidence);
    });

    it('is idempotent — running twice gives the same result', async () => {
      const contact = await createTestContact();
      await pipeline.incrementalUpdate(contact.id, { type: 'message_seen', count: 10 });

      await pipeline.fullRecompute(contact.id);
      const first = await service.getContact(contact.id);

      await pipeline.fullRecompute(contact.id);
      const second = await service.getContact(contact.id);

      // Use toBeCloseTo rather than toBe: the recency component uses `new Date()` for
      // decay calculation, so two calls milliseconds apart produce values that differ at
      // floating-point epsilon (e.g. 0.375 vs 0.3749999998). The scores are functionally
      // identical. We assert to 9 decimal places (tolerance 5e-10); 10 places (5e-11) was
      // too tight — observed jitter reached ~1.5e-10 and flaked CI. 9 places is still far
      // tighter than any meaningful confidence distinction.
      expect(second!.contactConfidence).toBeCloseTo(first!.contactConfidence, 9);
    });

    it('does not modify message counts or lastSeenAt', async () => {
      const contact = await createTestContact();
      await pipeline.incrementalUpdate(contact.id, { type: 'message_seen', count: 7 });
      const before = await service.getContact(contact.id);

      await pipeline.fullRecompute(contact.id);
      const after = await service.getContact(contact.id);

      expect(after!.inboundMessageCount).toBe(before!.inboundMessageCount);
      expect(after!.outboundMessageCount).toBe(before!.outboundMessageCount);
      expect(after!.lastSeenAt?.getTime()).toBe(before!.lastSeenAt?.getTime());
    });
  });

  describe('fullRecomputeAll', () => {
    it('recomputes all contacts and returns recomputed/failed counts', async () => {
      await createTestContact();
      await createTestContact();
      const result = await pipeline.fullRecomputeAll();
      expect(result).toEqual({ recomputed: 2, failed: 0 });
    });
  });

  describe('edge cases', () => {
    it('skips principal contacts (systemRole = principal)', async () => {
      // The pipeline now uses systemRole === 'principal' as the skip guard,
      // not role === 'ceo'. Use the private in-memory backend directly to set
      // systemRole — ContactService doesn't expose a public setSystemRole method
      // (it's set by bootstrap only), so we cast to access the backend.
      const ceo = await service.createContact({
        displayName: 'CEO',
        role: 'ceo',
        source: 'ceo_stated',
      });
      // Promote to principal so the pipeline skips it
      const backend = (service as unknown as { backend: { updateContact(c: Contact): Promise<void> } }).backend;
      await backend.updateContact({ ...ceo, systemRole: 'principal' });
      await pipeline.incrementalUpdate(ceo.id, { type: 'message_seen' });
      const after = await service.getContact(ceo.id);
      expect(after!.inboundMessageCount).toBe(0);
    });

    it('ignores unknown contactId', async () => {
      await pipeline.incrementalUpdate('nonexistent-id', { type: 'message_seen' });
    });
  });
});
