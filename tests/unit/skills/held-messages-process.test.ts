// Tests for the held-messages-process skill handler.
//
// Focuses on the "identify" action and the idempotent linkIdentity path —
// specifically the case where contact-merge has already linked the sender's
// channel identity before held-messages-process runs.

import { describe, it, expect, vi } from 'vitest';
import { HeldMessagesProcessHandler } from '../../../skills/held-messages-process/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';
import type { HeldMessage } from '../../../src/contacts/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

const HELD_MSG_ID = '30b0b0be-3825-4039-9698-05b1893abd1c';
const CONTACT_ID  = '38268ca5-ed50-4a59-a0e4-d7dba13e0eac';
const OTHER_CONTACT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const pendingMsg: HeldMessage = {
  id: HELD_MSG_ID,
  channel: 'email',
  senderId: 'donna@example.com',
  conversationId: 'email:abc123',
  content: 'Hi!',
  subject: 'Hello',
  metadata: {},
  status: 'pending',
  resolvedContactId: null,
  createdAt: new Date('2026-04-13T14:00:00Z'),
  processedAt: null,
};

function makeBus() {
  return { publish: vi.fn().mockResolvedValue(undefined) };
}

function makeCtx(
  input: Record<string, unknown>,
  overrides?: Partial<SkillContext>,
): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    ...overrides,
  };
}

describe('HeldMessagesProcessHandler — identify action', () => {
  const handler = new HeldMessagesProcessHandler();

  it('returns failure when required services are missing', async () => {
    const result = await handler.execute(makeCtx({
      held_message_id: HELD_MSG_ID,
      action: 'identify',
      existing_contact_id: CONTACT_ID,
    }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Required services');
  });

  it('returns failure when action is invalid', async () => {
    const result = await handler.execute(makeCtx({
      held_message_id: HELD_MSG_ID,
      action: 'explode',
    }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Invalid action');
  });

  it('successfully identifies and replays when linkIdentity succeeds', async () => {
    const heldMessages = {
      getById: vi.fn().mockResolvedValue(pendingMsg),
      markProcessed: vi.fn().mockResolvedValue(true),
    };
    const contactService = {
      linkIdentity: vi.fn().mockResolvedValue({ id: 'identity-1' }),
      resolveByChannelIdentity: vi.fn(),
    };
    const bus = makeBus();

    const result = await handler.execute(makeCtx(
      { held_message_id: HELD_MSG_ID, action: 'identify', existing_contact_id: CONTACT_ID },
      { heldMessages: heldMessages as never, contactService: contactService as never, bus: bus as never },
    ));

    expect(result.success).toBe(true);
    expect(contactService.linkIdentity).toHaveBeenCalledWith(expect.objectContaining({
      contactId: CONTACT_ID,
      channel: 'email',
      channelIdentifier: 'donna@example.com',
    }));
    expect(bus.publish).toHaveBeenCalledOnce();
    expect(heldMessages.markProcessed).toHaveBeenCalledWith(HELD_MSG_ID, CONTACT_ID);
    if (result.success) expect(result.data).toMatchObject({ result: 'identified_and_replayed' });
  });

  it('treats duplicate-key error as no-op when identity already belongs to the target contact', async () => {
    // This is the scenario that caused the prod bug: contact-merge linked
    // donna@example.com to CONTACT_ID before held-messages-process ran.
    // linkIdentity throws the unique constraint violation, but the identity
    // is already on the correct contact — so we should still markProcessed.
    const heldMessages = {
      getById: vi.fn().mockResolvedValue(pendingMsg),
      markProcessed: vi.fn().mockResolvedValue(true),
    };
    const contactService = {
      linkIdentity: vi.fn().mockRejectedValue(
        new Error('duplicate key value violates unique constraint "contact_channel_identities_channel_channel_identifier_key"'),
      ),
      resolveByChannelIdentity: vi.fn().mockResolvedValue({
        contactId: CONTACT_ID,
        displayName: 'Donna',
        role: null,
        status: 'confirmed',
        trustLevel: null,
      }),
    };
    const bus = makeBus();

    const result = await handler.execute(makeCtx(
      { held_message_id: HELD_MSG_ID, action: 'identify', existing_contact_id: CONTACT_ID },
      { heldMessages: heldMessages as never, contactService: contactService as never, bus: bus as never },
    ));

    expect(result.success).toBe(true);
    expect(contactService.resolveByChannelIdentity).toHaveBeenCalledWith('email', 'donna@example.com');
    expect(bus.publish).toHaveBeenCalledOnce();
    expect(heldMessages.markProcessed).toHaveBeenCalledWith(HELD_MSG_ID, CONTACT_ID);
    if (result.success) expect(result.data).toMatchObject({ result: 'identified_and_replayed' });
  });

  it('returns failure when identity belongs to a different contact (real conflict)', async () => {
    const heldMessages = {
      getById: vi.fn().mockResolvedValue(pendingMsg),
      markProcessed: vi.fn(),
    };
    const contactService = {
      linkIdentity: vi.fn().mockRejectedValue(
        new Error('duplicate key value violates unique constraint "contact_channel_identities_channel_channel_identifier_key"'),
      ),
      resolveByChannelIdentity: vi.fn().mockResolvedValue({
        contactId: OTHER_CONTACT_ID,  // owned by a different contact
        displayName: 'Someone Else',
        role: null,
        status: 'confirmed',
        trustLevel: null,
      }),
    };
    const bus = makeBus();

    const result = await handler.execute(makeCtx(
      { held_message_id: HELD_MSG_ID, action: 'identify', existing_contact_id: CONTACT_ID },
      { heldMessages: heldMessages as never, contactService: contactService as never, bus: bus as never },
    ));

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('already linked to a different contact');
    expect(bus.publish).not.toHaveBeenCalled();
    expect(heldMessages.markProcessed).not.toHaveBeenCalled();
  });

  it('re-throws non-duplicate errors from linkIdentity', async () => {
    const heldMessages = {
      getById: vi.fn().mockResolvedValue(pendingMsg),
      markProcessed: vi.fn(),
    };
    const contactService = {
      linkIdentity: vi.fn().mockRejectedValue(new Error('connection timeout')),
      resolveByChannelIdentity: vi.fn(),
    };
    const bus = makeBus();

    const result = await handler.execute(makeCtx(
      { held_message_id: HELD_MSG_ID, action: 'identify', existing_contact_id: CONTACT_ID },
      { heldMessages: heldMessages as never, contactService: contactService as never, bus: bus as never },
    ));

    // Non-duplicate errors fall through to the outer catch and return a failure message
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('connection timeout');
    expect(contactService.resolveByChannelIdentity).not.toHaveBeenCalled();
    expect(heldMessages.markProcessed).not.toHaveBeenCalled();
  });
});

describe('HeldMessagesProcessHandler — dismiss action', () => {
  const handler = new HeldMessagesProcessHandler();

  it('discards the held message', async () => {
    const heldMessages = {
      getById: vi.fn().mockResolvedValue(pendingMsg),
      discard: vi.fn().mockResolvedValue(true),
    };
    const contactService = { linkIdentity: vi.fn() };
    const bus = makeBus();

    const result = await handler.execute(makeCtx(
      { held_message_id: HELD_MSG_ID, action: 'dismiss' },
      { heldMessages: heldMessages as never, contactService: contactService as never, bus: bus as never },
    ));

    expect(result.success).toBe(true);
    expect(heldMessages.discard).toHaveBeenCalledWith(HELD_MSG_ID);
    if (result.success) expect(result.data).toMatchObject({ result: 'dismissed' });
  });
});
