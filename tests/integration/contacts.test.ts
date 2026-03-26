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

const { Pool } = pg;

// Skip the entire suite if DATABASE_URL is not set — no database available
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('Contacts Integration', () => {
  let pool: pg.Pool;
  let contactService: ContactService;
  let resolver: ContactResolver;
  let entityMemory: EntityMemory;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const logger = createLogger('error');
    const embeddingService = EmbeddingService.createForTesting();
    const kgStore = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, logger);
    const validator = new MemoryValidator(kgStore, embeddingService);
    entityMemory = new EntityMemory(kgStore, validator, embeddingService);
    contactService = ContactService.createWithPostgres(pool, entityMemory, logger);
    resolver = new ContactResolver(contactService, entityMemory, logger);

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
});
