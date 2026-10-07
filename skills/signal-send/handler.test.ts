import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignalSendHandler } from './handler.js';
import type { ToolContext } from '../../src/skills/types.js';
import type { OutboundGateway } from '../../src/skills/outbound-gateway.js';
import type { ContactService } from '../../src/contacts/contact-service.js';
import pino from 'pino';

function makeLogger() {
  return pino({ level: 'silent' });
}

const ALICE_ID = '11111111-1111-4111-8111-111111111111';

/** Stands in for the gateway's reference resolver (#2033); its rules are tested elsewhere. */
const resolveRecipientReference = vi.fn(async (_channel: string, value: string) => {
  if (value === 'principal') return { ok: true, kind: 'principal', contactId: 'principal-id', identifier: '+15195550100', displayName: 'Principal' };
  if (value === ALICE_ID) return { ok: true, kind: 'contact', contactId: ALICE_ID, identifier: 'alice-not-e164', displayName: 'Alice' };
  return { ok: false, error: `No contact for "${value}". Nothing was sent.` };
});

function makeCtx(overrides: {
  input?: Record<string, unknown>;
  gateway?: Partial<OutboundGateway>;
  contactService?: Partial<ContactService>;
}): ToolContext {
  const gateway = {
    send: vi.fn().mockResolvedValue({ success: true }),
    getSignalGroupMembers: vi.fn().mockResolvedValue([]),
    resolveRecipientReference,
    ...overrides.gateway,
  } as unknown as OutboundGateway;

  const contactService = {
    resolveByChannelIdentity: vi.fn().mockResolvedValue({ contactId: 'c1', tier: 'known' }),
    ...overrides.contactService,
  } as unknown as ContactService;

  return {
    input: overrides.input ?? {},
    secret: () => '',
    log: makeLogger(),
    outboundGateway: gateway,
    contactService,
  } as unknown as ToolContext;
}

