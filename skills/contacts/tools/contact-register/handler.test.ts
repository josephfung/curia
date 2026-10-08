import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pino from 'pino';
import { ContactRegisterHandler } from './handler.js';
import { ContactService } from '../../../../src/contacts/contact-service.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import { sourceKeyFor, sourceKeysInText, type IdentifierSources } from '../../../../src/contacts/identifier-provenance.js';

const silentLog = pino({ level: 'silent' });

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    input: {},
    secret: () => 'unused',
    log: silentLog,
    ...overrides,
  } as unknown as ToolContext;
}

const TIMESTAMP_A = '2026-05-08T10:00:00.000Z';
const TIMESTAMP_B = '2026-05-08T11:00:00.000Z'; // one hour later
const TIMESTAMP_OLD = '2026-05-07T08:00:00.000Z'; // yesterday

describe('ContactRegisterHandler — input validation', () => {
  let handler: ContactRegisterHandler;
  let contactService: ContactService;

  beforeEach(() => {
    handler = new ContactRegisterHandler();
    contactService = ContactService.createInMemory();
  });

  it('returns error when channel is missing', async () => {
    const ctx = makeCtx({
      contactService,
      input: { identifier: 'alice@example.com', displayName: 'Alice', messageTimestamp: TIMESTAMP_A },
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/channel/);
  });

  it('returns error when identifier is missing', async () => {
    const ctx = makeCtx({
      contactService,
      input: { channel: 'email', displayName: 'Alice', messageTimestamp: TIMESTAMP_A },
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/identifier/);
  });

  it('returns error when displayName is missing', async () => {
    const ctx = makeCtx({
      contactService,
      input: { channel: 'email', identifier: 'alice@example.com', messageTimestamp: TIMESTAMP_A },
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/displayName/);
  });

  it('returns error when messageTimestamp is missing', async () => {
    const ctx = makeCtx({
      contactService,
      input: { channel: 'email', identifier: 'alice@example.com', displayName: 'Alice' },
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/messageTimestamp/);
  });

  it('returns error when messageTimestamp is not a valid date', async () => {
    const ctx = makeCtx({
      contactService,
      input: { channel: 'email', identifier: 'alice@example.com', displayName: 'Alice', messageTimestamp: 'not-a-date' },
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/ISO 8601/);
  });

  it('returns error when direction is invalid', async () => {
    const ctx = makeCtx({
      contactService,
      input: { channel: 'email', identifier: 'alice@example.com', displayName: 'Alice', messageTimestamp: TIMESTAMP_A, direction: 'sideways' },
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/direction/);
  });

  it('returns error when contactService is unavailable', async () => {
    const ctx = makeCtx({
      input: { channel: 'email', identifier: 'alice@example.com', displayName: 'Alice', messageTimestamp: TIMESTAMP_A },
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/contactService/);
  });
});

describe('ContactRegisterHandler — known contact resolution', () => {
  let handler: ContactRegisterHandler;
  let contactService: ContactService;

  beforeEach(async () => {
    handler = new ContactRegisterHandler();
    contactService = ContactService.createInMemory();

    // Seed a known contact (tier='known', the former confirmed) with an email identity
    const contact = await contactService.createContact({
      displayName: 'Alice Nguyen',
      role: 'Head of Product',
      tier: 'known',
      source: 'ceo_stated',
    });
    await contactService.linkIdentity({
      contactId: contact.id,
      channel: 'email',
      channelIdentifier: 'alice@example.com',
      source: 'email_participant',
    });
  });

  it('resolves an existing contact and returns it', async () => {
    const ctx = makeCtx({
      contactService,
      input: { channel: 'email', identifier: 'alice@example.com', displayName: 'Alice', messageTimestamp: TIMESTAMP_A },
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: Record<string, unknown> }).data;
    expect(data.display_name).toBe('Alice Nguyen');
    // status is no longer returned in the response (removed with the promotion flow)
    expect(data).not.toHaveProperty('status');
    expect(data.created).toBe(false);
    expect(typeof data.contact_id).toBe('string');
  });

  it('does not create a duplicate contact for a known identifier', async () => {
    const ctx = makeCtx({
      contactService,
      input: { channel: 'email', identifier: 'alice@example.com', displayName: 'Alice', messageTimestamp: TIMESTAMP_A },
    });

    await handler.execute(ctx);

    const allContacts = await contactService.listContacts();
    expect(allContacts).toHaveLength(1);
  });
});

describe('ContactRegisterHandler — unknown contact creation', () => {
  let handler: ContactRegisterHandler;
  let contactService: ContactService;

  beforeEach(() => {
    handler = new ContactRegisterHandler();
    contactService = ContactService.createInMemory();
  });

  it('creates a contact at tier=unknown for an unknown email address (not provisional)', async () => {
    const ctx = makeCtx({
      contactService,
      input: { channel: 'email', identifier: 'newperson@example.com', displayName: 'New Person', messageTimestamp: TIMESTAMP_A },
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: Record<string, unknown> }).data;
    // New contacts are created at tier='unknown', NOT provisional — promotion is
    // handled downstream (auto-elevation in the dispatcher/judgment path, not here).
    expect(data.display_name).toBe('New Person');
    expect(data.created).toBe(true);

    // Verify the contact landed at tier='unknown' in the DB
    const resolved = await contactService.resolveByChannelIdentity('email', 'newperson@example.com');
    const contact = await contactService.getContact(resolved!.contactId);
    expect(contact!.tier).toBe('unknown');
  });

  it('links the identifier to the new contact so future calls resolve it', async () => {
    const ctx = makeCtx({
      contactService,
      input: { channel: 'email', identifier: 'newperson@example.com', displayName: 'New Person', messageTimestamp: TIMESTAMP_A },
    });

    const firstResult = await handler.execute(ctx);
    expect(firstResult.success).toBe(true);
    const firstData = (firstResult as { success: true; data: Record<string, unknown> }).data;
    const firstId = firstData.contact_id as string;

    // Second call with same identifier should resolve, not create
    const secondResult = await handler.execute(ctx);
    expect(secondResult.success).toBe(true);
    const secondData = (secondResult as { success: true; data: Record<string, unknown> }).data;
    expect(secondData.contact_id).toBe(firstId);
    expect(secondData.created).toBe(false);
  });

  it('stores the contact with source agent_called on the identity', async () => {
    const ctx = makeCtx({
      contactService,
      input: { channel: 'email', identifier: 'newperson@example.com', displayName: 'New Person', messageTimestamp: TIMESTAMP_A },
    });

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const data = (result as { success: true; data: Record<string, unknown> }).data;

    const withIdentities = await contactService.getContactWithIdentities(data.contact_id as string);
    expect(withIdentities).toBeDefined();
    const identity = withIdentities!.identities.find(i => i.channel === 'email');
    expect(identity).toBeDefined();
    expect(identity!.source).toBe('agent_called');
  });
});

describe('ContactRegisterHandler — last_seen_at idempotency (pipeline absent)', () => {
  let handler: ContactRegisterHandler;
  let contactService: ContactService;

  beforeEach(async () => {
    handler = new ContactRegisterHandler();
    contactService = ContactService.createInMemory();

    // Seed a known contact (tier='known')
    const contact = await contactService.createContact({
      displayName: 'Bob Smith',
      tier: 'known',
      source: 'ceo_stated',
    });
    await contactService.linkIdentity({
      contactId: contact.id,
      channel: 'email',
      channelIdentifier: 'bob@example.com',
      source: 'email_participant',
    });
  });

  it('updates last_seen_at when messageTimestamp is newer than current value', async () => {
    // First call — sets last_seen_at to TIMESTAMP_A
    const ctx = makeCtx({
      contactService,
      input: { channel: 'email', identifier: 'bob@example.com', displayName: 'Bob', messageTimestamp: TIMESTAMP_A },
    });
    await handler.execute(ctx);

    // Second call — newer timestamp should advance last_seen_at
    const ctx2 = makeCtx({
      contactService,
      input: { channel: 'email', identifier: 'bob@example.com', displayName: 'Bob', messageTimestamp: TIMESTAMP_B },
    });
    const result = await handler.execute(ctx2);
    expect(result.success).toBe(true);

    // Verify last_seen_at advanced
    const resolved = await contactService.resolveByChannelIdentity('email', 'bob@example.com');
    const contact = await contactService.getContact(resolved!.contactId);
    expect(contact!.lastSeenAt).not.toBeNull();
    expect(contact!.lastSeenAt!.toISOString()).toBe(TIMESTAMP_B);
  });

  it('does not roll back last_seen_at when messageTimestamp is older than current value', async () => {
    // First call — sets last_seen_at to TIMESTAMP_B (the later time)
    const ctx = makeCtx({
      contactService,
      input: { channel: 'email', identifier: 'bob@example.com', displayName: 'Bob', messageTimestamp: TIMESTAMP_B },
    });
    await handler.execute(ctx);

    // Second call — older timestamp must NOT overwrite last_seen_at
    const ctx2 = makeCtx({
      contactService,
      input: { channel: 'email', identifier: 'bob@example.com', displayName: 'Bob', messageTimestamp: TIMESTAMP_OLD },
    });
    const result = await handler.execute(ctx2);
    expect(result.success).toBe(true);

    const resolved = await contactService.resolveByChannelIdentity('email', 'bob@example.com');
    const contact = await contactService.getContact(resolved!.contactId);
    // last_seen_at should still be TIMESTAMP_B, not TIMESTAMP_OLD
    expect(contact!.lastSeenAt!.toISOString()).toBe(TIMESTAMP_B);
  });
});

describe('ContactRegisterHandler — confidence pipeline (pipeline present)', () => {
  let handler: ContactRegisterHandler;
  let contactService: ContactService;
  let contactId: string;

  beforeEach(async () => {
    handler = new ContactRegisterHandler();
    contactService = ContactService.createInMemory();

    const contact = await contactService.createContact({
      displayName: 'Dave Evans',
      tier: 'known',
      source: 'ceo_stated',
    });
    contactId = contact.id;
    await contactService.linkIdentity({
      contactId: contact.id,
      channel: 'email',
      channelIdentifier: 'dave@example.com',
      source: 'email_participant',
    });
  });

  it('delegates scoring to the pipeline when present', async () => {
    const calls: Array<{ contactId: string; signal: unknown }> = [];
    const mockPipeline = {
      incrementalUpdate: async (id: string, signal: unknown) => {
        calls.push({ contactId: id, signal });
      },
    };

    const ctx = makeCtx({
      contactService,
      confidencePipeline: mockPipeline as unknown as ToolContext['confidencePipeline'],
      input: { channel: 'email', identifier: 'dave@example.com', displayName: 'Dave', messageTimestamp: TIMESTAMP_A },
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.contactId).toBe(contactId);
    expect(calls[0]!.signal).toEqual({ type: 'message_seen' });
  });

  it('does not update lastSeenAt directly when pipeline is present', async () => {
    const mockPipeline = {
      incrementalUpdate: async () => { /* no-op — does not write lastSeenAt */ },
    };

    const ctx = makeCtx({
      contactService,
      confidencePipeline: mockPipeline as unknown as ToolContext['confidencePipeline'],
      input: { channel: 'email', identifier: 'dave@example.com', displayName: 'Dave', messageTimestamp: TIMESTAMP_A },
    });

    await handler.execute(ctx);

    // The mock pipeline is a no-op — lastSeenAt should remain null because the
    // direct update path is skipped when the pipeline is present.
    const contact = await contactService.getContact(contactId);
    expect(contact!.lastSeenAt).toBeNull();
  });
});

describe('ContactRegisterHandler — bus event emission', () => {
  let handler: ContactRegisterHandler;
  let contactService: ContactService;

  beforeEach(async () => {
    handler = new ContactRegisterHandler();
    contactService = ContactService.createInMemory();

    const contact = await contactService.createContact({
      displayName: 'Carol Diaz',
      tier: 'known',
      source: 'ceo_stated',
    });
    await contactService.linkIdentity({
      contactId: contact.id,
      channel: 'email',
      channelIdentifier: 'carol@example.com',
      source: 'email_participant',
    });
  });

  it('publishes a contact.resolved event with sourceLayer execution', async () => {
    const publishedEvents: unknown[] = [];
    const mockBus = {
      // Two-arg signature matches EventBus.publish(layer, event) — enforced here so
      // a missing layer arg fails the test rather than silently passing.
      publish: async (_layer: string, event: unknown) => { publishedEvents.push(event); },
    };

    const ctx = makeCtx({
      contactService,
      bus: mockBus as ToolContext['bus'],
      input: { channel: 'email', identifier: 'carol@example.com', displayName: 'Carol', messageTimestamp: TIMESTAMP_A },
    });

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);

    // Give the fire-and-forget publish a tick to complete
    await new Promise(resolve => setImmediate(resolve));

    expect(publishedEvents).toHaveLength(1);
    const event = publishedEvents[0] as Record<string, unknown>;
    expect(event.type).toBe('contact.resolved');
    expect(event.sourceLayer).toBe('execution');
  });

  it('succeeds even when bus is not available', async () => {
    const ctx = makeCtx({
      contactService,
      // No bus injected
      input: { channel: 'email', identifier: 'carol@example.com', displayName: 'Carol', messageTimestamp: TIMESTAMP_A },
    });

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
  });
});

describe('ContactRegisterHandler — promotion flow removed', () => {
  // The provisional→confirmed promotion flow has been retired. Auto-elevation is now
  // handled by the dispatcher/judgment path (auto-elevation #951). This suite verifies
  // that the removed flow is gone and the handler's core behavior is correct.

  let handler: ContactRegisterHandler;
  let contactService: ContactService;

  beforeEach(() => {
    handler = new ContactRegisterHandler();
    contactService = ContactService.createInMemory();
  });

  it('registers a new unknown sender at tier=unknown, never calls promoteToConfirmed', async () => {
    // Track any call to promoteToConfirmed — there should be none
    const promoteCalls: string[] = [];
    const proxiedService = new Proxy(contactService, {
      get(target, prop) {
        if (prop === 'promoteToConfirmed') {
          return (id: string) => {
            promoteCalls.push(id);
            return (target as unknown as Record<string, unknown>)[prop as string];
          };
        }
        return (target as unknown as Record<string, unknown>)[prop as string];
      },
    });

    const ctx = makeCtx({
      contactService: proxiedService as unknown as ContactService,
      input: {
        channel: 'email',
        identifier: 'stranger@example.com',
        displayName: 'Stranger',
        messageTimestamp: TIMESTAMP_A,
      },
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(promoteCalls).toHaveLength(0);

    // Verify the contact was created at tier='unknown', not provisional
    const resolved = await contactService.resolveByChannelIdentity('email', 'stranger@example.com');
    const contact = await contactService.getContact(resolved!.contactId);
    expect(contact!.tier).toBe('unknown');
  });

  it('does not include promoted or promotion_signal in the response', async () => {
    const ctx = makeCtx({
      contactService,
      input: {
        channel: 'email',
        identifier: 'someone@example.com',
        displayName: 'Someone',
        messageTimestamp: TIMESTAMP_A,
      },
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: Record<string, unknown> }).data;
    // These output fields were removed along with the promotion flow
    expect(data).not.toHaveProperty('promoted');
    expect(data).not.toHaveProperty('promotion_signal');
    expect(data).not.toHaveProperty('status');
  });

  it('ignores ceo_has_sent and calendar_accepted if supplied (inputs were removed from manifest)', async () => {
    // Even if a caller passes these now-retired inputs, the handler must not promote.
    // The inputs are simply ignored — and promoteToConfirmed must never be invoked.
    const promoteCalls: string[] = [];
    const proxiedService = new Proxy(contactService, {
      get(target, prop) {
        if (prop === 'promoteToConfirmed') {
          return (id: string) => {
            promoteCalls.push(id);
            return (target as unknown as Record<string, unknown>)[prop as string];
          };
        }
        return (target as unknown as Record<string, unknown>)[prop as string];
      },
    });

    const ctx = makeCtx({
      contactService: proxiedService as unknown as ContactService,
      input: {
        channel: 'email',
        identifier: 'ghost@example.com',
        displayName: 'Ghost',
        messageTimestamp: TIMESTAMP_A,
        ceo_has_sent: true,
        calendar_accepted: true,
      },
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    // promoteToConfirmed must not have been called, even with the stale promotion inputs
    expect(promoteCalls).toHaveLength(0);

    const data = (result as { success: true; data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty('promoted');
    expect(data).not.toHaveProperty('promotion_signal');

    // Contact should still be at tier='unknown' — no promotion happened
    const resolved = await contactService.resolveByChannelIdentity('email', 'ghost@example.com');
    const contact = await contactService.getContact(resolved!.contactId);
    expect(contact!.tier).toBe('unknown');
  });
});

/** Sources holding exactly the identifiers in `text`, as the runtime's lookup would. */
function sourcesFrom(text: string): IdentifierSources {
  const keys = sourceKeysInText(text);
  return { has: async (channel, identifier) => keys.has(sourceKeyFor(channel, identifier)) };
}

// A triage list result, as ceo-inbox-list returns it and the runtime indexes it (#2061).
const INBOX_LISTING = JSON.stringify({
  messages: [{ id: 'm1', from: [{ name: 'Sam Rivera', email: 'sam@venue-co.com' }], to: [{ email: 'pat@principal.example' }] }],
});

describe('ContactRegisterHandler — identifier provenance (#2061)', () => {
  let handler: ContactRegisterHandler;
  let contactService: ContactService;

  beforeEach(async () => {
    handler = new ContactRegisterHandler();
    contactService = ContactService.createInMemory();
    const principal = await contactService.createContact({ displayName: 'Pat Principal', source: 'ceo_stated' });
    await contactService.saveContact({ ...principal, systemRole: 'principal' });
    await contactService.linkIdentity({ contactId: principal.id, channel: 'email', channelIdentifier: 'pat@principal.example', source: 'ceo_stated' });
  });

  const register = (identifier: string, extra: Partial<ToolContext>) => handler.execute(makeCtx({
    contactService,
    input: { channel: 'email', identifier, displayName: 'Sam Rivera', messageTimestamp: TIMESTAMP_A },
    ...extra,
  }));

  async function identityOf(identifier: string) {
    const resolved = await contactService.resolveByChannelIdentity('email', identifier);
    const identities = await contactService.getIdentitiesForContact(resolved!.contactId);
    return identities.find((identity) => identity.channelIdentifier === identifier)!;
  }

  it('verifies a new sender whose address is in the mail read this conversation', async () => {
    const result = await register('Sam@Venue-Co.com', { identifierSources: sourcesFrom(INBOX_LISTING) });
    expect(result).toMatchObject({ success: true, data: { created: true, verified: true } });
    expect(await identityOf('sam@venue-co.com')).toMatchObject({ source: 'agent_called', verified: true });
  });

  it('registers a mistyped sender unverified, without failing triage', async () => {
    const result = await register('sam@venu-co.com', { identifierSources: sourcesFrom(INBOX_LISTING) });
    expect(result).toMatchObject({ success: true, data: { created: true, verified: false } });
    expect(await identityOf('sam@venu-co.com')).toMatchObject({ verified: false });
  });

  it('registers a near miss of the principal unverified', async () => {
    const result = await register('pat@principal.exampel', { identifierSources: sourcesFrom(INBOX_LISTING) });
    expect(result).toMatchObject({ success: true, data: { created: true, verified: false } });
  });

  it('resolves the principal exactly, creating nothing', async () => {
    const before = (await contactService.listContacts()).length;
    const result = await register('pat@principal.example', { identifierSources: sourcesFrom(INBOX_LISTING) });
    expect(result).toMatchObject({ success: true, data: { created: false, verified: true } });
    expect((await contactService.listContacts()).length).toBe(before);
  });

  it('registers unverified when the task has no sources', async () => {
    const result = await register('sam@venue-co.com', {});
    expect(result).toMatchObject({ success: true, data: { created: true, verified: false } });
  });

  it('verifies an unverified agent_called identity in place once a source has it', async () => {
    await register('sam@venue-co.com', {});
    const again = await register('sam@venue-co.com', { identifierSources: sourcesFrom(INBOX_LISTING) });
    expect(again).toMatchObject({ success: true, data: { created: false, verified: true } });
    expect(await identityOf('sam@venue-co.com')).toMatchObject({ source: 'agent_called', verified: true });
  });

  it('does not verify an unverified identity of another source', async () => {
    const contact = await contactService.createContact({ displayName: 'Sam Rivera', source: 'outbound_recipient' });
    await contactService.linkIdentity({ contactId: contact.id, channel: 'email', channelIdentifier: 'sam@venue-co.com', source: 'outbound_recipient' });
    const result = await register('sam@venue-co.com', { identifierSources: sourcesFrom(INBOX_LISTING) });
    expect(result).toMatchObject({ success: true, data: { created: false, verified: false } });
  });

  it('treats a principal-approved replay as sourced', async () => {
    const result = await register('sam@venue-co.com', { humanApproved: true });
    expect(result).toMatchObject({ success: true, data: { verified: true } });
  });

  it('refuses a blank identifier instead of storing an empty address', async () => {
    const before = (await contactService.listContacts()).length;
    const result = await register('   ', { identifierSources: sourcesFrom(INBOX_LISTING) });
    expect(result.success).toBe(false);
    expect((await contactService.listContacts()).length).toBe(before);
  });

  it('stores a phone number in E.164, the form the send skills address', async () => {
    const result = await handler.execute(makeCtx({
      contactService,
      input: { channel: 'phone', identifier: '(416) 555-0100', displayName: 'Front Desk', messageTimestamp: TIMESTAMP_A },
      identifierSources: sourcesFrom('Front desk: 416-555-0100'),
    }));
    expect(result).toMatchObject({ success: true, data: { created: true, verified: true } });
    expect(await contactService.resolveByChannelIdentity('phone', '+14165550100')).not.toBeNull();
  });
});

// contact-register records agent_called, verified only when the identifier has a source
// (#2061). Only ceo-inbox, which registers senders it read from mail, may call it (#2041).
describe('contact-register manifest', () => {
  it('is callable by ceo-inbox only', () => {
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, 'tool.json'), 'utf-8')) as {
      allowed_callers?: string[];
    };
    expect(manifest.allowed_callers).toEqual(['ceo-inbox']);
  });
});
