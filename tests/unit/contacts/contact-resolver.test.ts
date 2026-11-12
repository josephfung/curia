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
import { stampOriginator } from '../../../src/contacts/stamp-originator.js';

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

  it('resolves CLI channel as primary user', async () => {
    const result = await resolver.resolve('cli', 'any-id');
    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.displayName).toBe('Principal');
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

  // R42 (#2475): an address the principal said is no longer theirs ("No, forget it" on a
  // removed mailbox) may now belong to someone else; its mail must not run as the principal.
  it.each(['defunct', 'bounced'] as const)('a %s principal email resolves without principal standing and no live turn (R42)', async (status) => {
    const created = await contactService.createContact({ displayName: 'CEO', tier: 'known', kind: 'person', source: 'test' });
    const principal = await contactService.saveContact({ ...created, systemRole: 'principal', tier: 'principal', kind: 'principal' });
    const active = await contactService.linkIdentity({ contactId: principal.id, channel: 'email', channelIdentifier: 'me@home-example.org', source: 'ceo_stated', verified: true });
    const old = await contactService.linkIdentity({ contactId: principal.id, channel: 'email', channelIdentifier: 'me@old-work-example.com', source: 'ceo_stated', verified: true });
    await contactService.setIdentityStatus(old.id, status);

    const gone = await resolver.resolve('email', 'me@old-work-example.com');
    expect(gone.resolved).toBe(true);
    if (!gone.resolved) throw new Error('unreachable');
    expect(gone.contactId).toBe(principal.id);
    expect(gone.systemRole).toBeNull();
    expect(gone.tier).toBe('unknown');
    expect(gone.kind).toBe('person');
    expect(gone.verified).toBe(false);
    expect(stampOriginator({ senderContext: gone, channel: 'email', senderId: 'me@old-work-example.com', authenticated: true }).liveTurn).toBe(false);

    // The principal's active address keeps full standing.
    const kept = await resolver.resolve('email', 'me@home-example.org');
    if (!kept.resolved) throw new Error('expected a resolved sender');
    expect(kept.systemRole).toBe('principal');
    expect(kept.tier).toBe('principal');
    expect(stampOriginator({ senderContext: kept, channel: 'email', senderId: 'me@home-example.org', authenticated: true }).liveTurn).toBe(true);
    expect(active.id).toBeTruthy();
  });

  it('a defunct identity of a third-party contact still resolves to that contact with its tier (R32)', async () => {
    const c = await contactService.createContact({ displayName: 'Vendor', tier: 'known', source: 'test' });
    const i = await contactService.linkIdentity({ contactId: c.id, channel: 'email', channelIdentifier: 'sales@vendor-example.com', source: 'ceo_stated', verified: true });
    await contactService.setIdentityStatus(i.id, 'defunct');
    const r = await resolver.resolve('email', 'sales@vendor-example.com');
    if (!r.resolved) throw new Error('expected a resolved sender');
    expect(r.contactId).toBe(c.id);
    expect(r.tier).toBe('known');
    expect(r.verified).toBe(false);
  });
});
