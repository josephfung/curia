// handler.test.ts — unit tests for held-messages-process skill.
//
// Focused on the identify-with-existing-contact path: verifying that the handler
// promotes provisional contacts to 'confirmed' before replaying. Without this
// promotion, the dispatcher re-holds the replayed message because it treats
// provisional senders the same as unknown senders.

import { describe, it, expect, vi } from 'vitest';
import { HeldMessagesProcessHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';

const HELD_MSG = {
  id: 'held-1',
  channel: 'email',
  senderId: 'notify@x.com',
  conversationId: 'email:notify@x.com',
  content: 'Your account has been suspended',
  subject: 'Account suspended',
  status: 'pending' as const,
  metadata: {},
  createdAt: new Date(),
};

function makeCtx(inputOverrides?: Record<string, unknown>): SkillContext {
  return {
    input: {
      held_message_id: 'held-1',
      action: 'identify',
      existing_contact_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      ...inputOverrides,
    },
    heldMessages: {
      getById: vi.fn().mockResolvedValue(HELD_MSG),
      markProcessed: vi.fn().mockResolvedValue(true),
      discard: vi.fn().mockResolvedValue(true),
    },
    bus: {
      publish: vi.fn().mockResolvedValue(undefined),
    },
    contactService: {
      linkIdentity: vi.fn().mockResolvedValue(undefined),
      setStatus: vi.fn().mockResolvedValue({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', status: 'confirmed' }),
      setTrustLevel: vi.fn().mockResolvedValue(undefined),
      createContact: vi.fn(),
      resolveByChannelIdentity: vi.fn(),
      deleteContact: vi.fn(),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as SkillContext;
}

describe('HeldMessagesProcessHandler — identify with existing_contact_id', () => {
  it('promotes the contact to confirmed status before replaying', async () => {
    const ctx = makeCtx();
    const handler = new HeldMessagesProcessHandler();
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(ctx.contactService.setStatus).toHaveBeenCalledWith(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      'confirmed',
    );
    // setStatus must be called BEFORE bus.publish (replay) to avoid re-hold
    const setStatusOrder = (ctx.contactService.setStatus as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const busPublishOrder = (ctx.bus!.publish as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(setStatusOrder).toBeLessThan(busPublishOrder);
  });

  it('fails the operation when setStatus throws (avoids re-hold loop)', async () => {
    const ctx = makeCtx();
    (ctx.contactService.setStatus as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('DB connection timeout'),
    );
    const handler = new HeldMessagesProcessHandler();
    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toMatch(/re-hold loop/);
    expect(ctx.log.error).toHaveBeenCalled();
    // Replay must NOT fire — replaying with a provisional contact would re-hold
    expect(ctx.bus!.publish).not.toHaveBeenCalled();
    expect(ctx.heldMessages!.markProcessed).not.toHaveBeenCalled();
  });

  it('does not call setStatus for the new-contact path (already confirmed at creation)', async () => {
    const ctx = makeCtx({
      existing_contact_id: undefined,
      contact_name: 'X Notifications',
    });
    (ctx.contactService.createContact as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'new-contact-id',
    });
    const handler = new HeldMessagesProcessHandler();
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    // setStatus should NOT be called — createContact already uses status: 'confirmed'
    expect(ctx.contactService.setStatus).not.toHaveBeenCalled();
  });
});