describe('SignalSendHandler', () => {
  let handler: SignalSendHandler;

  beforeEach(() => {
    handler = new SignalSendHandler();
  });

  it('returns error when message is missing', async () => {
    const ctx = makeCtx({ input: { recipient_number: '+14155551234' } });
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
    const ctx = makeCtx({ input: { recipient_number: '+14155551234', group_id: 'grpABC==', message: 'hi' } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/exactly one of recipient, recipient_number, or group_id/);
  });

  it('returns error when both recipient and recipient_number are provided', async () => {
    const ctx = makeCtx({ input: { recipient: 'principal', recipient_number: '+14155551234', message: 'hi' } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    expect(ctx.outboundGateway!.send).not.toHaveBeenCalled();
  });

  describe('send by reference (#2033)', () => {
    beforeEach(() => resolveRecipientReference.mockClear());

    it('resolves recipient through the gateway and sends to the looked-up number', async () => {
      const gateway = { send: vi.fn().mockResolvedValue({ success: true }) };
      const ctx = makeCtx({ input: { recipient: 'principal', message: 'hello' }, gateway });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      expect(resolveRecipientReference).toHaveBeenCalledWith('signal', 'principal', { field: 'recipient', rawField: 'recipient_number' });
      expect(gateway.send).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'signal', recipient: '+15195550100' }),
        expect.anything(),
      );
      if (result.success) {
        expect(result.data).toMatchObject({ delivered_to: '+15195550100' });
        // Alias sends never echo the principal's contact ID (spec 09).
        expect(result.data).not.toHaveProperty('contact_id');
      }
    });

    it('sends nothing when the reference does not resolve', async () => {
      const gateway = { send: vi.fn() };
      const ctx = makeCtx({ input: { recipient: 'principle', message: 'hello' }, gateway });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/Nothing was sent/);
      expect(gateway.send).not.toHaveBeenCalled();
    });

    it('refuses a stored identity that is not E.164', async () => {
      const gateway = { send: vi.fn() };
      const ctx = makeCtx({ input: { recipient: ALICE_ID, message: 'hello' }, gateway });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/not an E\.164 number/);
      expect(gateway.send).not.toHaveBeenCalled();
    });
  });

  it('returns error when recipient is not a valid E.164 number', async () => {
    const ctx = makeCtx({ input: { recipient_number: 'not-a-phone', message: 'hi' } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/E\.164/);
  });

  it('returns error when message exceeds max length', async () => {
    const ctx = makeCtx({ input: { recipient_number: '+14155551234', message: 'x'.repeat(10_001) } });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/10.000|10,000/);
  });

  it('returns error when outboundGateway is not available', async () => {
    const ctx = makeCtx({ input: { recipient_number: '+14155551234', message: 'hi' } });
    (ctx as unknown as Record<string, unknown>).outboundGateway = undefined;
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/outboundGateway/);
  });

  it('sends a 1:1 Signal message and returns delivered_to', async () => {
    const gateway = { send: vi.fn().mockResolvedValue({ success: true }) };
    const ctx = makeCtx({ input: { recipient_number: '+14155551234', message: 'hello' }, gateway });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).delivered_to).toBe('+14155551234');
      expect((result.data as Record<string, unknown>).channel).toBe('signal');
    }
    expect(gateway.send).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'signal', recipient: '+14155551234', message: 'hello' }),
      { taskEventId: undefined, conversationId: undefined },
    );
  });

  it('returns error when gateway blocks the 1:1 send', async () => {
    const gateway = { send: vi.fn().mockResolvedValue({ success: false, blockedReason: 'Recipient is blocked' }) };
    const ctx = makeCtx({ input: { recipient_number: '+14155551234', message: 'hi' }, gateway });

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
      resolveByChannelIdentity: vi.fn().mockResolvedValue({ contactId: 'c1', tier: 'known' }),
    };
    const ctx = makeCtx({ input: { group_id: 'grpABC==', message: 'team update' }, gateway, contactService });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).delivered_to).toBe('grpABC==');
    }
    expect(gateway.send).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'signal', groupId: 'grpABC==', message: 'team update' }),
      { taskEventId: undefined, conversationId: undefined },
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
      resolveByChannelIdentity: vi.fn().mockResolvedValue({ contactId: 'c1', tier: 'blocked' }),
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

  describe('context_bridge', () => {
    it('registers a context bridge entry after successful 1:1 send', async () => {
      const ctx = makeCtx({
        input: {
          recipient_number: '+14155551234',
          message: 'Any takeaways?',
          context_bridge: JSON.stringify({
            agent_id: 'meeting-debrief',
            expected_reply: 'Meeting notes',
            delegation_hint: 'Delegate to meeting-debrief',
            metadata: { meeting: 'sync' },
            expires_in_hours: 48,
          }),
        },
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'msg-1',
      });
      const mockRegister = vi.fn().mockResolvedValue('entry-1');
      (ctx as unknown as Record<string, unknown>).outboundContext = {
        register: mockRegister,
        release: vi.fn(),
        defaultExpiryHours: 6,
        explicitExpiryHours: 24,
        defaultExpiryHoursFor: (channelId: string) => (channelId === 'email' ? 72 : 6),
      };
      (ctx as unknown as Record<string, unknown>).agentId = 'coordinator';

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      expect(mockRegister).toHaveBeenCalledWith({
        channelId: 'signal',
        agentId: 'meeting-debrief',
        content: 'Any takeaways?',
        expectedReply: 'Meeting notes',
        delegationHint: 'Delegate to meeting-debrief',
        metadata: { meeting: 'sync' },
        expiresInHours: 48,
        ttlSource: 'agent',
      });
    });

    it('registers a minimal entry when context_bridge is absent', async () => {
      const ctx = makeCtx({
        input: { recipient_number: '+14155551234', message: 'Hello' },
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'msg-1',
      });
      const mockRegister = vi.fn().mockResolvedValue('entry-1');
      (ctx as unknown as Record<string, unknown>).outboundContext = {
        register: mockRegister,
        release: vi.fn(),
        defaultExpiryHours: 6,
        explicitExpiryHours: 24,
        defaultExpiryHoursFor: (channelId: string) => (channelId === 'email' ? 72 : 6),
      };
      (ctx as unknown as Record<string, unknown>).agentId = 'coordinator';

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      expect(mockRegister).toHaveBeenCalledWith({
        channelId: 'signal',
        agentId: 'coordinator',
        content: 'Hello',
        expiresInHours: 6,
        ttlSource: 'channel-default',
      });
    });

    it('does not register when send fails', async () => {
      const ctx = makeCtx({
        input: {
          recipient_number: '+14155551234',
          message: 'Hello',
          context_bridge: JSON.stringify({ agent_id: 'coordinator' }),
        },
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false, blockedReason: 'Blocked',
      });
      const mockRegister = vi.fn();
      (ctx as unknown as Record<string, unknown>).outboundContext = {
        register: mockRegister,
        release: vi.fn(),
        defaultExpiryHours: 6,
        explicitExpiryHours: 24,
        defaultExpiryHoursFor: (channelId: string) => (channelId === 'email' ? 72 : 6),
      };

      const result = await handler.execute(ctx);

      expect(result.success).toBe(false);
      expect(mockRegister).not.toHaveBeenCalled();
    });

    it('logs a warning but succeeds when context bridge registration fails', async () => {
      const ctx = makeCtx({
        input: {
          recipient_number: '+14155551234',
          message: 'Hello',
          context_bridge: JSON.stringify({ agent_id: 'coordinator' }),
        },
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'msg-1',
      });
      const mockRegister = vi.fn().mockRejectedValue(new Error('DB down'));
      (ctx as unknown as Record<string, unknown>).outboundContext = {
        register: mockRegister,
        release: vi.fn(),
        defaultExpiryHours: 6,
        explicitExpiryHours: 24,
        defaultExpiryHoursFor: (channelId: string) => (channelId === 'email' ? 72 : 6),
      };
      (ctx as unknown as Record<string, unknown>).agentId = 'coordinator';

      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
    });
  });
});
