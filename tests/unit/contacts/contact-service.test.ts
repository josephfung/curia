// tests/unit/contacts/contact-service.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ContactService } from '../../../src/contacts/contact-service.js';
import { KnowledgeGraphStore } from '../../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../../src/memory/embedding.js';
import { EntityMemory } from '../../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../../src/memory/validation.js';

describe('ContactService', () => {
  let service: ContactService;
  let entityMemory: EntityMemory;

  beforeEach(() => {
    const embeddingService = EmbeddingService.createForTesting();
    const store = KnowledgeGraphStore.createInMemory(embeddingService);
    const validator = new MemoryValidator(store, embeddingService);
    entityMemory = new EntityMemory(store, validator, embeddingService);
    service = ContactService.createInMemory(entityMemory);
  });

  describe('createContact', () => {
    it('creates a contact and auto-creates a KG person node', async () => {
      const contact = await service.createContact({
        displayName: 'Jenna Torres',
        role: 'CFO',
        source: 'test',
      });
      expect(contact.id).toBeDefined();
      expect(contact.displayName).toBe('Jenna Torres');
      expect(contact.role).toBe('CFO');
      expect(contact.kgNodeId).toBeDefined(); // auto-created
    });

    it('links to existing KG node when kgNodeId provided', async () => {
      const entity = await entityMemory.createEntity({
        type: 'person',
        label: 'Existing Person',
        properties: {},
        source: 'test',
      });
      const contact = await service.createContact({
        displayName: 'Existing Person',
        kgNodeId: entity.id,
        source: 'test',
      });
      expect(contact.kgNodeId).toBe(entity.id);
    });
  });

  describe('getContact', () => {
    it('retrieves a contact by ID', async () => {
      const created = await service.createContact({ displayName: 'Alice', source: 'test' });
      const retrieved = await service.getContact(created.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.displayName).toBe('Alice');
    });

    it('returns undefined for non-existent ID', async () => {
      expect(await service.getContact('non-existent')).toBeUndefined();
    });
  });

  describe('findContactByName', () => {
    it('finds contacts case-insensitively', async () => {
      await service.createContact({ displayName: 'Jenna Torres', source: 'test' });
      const results = await service.findContactByName('jenna torres');
      expect(results).toHaveLength(1);
      expect(results[0]!.displayName).toBe('Jenna Torres');
    });
  });

  describe('findContactByRole', () => {
    it('filters contacts by role', async () => {
      await service.createContact({ displayName: 'Jenna', role: 'CFO', source: 'test' });
      await service.createContact({ displayName: 'Kevin', role: 'CTO', source: 'test' });
      const cfos = await service.findContactByRole('CFO');
      expect(cfos).toHaveLength(1);
      expect(cfos[0]!.displayName).toBe('Jenna');
    });
  });

  describe('listContacts', () => {
    it('returns all contacts', async () => {
      await service.createContact({ displayName: 'A', source: 'test' });
      await service.createContact({ displayName: 'B', source: 'test' });
      const all = await service.listContacts();
      expect(all).toHaveLength(2);
    });
  });

  describe('setRole', () => {
    it('updates the contact role', async () => {
      const contact = await service.createContact({ displayName: 'Jenna', role: 'VP', source: 'test' });
      const updated = await service.setRole(contact.id, 'CFO');
      expect(updated.role).toBe('CFO');
    });
  });

  describe('linkIdentity', () => {
    it('adds a channel identity to a contact', async () => {
      const contact = await service.createContact({ displayName: 'Jenna', source: 'test' });
      const identity = await service.linkIdentity({
        contactId: contact.id,
        channel: 'email',
        channelIdentifier: 'jenna@acme.com',
        source: 'ceo_stated',
      });
      expect(identity.channel).toBe('email');
      expect(identity.verified).toBe(true); // ceo_stated is auto-verified
    });

    it('self_claimed source is not auto-verified', async () => {
      const contact = await service.createContact({ displayName: 'Unknown', source: 'test' });
      const identity = await service.linkIdentity({
        contactId: contact.id,
        channel: 'telegram',
        channelIdentifier: '99999',
        source: 'self_claimed',
      });
      expect(identity.verified).toBe(false);
    });
  });

  describe('resolveByChannelIdentity', () => {
    it('resolves a known sender', async () => {
      const contact = await service.createContact({ displayName: 'Jenna', role: 'CFO', source: 'test' });
      await service.linkIdentity({
        contactId: contact.id,
        channel: 'email',
        channelIdentifier: 'jenna@acme.com',
        source: 'ceo_stated',
      });
      const resolved = await service.resolveByChannelIdentity('email', 'jenna@acme.com');
      expect(resolved).toBeDefined();
      expect(resolved!.displayName).toBe('Jenna');
      expect(resolved!.role).toBe('CFO');
      expect(resolved!.verified).toBe(true);
    });

    it('returns null for unknown sender', async () => {
      const resolved = await service.resolveByChannelIdentity('email', 'nobody@example.com');
      expect(resolved).toBeNull();
    });
  });

  describe('getContactWithIdentities', () => {
    it('returns contact with all channel identities', async () => {
      const contact = await service.createContact({ displayName: 'Jenna', source: 'test' });
      await service.linkIdentity({ contactId: contact.id, channel: 'email', channelIdentifier: 'jenna@work.com', source: 'ceo_stated' });
      await service.linkIdentity({ contactId: contact.id, channel: 'email', channelIdentifier: 'jenna@personal.com', source: 'ceo_stated', label: 'personal' });

      const result = await service.getContactWithIdentities(contact.id);
      expect(result).toBeDefined();
      expect(result!.identities).toHaveLength(2);
    });
  });
});
