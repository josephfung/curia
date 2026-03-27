// tests/unit/contacts/contact-resolver.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ContactResolver } from '../../../src/contacts/contact-resolver.js';
import { ContactService } from '../../../src/contacts/contact-service.js';
import { KnowledgeGraphStore } from '../../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../../src/memory/embedding.js';
import { EntityMemory } from '../../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../../src/memory/validation.js';
import { createLogger } from '../../../src/logger.js';

describe('ContactResolver', () => {
  let resolver: ContactResolver;
  let contactService: ContactService;
  let entityMemory: EntityMemory;

  beforeEach(() => {
    const embeddingService = EmbeddingService.createForTesting();
    const store = KnowledgeGraphStore.createInMemory(embeddingService);
    const validator = new MemoryValidator(store, embeddingService);
    entityMemory = new EntityMemory(store, validator, embeddingService);
    contactService = ContactService.createInMemory(entityMemory);
    resolver = new ContactResolver(contactService, entityMemory, undefined, createLogger('error'));
  });

  it('resolves CLI channel as primary user (CEO)', async () => {
    const result = await resolver.resolve('cli', 'any-id');
    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.displayName).toBe('CEO');
      expect(result.role).toBe('ceo');
    }
  });

  it('resolves smoke-test channel as primary user', async () => {
    const result = await resolver.resolve('smoke-test', 'any-id');
    expect(result.resolved).toBe(true);
  });

  it('resolves known verified sender with contact details', async () => {
    const contact = await contactService.createContact({ displayName: 'Jenna Torres', role: 'CFO', source: 'test' });
    await contactService.linkIdentity({ contactId: contact.id, channel: 'email', channelIdentifier: 'jenna@acme.com', source: 'ceo_stated' });

    const result = await resolver.resolve('email', 'jenna@acme.com');
    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.displayName).toBe('Jenna Torres');
      expect(result.role).toBe('CFO');
      expect(result.verified).toBe(true);
    }
  });

  it('returns unknown sender for unrecognized channel identity', async () => {
    const result = await resolver.resolve('telegram', '99999');
    expect(result.resolved).toBe(false);
    if (!result.resolved) {
      expect(result.channel).toBe('telegram');
      expect(result.senderId).toBe('99999');
    }
  });

  it('enriches resolved sender with KG facts', async () => {
    const contact = await contactService.createContact({ displayName: 'Jenna Torres', role: 'CFO', source: 'test' });
    await contactService.linkIdentity({ contactId: contact.id, channel: 'email', channelIdentifier: 'jenna@acme.com', source: 'ceo_stated' });

    // Add a fact about Jenna via entity memory
    if (contact.kgNodeId) {
      await entityMemory.storeFact({ entityNodeId: contact.kgNodeId, label: 'Jenna manages the Q3 budget review', source: 'test' });
    }

    const result = await resolver.resolve('email', 'jenna@acme.com');
    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.knowledgeSummary).toContain('Q3 budget');
    }
  });
});
