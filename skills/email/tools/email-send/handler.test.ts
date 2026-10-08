import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmailSendHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { OutboundGateway } from '../../../../src/skills/outbound-gateway.js';
import pino from 'pino';

function makeLogger() {
  return pino({ level: 'silent' });
}

const ALICE_ID = '11111111-1111-4111-8111-111111111111';
const MACHINE_ID = '22222222-2222-4222-8222-222222222222';

/**
 * Stands in for the gateway's reference resolver (#2033). The real resolution
 * rules are tested in tests/unit/skills/recipient-reference.test.ts; here only
 * the handler's use of the result matters.
 */
const resolveRecipientReference = vi.fn(async (_channel: string, value: string) => {
  if (value === 'principal') return { ok: true, kind: 'principal', contactId: 'principal-id', identifier: 'ceo@example.com', displayName: 'Principal' };
  if (value === ALICE_ID) return { ok: true, kind: 'contact', contactId: ALICE_ID, identifier: 'alice@example.com', displayName: 'Alice' };
  if (value === MACHINE_ID) return { ok: true, kind: 'contact', contactId: MACHINE_ID, identifier: 'machine@exchange.example', displayName: 'Exchange' };
  return { ok: false, error: `No contact for "${value}". Nothing was sent.` };
});

function makeCtx(input: Record<string, unknown>, opts?: { taskMetadata?: Record<string, unknown> }): ToolContext {
  const gateway = {
    send: vi.fn().mockResolvedValue({ success: true }),
    resolveRecipientReference,
  } as unknown as OutboundGateway;

  return {
    input,
    secret: (name: string) => { throw new Error(`Missing secret: ${name}`); },
    log: makeLogger(),
    outboundGateway: gateway,
    taskMetadata: opts?.taskMetadata,
  } as unknown as ToolContext;
}

