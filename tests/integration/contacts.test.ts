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
import { createLogger, createSilentLogger } from '../../src/logger.js';
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
    entityMemory = new EntityMemory(kgStore, validator, embeddingService, createSilentLogger());
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
      // Unique name: avoids collision with knowledge-graph.test.ts which also creates
      // "Integration Test Person" — upsertNode would share the node, breaking cleanup.
      displayName: 'Contacts-Only Test Person',
      role: 'Advisor',
      source: 'integration-test',
    });
    expect(contact.id).toBeDefined();
    expect(contact.displayName).toBe('Contacts-Only Test Person');
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
        tier: 'known',
      });
      const secondary = await contactService.createContact({
        displayName: 'J. Torres',
        role: null,
        source: 'email_participant',
        tier: 'unknown',
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

      // Golden record: role from primary; tier survivorship takes the MORE capable
      // tier when neither side is blocked (post-#955: known beats unknown). This is a
      // deliberate change from the old most-restrictive-status rule — a CEO grant is
      // never silently downgraded by a merge.
      const updated = await contactService.getContact(primary.id);
      expect(updated?.role).toBe('CFO');
      expect(updated?.tier).toBe('known'); // primary was known, more capable than secondary's unknown
    });

    it('dry_run does not modify any contacts', async () => {
      const primary = await contactService.createContact({
        displayName: 'Alice Smith',
        role: 'CTO',
        source: 'ceo_stated',
        tier: 'known',
      });
      const secondary = await contactService.createContact({
        displayName: 'Alice Smith',
        role: null,
        source: 'email_participant',
        tier: 'known',
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
        tier: 'known',
      });
      const secondary = await contactService.createContact({
        displayName: 'Bob Smith',
        source: 'email_participant',
        tier: 'known',
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
    it('returns certain duplicate pair for contacts with matching name variants', async () => {
      const dedupService = new DedupService();
      // Construct a fresh service with DedupService wired — the outer contactService
      // has no DedupService so findDuplicates() would always return [].
      const svc = ContactService.createWithPostgres(pool, entityMemory, logger, { dedupService });

      // "Carol White" produces the initial variant "c white".
      // "C. White" normalizes to "c white" — an exact match → certain (score 1.0).
      // No shared channel identity needed; name similarity alone drives this result.
      // (Linking the same email to two contacts would violate the unique constraint
      // on contact_channel_identities, so channel-overlap dedup is tested at the
      // DedupService unit level rather than here.)
      const a = await svc.createContact({
        displayName: 'Carol White',
        source: 'ceo_stated',
        tier: 'known',
      });
      const b = await svc.createContact({
        displayName: 'C. White',
        source: 'email_participant',
        tier: 'unknown',
      });

      const pairs = await svc.findDuplicates();
      // Find the pair that contains both contacts we just created
      const found = pairs.find(p =>
        (p.contactA.id === a.id && p.contactB.id === b.id) ||
        (p.contactA.id === b.id && p.contactB.id === a.id)
      );
      expect(found).toBeDefined();
      expect(found?.confidence).toBe('certain'); // "c white" variant matches exactly → 1.0
    });
  });

  describe('canonical fields — service layer', () => {
    it('createContact stores and retrieves canonical fields', async () => {
      const contact = await contactService.createContact({
        displayName: 'Integration Canonical',
        source: 'integration-test',
        title: 'Principal Engineer',
        organization: 'Acme Corp',
        timezone: 'America/Chicago',
        bio: 'Integration bio.',
      });

      const fetched = await contactService.getContact(contact.id);
      expect(fetched).toBeDefined();
      expect(fetched!.title).toBe('Principal Engineer');
      expect(fetched!.organization).toBe('Acme Corp');
      expect(fetched!.timezone).toBe('America/Chicago');
      expect(fetched!.bio).toBe('Integration bio.');
    });

    it('updateContactFields round-trips through Postgres', async () => {
      const contact = await contactService.createContact({
        displayName: 'Update Integration',
        source: 'integration-test',
      });

      const updated = await contactService.updateContactFields(contact.id, {
        title: 'Senior Engineer',
        linkedinUrl: 'https://linkedin.com/in/testperson',
        birthday: '1990-04-15',
      });

      const fetched = await contactService.getContact(updated.id);
      expect(fetched!.title).toBe('Senior Engineer');
      expect(fetched!.linkedinUrl).toBe('https://linkedin.com/in/testperson');
      expect(fetched!.birthday).toBe('1990-04-15');
    });

    it('listContacts returns canonical fields for all contacts', async () => {
      const contact = await contactService.createContact({
        displayName: 'List Canonical',
        source: 'integration-test',
        organization: 'TestOrg',
      });

      const all = await contactService.listContacts();
      const found = all.find(c => c.id === contact.id);
      expect(found).toBeDefined();
      expect(found!.organization).toBe('TestOrg');
      // Unprovided fields are null
      expect(found!.preferredName).toBeNull();
    });

    it('updateContactFields primaryEmail validation rejects unknown email', async () => {
      const contact = await contactService.createContact({
        displayName: 'Email Reject',
        source: 'integration-test',
      });
      await expect(
        contactService.updateContactFields(contact.id, { primaryEmail: 'nobody@example.com' }),
      ).rejects.toThrow(/not found.*contact_channel_identities|contact_channel_identities.*not found/i);
    });

    it('updateContactFields primaryEmail accepts email that exists in CCI', async () => {
      const contact = await contactService.createContact({
        displayName: 'Email Accept',
        source: 'integration-test',
      });
      await contactService.linkIdentity({
        contactId: contact.id,
        channel: 'email',
        channelIdentifier: 'cci-test@example.com',
        source: 'ceo_stated',
      });
      const updated = await contactService.updateContactFields(contact.id, {
        primaryEmail: 'CCI-TEST@EXAMPLE.COM',
      });
      // Normalized to lowercase on write
      expect(updated.primaryEmail).toBe('cci-test@example.com');
    });
  });
});
