import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignalSendHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { OutboundGateway } from '../../src/skills/outbound-gateway.js';
import type { ContactService } from '../../src/contacts/contact-service.js';
import pino from 'pino';

function makeLogger() {
  return pino({ level: 'silent' });
}

function makeCtx(overrides: {
  input?: Record<string, unknown>;
  gateway?: Partial<OutboundGateway>;
  contactService?: Partial<ContactService>;
}): SkillContext {
  const gateway = {
    send: vi.fn().mockResolvedValue({ success: true }),
    getSignalGroupMembers: vi.fn().mockResolvedValue([]),
    ...overrides.gateway,
  } as unknown as OutboundGateway;

  const contactService = {
    resolveByChannelIdentity: vi.fn().mockResolvedValue({ contactId: 'c1', status: 'active' }),
    ...overrides.contactService,
  } as unknown as ContactService;

  return {
    input: overrides.input ?? {},
    secret: () => '',
    log: makeLogger(),
    outboundGateway: gateway,
    contactService,
  } as unknown as SkillContext;
}

describe('SignalSendHandler', () => {
  let handler: SignalSendHandler;

  beforeEach(() => {
    handler = new SignalSendHandler();
  });

  it('returns error when message is missing', async () => {
    const ctx = makeCtx({ input: { recipient: '+14155551234' } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/message/);
  });

  it('returns error when neither recipient nor group_id is provided', async () => {
    const ctx = makeCtx({ input: { message: 'hello' } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/recipient|group_id/);
  });

  it('returns error when both recipient and group_id are provided', async () => {
    const ctx = makeCtx({ input: { recipient: '+14155551234', group_id: 'grpABC==', message: 'hi' } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/either.*not both|not both/i);
  });

  it('returns error when recipient is not a valid E.164 number', async () => {
    const ctx = makeCtx({ input: { recipient: 'not-a-phone', message: 'hi' } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/E\.164/);
  });

  it('returns error when message exceeds max length', async () => {
    const ctx = makeCtx({ input: { recipient: '+14155551234', message: 'x'.repeat(10_001) } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/10.000|10,000/);
  });

  it('returns error when outboundGateway is not available', async () => {
    const ctx = makeCtx({ input: { recipient: '+14155551234', message: 'hi' } });
    (ctx as Record<string, unknown>).outboundGateway = undefined;
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/outboundGateway/);
  });

  it('sends a 1:1 Signal message and returns delivered_to', async () => {
    const gateway = { send: vi.fn().mockResolvedValue({ success: true }) };
    const ctx = makeCtx({ input: { recipient: '+14155551234', message: 'hello' }, gateway });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).delivered_to).toBe('+14155551234');
      expect((result.data as Record<string, unknown>).channel).toBe('signal');
    }
    expect(gateway.send).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'signal', recipient: '+14155551234', message: 'hello' }),
    );
  });

  it('returns error when gateway blocks the 1:1 send', async () => {
    const gateway = { send: vi.fn().mockResolvedValue({ success: false, blockedReason: 'Recipient is blocked' }) };
    const ctx = makeCtx({ input: { recipient: '+14155551234', message: 'hi' }, gateway });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/blocked/i);
  });

  it('sends a group Signal message when all members are trusted', async () => {
    const gateway = {
      send: vi.fn().mockResolvedValue({ success: true }),
      getSignalGroupMembers: vi.fn().mockResolvedValue(['+14155551234']),
    };
    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue({ contactId: 'c1', status: 'active' }),
    };
    const ctx = makeCtx({ input: { group_id: 'grpABC==', message: 'team update' }, gateway, contactService });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).delivered_to).toBe('grpABC==');
    }
    expect(gateway.send).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'signal', groupId: 'grpABC==', message: 'team update' }),
    );
  });

  it('returns error listing unknown phones when a group member is unverified', async () => {
    const gateway = {
      send: vi.fn(),
      getSignalGroupMembers: vi.fn().mockResolvedValue(['+14155551234']),
    };
    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
    };
    const ctx = makeCtx({ input: { group_id: 'grpABC==', message: 'hi' }, gateway, contactService });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/\+14155551234/);
      expect(result.error).toMatch(/verified|verify/i);
    }
    expect(gateway.send).not.toHaveBeenCalled();
  });

  it('returns error (no phone list) when a group member is blocked', async () => {
    const gateway = {
      send: vi.fn(),
      getSignalGroupMembers: vi.fn().mockResolvedValue(['+14155551234']),
    };
    const contactService = {
      resolveByChannelIdentity: vi.fn().mockResolvedValue({ contactId: 'c1', status: 'blocked' }),
    };
    const ctx = makeCtx({ input: { group_id: 'grpABC==', message: 'hi' }, gateway, contactService });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/blocked/i);
    expect(result.success === false && result.error).not.toMatch(/\+14155551234/);
    expect(gateway.send).not.toHaveBeenCalled();
  });

  it('returns error when getSignalGroupMembers throws', async () => {
    const gateway = {
      send: vi.fn(),
      getSignalGroupMembers: vi.fn().mockRejectedValue(new Error('group not found: grpXYZ==')),
    };
    const ctx = makeCtx({ input: { group_id: 'grpXYZ==', message: 'hi' }, gateway });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/group/i);
    expect(gateway.send).not.toHaveBeenCalled();
  });
});