describe('EmailSendHandler', () => {
  let handler: EmailSendHandler;

  beforeEach(() => {
    handler = new EmailSendHandler();
    resolveRecipientReference.mockClear();
  });

  it('returns error when to is missing', async () => {
    const ctx = makeCtx({ subject: 'Hello', body: 'Body text' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/to/);
  });

  it('returns error when subject is missing', async () => {
    const ctx = makeCtx({ to: ALICE_ID, body: 'Body text' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/subject/);
  });

  it('returns error when body is missing', async () => {
    const ctx = makeCtx({ to: ALICE_ID, subject: 'Hello' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/body/);
  });

  it('returns error when outboundGateway is not available', async () => {
    const ctx = makeCtx({ to: ALICE_ID, subject: 'Hello', body: 'Body' });
    (ctx as unknown as Record<string, unknown>).outboundGateway = undefined;
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/outboundGateway/);
  });

  it('sends an email and returns message_id, to, and subject', async () => {
    const ctx = makeCtx({ to: ALICE_ID, subject: 'Hello', body: 'Hi there' });
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, messageId: 'msg-123',
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).message_id).toBe('msg-123');
      expect((result.data as Record<string, unknown>).to).toBe('alice@example.com');
      expect((result.data as Record<string, unknown>).subject).toBe('Hello');
    }
    expect(ctx.outboundGateway!.send).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'email', to: 'alice@example.com', subject: 'Hello', body: 'Hi there' }),
      { taskEventId: undefined, conversationId: undefined },
    );
  });

  it('reads the quoted original and sends from the named account (#1832)', async () => {
    const ctx = makeCtx({
      to: ALICE_ID,
      subject: 'Re: Hello',
      body: 'Hi there',
      reply_to_message_id: 'msg-sec',
      account: 'personal',
    });
    const getEmailMessage = vi.fn().mockResolvedValue({
      from: [{ email: 'alice@example.com' }],
      to: [],
      cc: [],
      subject: 'Hello',
      body: '<p>Original</p>',
      date: 1700000000,
    });
    (ctx.outboundGateway as unknown as { getEmailMessage: ReturnType<typeof vi.fn> }).getEmailMessage = getEmailMessage;
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, messageId: 'msg-123',
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    expect(getEmailMessage).toHaveBeenCalledWith('msg-sec', 'personal');
    expect(ctx.outboundGateway!.send).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'personal', replyToMessageId: 'msg-sec' }),
      expect.anything(),
    );
  });

  it('rejects account on a new email that is not a threaded reply (#1832)', async () => {
    const ctx = makeCtx({
      to: ALICE_ID,
      subject: 'Hello',
      body: 'Hi there',
      account: 'ceo',
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/reply_to_message_id/);
    expect(ctx.outboundGateway!.send).not.toHaveBeenCalled();
  });

  it('returns error when gateway blocks the send', async () => {
    const ctx = makeCtx({ to: ALICE_ID, subject: 'Hello', body: 'Body' });
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false, blockedReason: 'Recipient is blocked',
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/blocked/i);
  });

  describe('attachments', () => {
    it('passes attachments to the gateway when provided', async () => {
      const ctx = makeCtx({
        to: ALICE_ID,
        subject: 'See attached',
        body: 'Please find attached.',
        attachments: [
          { file_url: 'file:///tmp/report.pdf', filename: 'report.pdf', content_type: 'application/pdf' },
        ],
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'msg-attach-1',
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      const callArgs = (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      expect(callArgs.attachments).toEqual([
        { fileUrl: 'file:///tmp/report.pdf', filename: 'report.pdf', contentType: 'application/pdf' },
      ]);
    });

    it('does not include attachments key when attachments is undefined', async () => {
      const ctx = makeCtx({
        to: ALICE_ID,
        subject: 'Hello',
        body: 'Hi there',
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'msg-1',
      });

      await handler.execute(ctx);

      const callArgs = (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      expect(callArgs.attachments).toBeUndefined();
    });

    it('returns error when attachments is not an array', async () => {
      const ctx = makeCtx({
        to: ALICE_ID,
        subject: 'Hello',
        body: 'Hi',
        attachments: 'not-an-array',
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('array');
      expect(ctx.outboundGateway!.send).not.toHaveBeenCalled();
    });

    it('returns error when an attachment entry is missing file_url', async () => {
      const ctx = makeCtx({
        to: ALICE_ID,
        subject: 'Hello',
        body: 'Hi',
        attachments: [{ filename: 'a.pdf', content_type: 'application/pdf' }],
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('file_url');
      expect(ctx.outboundGateway!.send).not.toHaveBeenCalled();
    });
  });

  describe('context_bridge', () => {
    it('registers a context bridge entry after successful send', async () => {
      const ctx = makeCtx({
        to: ALICE_ID,
        subject: 'Meeting follow-up',
        body: 'Any thoughts on the proposal?',
        context_bridge: JSON.stringify({
          agent_id: 'meeting-debrief',
          expected_reply: 'Proposal feedback',
          delegation_hint: 'Delegate to meeting-debrief',
          expires_in_hours: 72,
        }),
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
        channelId: 'email',
        agentId: 'meeting-debrief',
        content: 'Any thoughts on the proposal?',
        expectedReply: 'Proposal feedback',
        delegationHint: 'Delegate to meeting-debrief',
        expiresInHours: 72,
        ttlSource: 'agent',
      });
    });

    it('registers a minimal entry when context_bridge is absent', async () => {
      const ctx = makeCtx({
        to: ALICE_ID,
        subject: 'Hello',
        body: 'Hi there',
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
        channelId: 'email',
        agentId: 'coordinator',
        content: 'Hi there',
        // Email's channel default, not the flat 6h that expired before
        // next-business-day replies could land (#1816).
        expiresInHours: 72,
        ttlSource: 'channel-default',
      });
    });

    it('logs warning but succeeds when bridge registration fails', async () => {
      const ctx = makeCtx({
        to: ALICE_ID,
        subject: 'Hello',
        body: 'Hi there',
        context_bridge: JSON.stringify({ agent_id: 'coordinator' }),
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'msg-1',
      });
      const mockRegister = vi.fn().mockRejectedValue(new Error('DB error'));
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

  describe('send by reference (#2033)', () => {
    it('resolves to through the gateway and sends to the looked-up address', async () => {
      const ctx = makeCtx({ to: ALICE_ID, subject: 'Hello', body: 'Hi there' });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, messageId: 'msg-9' });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      expect(resolveRecipientReference).toHaveBeenCalledWith('email', ALICE_ID, { field: 'to' });
      expect(ctx.outboundGateway!.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'alice@example.com', cc: undefined }),
        expect.anything(),
      );
      if (result.success) expect(result.data).toMatchObject({ to: 'alice@example.com', contact_id: ALICE_ID });
    });

    it('resolves cc references', async () => {
      const ctx = makeCtx({
        to: 'principal',
        cc: ALICE_ID,
        subject: 'Hello',
        body: 'Hi there',
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      expect(resolveRecipientReference).toHaveBeenCalledWith('email', ALICE_ID, { field: 'cc' });
      expect(ctx.outboundGateway!.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'ceo@example.com', cc: ['alice@example.com'] }),
        expect.anything(),
      );
    });

    it('sends nothing when a reference does not resolve', async () => {
      const ctx = makeCtx({ to: 'principle', subject: 'Hello', body: 'Hi there' });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/Nothing was sent/);
      expect(ctx.outboundGateway!.send).not.toHaveBeenCalled();
    });

    it('sends nothing when one cc reference does not resolve', async () => {
      const ctx = makeCtx({ to: 'principal', cc: `${ALICE_ID}, nobody`, subject: 'Hello', body: 'Hi there' });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(false);
      expect(ctx.outboundGateway!.send).not.toHaveBeenCalled();
    });

    it('refuses a retired input beside to (#2041)', async () => {
      const ctx = makeCtx({ to: 'principal', to_address: 'alice@example.com', subject: 'Hello', body: 'Hi' });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/no longer accepted/);
        expect(result.error).toMatch(/contact-create/);
      }
      expect(ctx.outboundGateway!.send).not.toHaveBeenCalled();
    });

    it.each([
      ['to_address', { to_address: 'a@x.example' }],
      ['cc_addresses', { to: ALICE_ID, cc_addresses: 'b@x.example' }],
      ['cc_addresses as an array', { to: ALICE_ID, cc_addresses: ['b@x.example'] }],
    ])('refuses retired %s (#2041)', async (_label, fields) => {
      const ctx = makeCtx({ ...fields, subject: 'S', body: 'B' });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/no longer accepted/);
      expect(ctx.outboundGateway!.send).not.toHaveBeenCalled();
    });

    it.each([[{ to_address: '' }], [{ cc_addresses: '  ' }], [{ cc_addresses: [] }], [{ to_address: null }]])(
      'ignores a blank retired input %o (Review Focus 1)',
      async (fields) => {
        expect((await handler.execute(makeCtx({ to: ALICE_ID, ...fields, subject: 'S', body: 'B' }))).success).toBe(true);
      },
    );

    it('rejects more than one reference in to', async () => {
      const ctx = makeCtx({ to: `principal, ${ALICE_ID}`, subject: 'Hello', body: 'Hi' });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/single To recipient/);
    });

    it('omits contact_id for the principal alias', async () => {
      const ctx = makeCtx({ to: 'principal', subject: 'Hello', body: 'Hi' });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      if (result.success) expect(result.data).not.toHaveProperty('contact_id');
    });
  });

  describe('auto-generated sender suppress (#1734)', () => {
    it('blocks email-send to the machine sender when autoGeneratedSuppress is stamped', async () => {
      const ctx = makeCtx(
        { to: MACHINE_ID, subject: 'Ack', body: 'Got it' },
        {
          taskMetadata: {
            autoGeneratedSuppress: true,
            autoGeneratedSenderId: 'machine@exchange.example',
          },
        },
      );

      const result = await handler.execute(ctx);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/auto-generated/i);
      expect(ctx.outboundGateway!.send).not.toHaveBeenCalled();
    });

    it('allows email-send to the principal on an auto-generated turn', async () => {
      const ctx = makeCtx(
        { to: 'principal', subject: 'Escalation', body: 'Calendar decline from Alice' },
        {
          taskMetadata: {
            autoGeneratedSuppress: true,
            autoGeneratedSenderId: 'machine@exchange.example',
          },
        },
      );

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      expect(ctx.outboundGateway!.send).toHaveBeenCalled();
    });
  });
});
