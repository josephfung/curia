import { describe, it, expect, beforeEach } from 'vitest';
import pino from 'pino';
import { ContactRegisterHandler } from './handler.js';
import { ContactService } from '../../src/contacts/contact-service.js';
import type { SkillContext } from '../../src/skills/types.js';

const silentLog = pino({ level: 'silent' });

function makeCtx(overrides: Partial<SkillContext> = {}): SkillContext {
  return {
    input: {},
    secret: () => 'unused',
    log: silentLog,
    ...overrides,
  } as unknown as SkillContext;
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

    // Seed a known confirmed contact with an email identity
    const contact = await contactService.createContact({
      displayName: 'Alice Nguyen',
      role: 'Head of Product',
      status: 'confirmed',
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
    expect(data.status).toBe('confirmed');
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

  it('creates a provisional contact for an unknown email address', async () => {
    const ctx = makeCtx({
      contactService,
      input: { channel: 'email', identifier: 'newperson@example.com', displayName: 'New Person', messageTimestamp: TIMESTAMP_A },
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: Record<string, unknown> }).data;
    expect(data.status).toBe('provisional');
    expect(data.display_name).toBe('New Person');
    expect(data.created).toBe(true);
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

    // Seed a known contact
    const contact = await contactService.createContact({
      displayName: 'Bob Smith',
      status: 'confirmed',
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
      status: 'confirmed',
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
      confidencePipeline: mockPipeline as SkillContext['confidencePipeline'],
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
      confidencePipeline: mockPipeline as SkillContext['confidencePipeline'],
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
      status: 'confirmed',
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
      bus: mockBus as SkillContext['bus'],
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
