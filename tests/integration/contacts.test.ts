// tests/integration/contacts.test.ts
//
// Integration tests for the Contacts system (ContactService + ContactResolver).
// Requires a running Postgres with migrations 001-005 applied.
// Skips gracefully when DATABASE_URL is not set (e.g. in CI without pgvector).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { ContactService } from '../../src/contacts/contact-service.js';
import { ContactResolver } from '../../src/contacts/contact-resolver.js';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { createLogger } from '../../src/logger.js';
import type { Logger } from '../../src/logger.js';
import { DedupService } from '../../src/contacts/dedup-service.js';

const { Pool } = pg;

// Skip the entire suite if DATABASE_URL is not set — no database available
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('Contacts Integration', () => {
  let pool: pg.Pool;
  let contactService: ContactService;
  let resolver: ContactResolver;
  let entityMemory: EntityMemory;
  // logger hoisted so findDuplicates describe block can use it when constructing a fresh svc
  let logger: Logger;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    logger = createLogger('error');
    const embeddingService = EmbeddingService.createForTesting();
    const kgStore = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, logger);
    const validator = new MemoryValidator(kgStore, embeddingService);
    entityMemory = new EntityMemory(kgStore, validator, embeddingService);
    contactService = ContactService.createWithPostgres(pool, entityMemory, logger);
    resolver = new ContactResolver(contactService, entityMemory, undefined, logger);

    // Verify contacts tables exist — will throw if migrations haven't been applied
    await pool.query('SELECT 1 FROM contacts LIMIT 0');
  });

  afterAll(async () => {
    // Clean up test data in dependency order (FK constraints: identities before contacts,
    // auth overrides before contacts, KG edges before KG nodes)
    await pool.query('DELETE FROM contact_auth_overrides');
    await pool.query('DELETE FROM contact_channel_identities');
    await pool.query('DELETE FROM contacts');
    // Clean up KG nodes created by auto-linking during contact creation
    await pool.query('DELETE FROM kg_edges');
    await pool.query('DELETE FROM kg_nodes');
    await pool.end();
  });

  it('creates a contact with auto-linked KG node', async () => {
    const contact = await contactService.createContact({
      displayName: 'Integration Test Person',
      role: 'Advisor',
      source: 'integration-test',
    });
    expect(contact.id).toBeDefined();
    expect(contact.displayName).toBe('Integration Test Person');
    expect(contact.role).toBe('Advisor');
    // entityMemory is wired in, so a KG person node should be auto-created
    expect(contact.kgNodeId).toBeDefined();
  });

  it('links a channel identity and resolves it', async () => {
    const contact = await contactService.createContact({
      displayName: 'Resolver Test',
      role: 'CTO',
      source: 'integration-test',
    });
    await contactService.linkIdentity({
      contactId: contact.id,
      channel: 'email',
      channelIdentifier: 'resolver-test@example.com',
      source: 'ceo_stated',
    });

    const resolved = await contactService.resolveByChannelIdentity('email', 'resolver-test@example.com');
    expect(resolved).toBeDefined();
    expect(resolved!.displayName).toBe('Resolver Test');
    expect(resolved!.role).toBe('CTO');
    // ceo_stated is in AUTO_VERIFIED_SOURCES, so verified should be true
    expect(resolved!.verified).toBe(true);
  });

  it('finds contacts by name case-insensitively', async () => {
    await contactService.createContact({
      displayName: 'Case Test Person',
      source: 'integration-test',
    });
    // Query with all-lowercase — should still match the mixed-case display name
    const results = await contactService.findContactByName('case test person');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(c => c.displayName === 'Case Test Person')).toBe(true);
  });

  it('resolves unknown sender as null', async () => {
    const result = await contactService.resolveByChannelIdentity('telegram', 'nonexistent-id');
    expect(result).toBeNull();
  });

  it('full flow: create → link → resolve with KG enrichment', async () => {
    const contact = await contactService.createContact({
      displayName: 'Full Flow Test',
      role: 'CFO',
      source: 'integration-test',
    });
    await contactService.linkIdentity({
      contactId: contact.id,
      channel: 'signal',
      channelIdentifier: '+15550001234',
      source: 'ceo_stated',
    });

    // Store a KG fact on the auto-created person node so we can verify enrichment
    if (contact.kgNodeId) {
      await entityMemory.storeFact({
        entityNodeId: contact.kgNodeId,
        label: 'Full Flow Test manages the annual budget',
        source: 'integration-test',
      });
    }

    // ContactResolver.resolve does DB lookup + KG enrichment in one call
    const result = await resolver.resolve('signal', '+15550001234');
    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.displayName).toBe('Full Flow Test');
      expect(result.role).toBe('CFO');
      expect(result.verified).toBe(true);
      // knowledgeSummary should include the fact we stored above
      expect(result.knowledgeSummary).toContain('annual budget');
    }
  });

  describe('contact merge', () => {
    it('merges two contacts: secondary deleted, primary has union of identities', async () => {
      const primary = await contactService.createContact({
        displayName: 'Jenna Torres',
        role: 'CFO',
        source: 'ceo_stated',
        status: 'confirmed',
      });
      const secondary = await contactService.createContact({
        displayName: 'J. Torres',
        role: null,
        source: 'email_participant',
        status: 'provisional',
      });
      await contactService.linkIdentity({
        contactId: primary.id,
        channel: 'email',
        channelIdentifier: 'jenna.torres@acme.com',
        source: 'ceo_stated',
      });
      await contactService.linkIdentity({
        contactId: secondary.id,
        channel: 'email',
        channelIdentifier: 'j.torres@acme.com',
        source: 'email_participant',
      });

      const result = await contactService.mergeContacts(primary.id, secondary.id, false);

      expect(result.dryRun).toBe(false);
      expect(result.primaryContactId).toBe(primary.id);

      // Secondary should be gone
      const gone = await contactService.getContact(secondary.id);
      expect(gone).toBeUndefined();

      // Primary should have both emails
      const withIdentities = await contactService.getContactWithIdentities(primary.id);
      const emails = withIdentities?.identities.map(i => i.channelIdentifier) ?? [];
      expect(emails).toContain('jenna.torres@acme.com');
      expect(emails).toContain('j.torres@acme.com');

      // Golden record: role from primary, status most-restrictive (provisional > confirmed)
      const updated = await contactService.getContact(primary.id);
      expect(updated?.role).toBe('CFO');
      expect(updated?.status).toBe('provisional'); // secondary was provisional
    });

    it('dry_run does not modify any contacts', async () => {
      const primary = await contactService.createContact({
        displayName: 'Alice Smith',
        role: 'CTO',
        source: 'ceo_stated',
        status: 'confirmed',
      });
      const secondary = await contactService.createContact({
        displayName: 'Alice Smith',
        role: null,
        source: 'email_participant',
        status: 'confirmed',
      });

      const proposal = await contactService.mergeContacts(primary.id, secondary.id, true);

      expect(proposal.dryRun).toBe(true);
      expect(proposal.goldenRecord.displayName).toBe('Alice Smith');

      // Both contacts must still exist — dry run is read-only
      const primaryStillExists = await contactService.getContact(primary.id);
      const secondaryStillExists = await contactService.getContact(secondary.id);
      expect(primaryStillExists).toBeDefined();
      expect(secondaryStillExists).toBeDefined();
    });

    it('auth overrides are consolidated (primary wins on conflict)', async () => {
      const primary = await contactService.createContact({
        displayName: 'Bob',
        source: 'ceo_stated',
        status: 'confirmed',
      });
      const secondary = await contactService.createContact({
        displayName: 'Bob Smith',
        source: 'email_participant',
        status: 'confirmed',
      });

      // Primary explicitly grants view_financial_reports; secondary denies it.
      // After merge, primary's grant must survive (primary wins on conflict).
      await contactService.grantPermission(primary.id, 'view_financial_reports', true, 'ceo');
      await contactService.grantPermission(secondary.id, 'view_financial_reports', false, 'ceo');
      // Secondary has a unique override not present on primary — it should be preserved.
      await contactService.grantPermission(secondary.id, 'schedule_meetings', true, 'ceo');

      await contactService.mergeContacts(primary.id, secondary.id, false);

      const overrides = await contactService.getAuthOverrides(primary.id);
      const viewReportsOverride = overrides.find((o: { permission: string }) => o.permission === 'view_financial_reports');
      const schedulingOverride = overrides.find((o: { permission: string }) => o.permission === 'schedule_meetings');

      expect(viewReportsOverride?.granted).toBe(true);  // primary wins on conflict
      expect(schedulingOverride?.granted).toBe(true);   // secondary's unique override preserved
    });
  });

  describe('findDuplicates', () => {
    it('returns probable duplicate pair when contacts share an email', async () => {
      const dedupService = new DedupService();
      // Construct a fresh service with DedupService wired — the outer contactService
      // has no DedupService so findDuplicates() would always return [].
      const svc = ContactService.createWithPostgres(pool, entityMemory, logger, { dedupService });

      const a = await svc.createContact({
        displayName: 'Carol White',
        source: 'ceo_stated',
        status: 'confirmed',
      });
      await svc.linkIdentity({
        contactId: a.id,
        channel: 'email',
        channelIdentifier: 'carol.white@example.com',
        source: 'ceo_stated',
      });
      const b = await svc.createContact({
        displayName: 'C. White',
        source: 'email_participant',
        status: 'provisional',
      });
      await svc.linkIdentity({
        contactId: b.id,
        channel: 'email',
        channelIdentifier: 'carol.white@example.com',
        source: 'email_participant',
      });

      const pairs = await svc.findDuplicates();
      // Find the pair that contains both contacts we just created
      const found = pairs.find(p =>
        (p.contactA.id === a.id && p.contactB.id === b.id) ||
        (p.contactA.id === b.id && p.contactB.id === a.id)
      );
      expect(found).toBeDefined();
      expect(found?.confidence).toBe('certain'); // shared email channel identifier → certain
    });
  });
});
