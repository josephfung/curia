// tests/unit/contacts/contact-resolver.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContactResolver } from '../../../src/contacts/contact-resolver.js';
import { ContactService } from '../../../src/contacts/contact-service.js';
import type { AuthorizationService } from '../../../src/contacts/authorization.js';
import { KnowledgeGraphStore } from '../../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../../src/memory/embedding.js';
import { EntityMemory } from '../../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../../src/memory/validation.js';
import { createLogger, createSilentLogger } from '../../../src/logger.js';

describe('ContactResolver', () => {
  let resolver: ContactResolver;
  let contactService: ContactService;
  let entityMemory: EntityMemory;

  beforeEach(() => {
    const embeddingService = EmbeddingService.createForTesting();
    const store = KnowledgeGraphStore.createInMemory(embeddingService);
    const validator = new MemoryValidator(store, embeddingService);
    entityMemory = new EntityMemory(store, validator, embeddingService, createSilentLogger());
    contactService = ContactService.createInMemory(entityMemory);
    resolver = new ContactResolver(contactService, entityMemory, undefined, createLogger('error'));
  });

  it.each(['cli', 'smoke-test', 'web'])('resolves %s as the principal (systemRole)', async (channel) => {
    // liveTurn reads originator.systemRole === 'principal' (#1848) — displayName/role
    // alone are not enough; a null systemRole would kill outbound-context injection
    // on the CEO's console even if role stayed 'ceo'.
    const result = await resolver.resolve(channel, 'any-id');
    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.systemRole).toBe('principal');
      expect(result.tier).toBe('principal');
    }
  });

  it('resolves CLI channel as primary user (CEO)', async () => {
    const result = await resolver.resolve('cli', 'any-id');
    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.displayName).toBe('CEO');
      expect(result.role).toBe('ceo');
      expect(result.systemRole).toBe('principal');
    }
  });

  it('resolves smoke-test channel as primary user', async () => {
    const result = await resolver.resolve('smoke-test', 'any-id');
    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.systemRole).toBe('principal');
    }
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

  it('sets authorizationEvalFailed when AuthorizationService.evaluate throws', async () => {
    const contact = await contactService.createContact({
      displayName: 'Eval Fail',
      role: 'cfo',
      source: 'test',
      tier: 'known',
    });
    await contactService.linkIdentity({
      contactId: contact.id,
      channel: 'email',
      channelIdentifier: 'eval-fail@acme.com',
      source: 'ceo_stated',
    });

    const throwingAuth = {
      evaluate: vi.fn(() => {
        throw new Error('auth boom');
      }),
    } as unknown as AuthorizationService;
    const withAuth = new ContactResolver(
      contactService,
      entityMemory,
      throwingAuth,
      createLogger('error'),
    );

    const result = await withAuth.resolve('email', 'eval-fail@acme.com');
    expect(result.resolved).toBe(true);
    if (!result.resolved) return;
    expect(result.authorization).toBeNull();
    expect(result.authorizationEvalFailed).toBe(true);
  });

  it('warns via buildPrincipalSenderContext when principal kind is stale (migration-055)', async () => {
    const PRINCIPAL_ID = '11111111-1111-1111-1111-111111111111';
    const stalePrincipal = {
      id: PRINCIPAL_ID,
      displayName: 'CEO',
      role: 'ceo',
      systemRole: 'principal' as const,
      kgNodeId: null,
      tier: 'principal' as const,
      kind: 'person' as const,
    };
    const contactServiceStub = {
      findContactBySystemRole: vi.fn().mockResolvedValue(stalePrincipal),
    } as unknown as ContactService;

    const warnLogger = createSilentLogger();
    const warnSpy = vi.spyOn(warnLogger, 'warn');
    const withWarn = new ContactResolver(contactServiceStub, entityMemory, undefined, warnLogger);

    const result = await withWarn.resolve('cli', 'any-id');
    expect(result.resolved).toBe(true);
    if (!result.resolved) return;
    expect(result.kind).toBe('principal');
    expect(result.contactId).toBe(PRINCIPAL_ID);
    expect(warnSpy).toHaveBeenCalledWith(
      { source: 'contact-resolver', contactId: PRINCIPAL_ID, kind: 'person' },
      'principal contact has kind != "principal" — migration-055 backfill may have missed this row',
    );
  });
});
