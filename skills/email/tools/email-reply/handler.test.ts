import { describe, it, expect, vi, beforeEach } from 'vitest';
import { REDACTION_NOTE } from '../../../../src/skills/_shared/principal-directed.js';
import { EmailReplyHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { OutboundGateway } from '../../../../src/skills/outbound-gateway.js';
import pino from 'pino';
import { ContactService } from '../../../../src/contacts/contact-service.js';
import { resolveRecipientReference } from '../../../../src/skills/_shared/recipient-reference.js';
import { TaskOutreachService } from '../../../../src/dispatch/task-outreach-capability.js';
import type { TaskOutreachInput, TaskOutreachRepo, TaskOutreachRow } from '../../../../src/dispatch/task-outreach.js';

function makeLogger() {
  return pino({ level: 'silent' });
}

function makeCtx(input: Record<string, unknown>, opts?: { timezone?: string; taskMetadata?: Record<string, unknown> }): ToolContext {
  const gateway = {
    send: vi.fn().mockResolvedValue({ success: true }),
    getEmailMessage: vi.fn().mockResolvedValue({
      from: [{ email: 'alice@example.com' }],
      to: [],
      cc: [],
      subject: 'Test subject',
      body: '',
      date: 0,
    }),
  } as unknown as OutboundGateway;

  return {
    input,
    secret: (name: string) => { throw new Error(`Missing secret: ${name}`); },
    log: makeLogger(),
    outboundGateway: gateway,
    timezone: opts?.timezone,
    taskMetadata: opts?.taskMetadata,
  } as unknown as ToolContext;
}

describe('EmailReplyHandler', () => {
  let handler: EmailReplyHandler;

  beforeEach(() => {
    handler = new EmailReplyHandler();
  });

  it('returns error when reply_to_message_id is missing', async () => {
    const ctx = makeCtx({ body: 'Reply body' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/reply_to_message_id/);
  });

  it('rejects an outbound_context entry_id UUID before calling the gateway (#1817)', async () => {
    const ctx = makeCtx({
      reply_to_message_id: 'f97d6a62-0ec4-4751-96c3-2538eb364f06',
      body: 'Thanks!',
    });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/outbound_context entry_id/);
      expect(result.error).toMatch(/Nylas message ID/);
      expect(result.error).toMatch(/context-bridge-release/);
    }
    expect(ctx.outboundGateway!.getEmailMessage).not.toHaveBeenCalled();
    expect(ctx.outboundGateway!.send).not.toHaveBeenCalled();
  });

  it('returns error when body is missing', async () => {
    const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1' });
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/body/);
  });

  it('returns error when outboundGateway is not available', async () => {
    const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1', body: 'Reply body' });
    (ctx as unknown as Record<string, unknown>).outboundGateway = undefined;
    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/outboundGateway/);
  });

  it('replies to sender and returns expected fields', async () => {
    const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1', body: 'Thanks!' });
    (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      from: [{ email: 'alice@example.com' }],
      to: [],
      cc: [],
      subject: 'Project update',
      body: '',
      date: 0,
    });
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, messageId: 'reply-123',
    });

    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).message_id).toBe('reply-123');
      expect((result.data as Record<string, unknown>).to).toBe('alice@example.com');
      expect((result.data as Record<string, unknown>).subject).toBe('Re: Project update');
    }
    // No Authentication-Results: the reply still sends, without reply provenance.
    // Absent headers fail closed (#2071).
    expect(ctx.outboundGateway!.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'alice@example.com', replyToMessageId: 'nylas-msg-1' }),
      expect.not.objectContaining({ recipientSource: 'email_participant' }),
    );
    // Replayed on approval if band review holds the send (#2159).
    expect(ctx.outboundGateway!.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        holdRecipe: { toolName: 'email-reply', partialPayload: ctx.input, description: 'Email reply to alice@example.com — "Re: Project update"' },
      }),
    );
  });

  it('passes email_participant when auth passes and the sender is not an owned mailbox (#2071)', async () => {
    const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1', body: 'Thanks!' });
    ctx.selfEmails = ['curia@example.com'];
    (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      from: [{ email: 'alice@example.com', name: 'Alice' }],
      to: [],
      cc: [],
      subject: 'Project update',
      body: '',
      date: 0,
      headers: [{ name: 'Authentication-Results', value: 'mx.google.com; spf=pass; dkim=pass; dmarc=pass' }],
    });
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, messageId: 'reply-123',
    });

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    expect(ctx.outboundGateway!.send).toHaveBeenCalledWith(
      expect.not.objectContaining({ recipientSource: expect.anything() }),
      expect.objectContaining({
        recipientSource: 'email_participant',
        recipientDisplayName: 'Alice',
      }),
    );
  });

  it('drops reply provenance when the From is an owned mailbox (#2071)', async () => {
    const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1', body: 'Thanks!' });
    ctx.selfEmails = ['alice+tag@example.com'];
    (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      from: [{ email: 'Alice@example.com', name: 'Alice' }],
      to: [{ email: 'bob@example.com', name: 'Bob' }],
      cc: [],
      subject: 'Sent',
      body: '',
      date: 0,
      headers: [{ name: 'Authentication-Results', value: 'mx.google.com; spf=pass; dkim=pass; dmarc=pass' }],
    });
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, messageId: 'reply-123',
    });

    const result = await handler.execute(ctx);
    expect(result.success).toBe(true);
    const options = (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<string, unknown>;
    expect(options).not.toHaveProperty('recipientSource');
    expect(options).not.toHaveProperty('recipientDisplayName');
  });

  // GHSA-p49r-jqh2-v668: on a turn a principal-matching but unverified message started (a
  // forged From, an SMS), a reply never fans out: what the principal may read must not reach
  // an address the forger put on the thread.
  describe('on an unverified principal turn', () => {
    const UNVERIFIED = {
      originator: { contactId: 'principal-id', systemRole: 'principal', authenticated: false, channel: 'email', tier: 'principal', initiatedAt: '2026-11-17T00:00:00Z' },
    };
    const forged = {
      from: [{ email: 'boss@example.com' }],
      to: [{ email: 'nathan@example.com' }, { email: 'partner@example.com' }],
      cc: [{ email: 'attacker@example.com' }],
      subject: 'Calendar', body: '', date: 0,
    };

    it('replies to the sender only, never reply-all', async () => {
      const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1', body: 'Your week: ...' }, { taskMetadata: UNVERIFIED });
      ctx.selfEmails = ['nathan@example.com'];
      (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue(forged);
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, messageId: 'reply-1' });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      const request = (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      expect(request['to']).toBe('boss@example.com');
      expect(request['additionalTo']).toBeUndefined();
      expect(request['cc']).toBeUndefined();
    });

    // A demoted wake carries an agent originator, so only the input says the request was
    // unverified. The gateway must still hear it, so a hold goes to a verified channel only.
    it('tells the gateway the requester is unverified when only the input carries sender_only', async () => {
      const DEMOTED = { originator: { ...UNVERIFIED.originator, systemRole: 'agent', tier: null } };
      const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1', body: 'Your week: ...', sender_only: true }, { taskMetadata: DEMOTED });
      ctx.selfEmails = ['nathan@example.com'];
      (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue(forged);
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, messageId: 'reply-1' });

      expect((await handler.execute(ctx)).success).toBe(true);
      const [request, options] = (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mock.calls[0]! as [Record<string, unknown>, Record<string, unknown>];
      expect(request['cc']).toBeUndefined();
      expect(request['additionalTo']).toBeUndefined();
      expect(options['requesterUnverified']).toBe(true);
    });

    // An approval replays the stored payload under the approver's verified turn: the restriction
    // must travel with the hold, or the approved reply would go reply-all after all.
    it('pins sender-only into the hold, and an approved replay honours it', async () => {
      const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1', body: 'Your week: ...' }, { taskMetadata: UNVERIFIED });
      ctx.selfEmails = ['nathan@example.com'];
      (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue(forged);
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, messageId: 'reply-1' });
      await handler.execute(ctx);
      const options = (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { holdRecipe: { partialPayload: Record<string, unknown> } };
      expect(options.holdRecipe.partialPayload).toMatchObject({ sender_only: true });

      const VERIFIED = { originator: { ...UNVERIFIED.originator, authenticated: true } };
      const replay = makeCtx(options.holdRecipe.partialPayload, { taskMetadata: VERIFIED });
      replay.selfEmails = ['nathan@example.com'];
      (replay.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue(forged);
      (replay.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, messageId: 'reply-2' });
      await handler.execute(replay);
      const request = (replay.outboundGateway!.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      expect(request['additionalTo']).toBeUndefined();
      expect(request['cc']).toBeUndefined();
    });

    it('refuses an explicit cc', async () => {
      const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1', body: 'x', cc: 'attacker@example.com' }, { taskMetadata: UNVERIFIED });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      expect(ctx.outboundGateway!.send).not.toHaveBeenCalled();
    });

    it("refuses a reply to Curia's own message, whose To list could be anyone", async () => {
      const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1', body: 'x' }, { taskMetadata: UNVERIFIED });
      ctx.selfEmails = ['nathan@example.com'];
      (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...forged, from: [{ email: 'nathan@example.com' }], to: [{ email: 'attacker@example.com' }], cc: [],
      });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      expect(ctx.outboundGateway!.send).not.toHaveBeenCalled();
    });
  });

  describe('replying to a message Curia sent (#2273)', () => {
    it('addresses the original recipient, not Curia, and never CCs Curia', async () => {
      const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1', body: 'Update on the three.' });
      ctx.selfEmails = ['nathan@example.com'];
      (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        from: [{ email: 'nathan@example.com', name: 'Nathan' }],
        to: [{ email: 'boss@example.com' }, { email: 'partner@example.com' }],
        cc: [{ email: 'Nathan@example.com' }, { email: 'ea@example.com' }],
        subject: 'Re: Tutoring shortlist',
        body: '',
        date: 0,
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'reply-123',
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as Record<string, unknown>).to).toBe('boss@example.com, partner@example.com');
        expect((result.data as Record<string, unknown>).cc).toBe('ea@example.com');
      }
      expect(ctx.outboundGateway!.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'boss@example.com', additionalTo: ['partner@example.com'], cc: ['ea@example.com'] }),
        expect.objectContaining({
          holdRecipe: expect.objectContaining({
            description: 'Email reply to boss@example.com, partner@example.com — "Re: Tutoring shortlist"',
          }),
        }),
      );
      const [request, options] = (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mock.calls[0]! as [Record<string, unknown>, Record<string, unknown>];
      expect(options).not.toHaveProperty('recipientSource');
      // These people never wrote to us: the gateway must not create known-tier contacts for them.
      expect(request.toFromOwnMessage).toBe(true);
    });

    it('does not mark a reply to someone who wrote to us', async () => {
      const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1', body: 'Thanks!' });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, messageId: 'reply-1' });
      await handler.execute(ctx);
      const request = (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      expect(request).not.toHaveProperty('toFromOwnMessage');
    });

    it('refuses when Curia sent the original only to its own mailboxes', async () => {
      const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1', body: 'Note to self' });
      ctx.selfEmails = ['nathan@example.com', 'ops@example.com'];
      (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        from: [{ email: 'nathan@example.com' }],
        to: [{ email: 'ops@example.com' }, { email: 'nathan+x@example.com' }],
        cc: [],
        subject: 'Self',
        body: '',
        date: 0,
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/sent by Curia to no one else/);
      expect(ctx.outboundGateway!.send).not.toHaveBeenCalled();
    });
  });

  it('drops reply provenance when authentication did not pass (#2071)', async () => {
    const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1', body: 'Thanks!' });
    (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      from: [{ email: 'alice@example.com', name: 'Alice' }],
      to: [],
      cc: [],
      subject: 'Hi',
      body: '',
      date: 0,
      headers: [{ name: 'Authentication-Results', value: 'mx.google.com; spf=fail dkim=pass dmarc=pass' }],
    });
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, messageId: 'reply-123',
    });

    await handler.execute(ctx);
    const options = (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<string, unknown>;
    expect(options).not.toHaveProperty('recipientSource');
  });

  it('returns error when gateway blocks the reply', async () => {
    const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1', body: 'Thanks!' });
    (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      from: [{ email: 'alice@example.com' }],
      to: [],
      cc: [],
      subject: 'Hi',
      body: '',
      date: 0,
    });
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false, blockedReason: 'Recipient is blocked',
    });

    const result = await handler.execute(ctx);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/blocked/i);
  });

  describe('reply quote', () => {
    it('appends quoted original message below the reply body', async () => {
      const ctx = makeCtx(
        { reply_to_message_id: 'nylas-msg-1', body: 'Sounds good!' },
        { timezone: 'America/Toronto' },
      );
      (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        from: [{ name: 'Alice', email: 'alice@example.com' }],
        to: [{ email: 'curia@example.com' }],
        cc: [],
        subject: 'Q2 planning',
        body: '<p>Let me know your thoughts.</p>',
        date: 1700000000,
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'reply-99',
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      const sendArg = (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { body: string; htmlQuote?: string };
      // Reply body stays as markdown; gateway converts it to HTML
      expect(sendArg.body).toContain('Sounds good!');
      // HTML quote passed separately so markdownToHtml does not re-escape it
      expect(sendArg.htmlQuote).toContain('<blockquote');
      expect(sendArg.htmlQuote).toContain('alice@example.com');
      expect(sendArg.htmlQuote).toContain('Let me know your thoughts.');
      // Who was on the quoted message, for the send review (#2312).
      expect((sendArg as { quoteParticipants?: string[] }).quoteParticipants).toEqual(['alice@example.com', 'curia@example.com']);
    });

    it('proceeds without quote when buildReplyQuote throws', async () => {
      // Omitting body/date from the mock causes htmlToPlainText(undefined) to throw,
      // exercising the inner try/catch fallback path.
      const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1', body: 'Got it' });
      (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        from: [{ email: 'alice@example.com' }],
        to: [],
        cc: [],
        subject: 'Test',
        // intentionally omit body and date
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'reply-fallback',
      });
      const warnSpy = vi.fn();
      ctx.log = { ...ctx.log, warn: warnSpy, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      const sendArg = (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { body: string };
      // Body falls back to unquoted
      expect(sendArg.body).toBe('Got it');
      expect(sendArg.body).not.toContain('---------- Original Message ----------');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ replyToMessageId: 'nylas-msg-1' }),
        expect.stringContaining('buildReplyQuote failed'),
      );
    });

    it('registerOutboundContext receives original body, not quoted body', async () => {
      const ctx = makeCtx({
        reply_to_message_id: 'nylas-msg-1',
        body: 'My reply text',
        context_bridge: JSON.stringify({ agent_id: 'coordinator' }),
      });
      (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        from: [{ email: 'alice@example.com' }],
        to: [],
        cc: [],
        subject: 'Discussion',
        body: '<p>Original content here</p>',
        date: 1700000000,
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'reply-1',
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
      // The quote is presentation — registerOutboundContext must see the agent's own words only
      expect(mockRegister).toHaveBeenCalledWith(expect.objectContaining({
        content: 'My reply text',
      }));
    });
  });

  describe('context_bridge', () => {
    it('registers a context bridge entry after successful reply', async () => {
      const ctx = makeCtx({
        reply_to_message_id: 'nylas-msg-1',
        body: 'Thanks for the update — any next steps?',
        context_bridge: JSON.stringify({
          agent_id: 'coordinator',
          expected_reply: 'Next steps or action items',
          expires_in_hours: 24,
        }),
      });
      (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        from: [{ email: 'alice@example.com' }],
        to: [],
        cc: [],
        subject: 'Project update',
        body: '',
        date: 0,
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'reply-1',
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
        content: 'Thanks for the update — any next steps?',
        expectedReply: 'Next steps or action items',
        expiresInHours: 24,
        ttlSource: 'agent',
      });
    });

    it('registers a minimal entry when context_bridge is absent', async () => {
      const ctx = makeCtx({
        reply_to_message_id: 'nylas-msg-1',
        body: 'Got it, thanks',
      });
      (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        from: [{ email: 'alice@example.com' }],
        to: [],
        cc: [],
        subject: 'Quick note',
        body: '',
        date: 0,
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'reply-1',
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
        content: 'Got it, thanks',
        // Email's channel default, not the flat 6h that expired before
        // next-business-day replies could land (#1816).
        expiresInHours: 72,
        ttlSource: 'channel-default',
      });
    });

    it('registers the To and CC recipients that are verified contacts, so their reply sees the entry (#2261)', async () => {
      const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1', body: 'Got it, thanks' });
      (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        from: [{ email: 'alice@example.com' }],
        to: [],
        cc: [{ email: 'bob@example.com' }, { email: 'stranger@example.com' }, { email: 'shared@other.example' }],
        subject: 'Quick note',
        body: '',
        date: 0,
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, messageId: 'reply-1' });
      // shared@other.example matches only an unverified identity some other contact holds:
      // crediting it would show them an entry for mail sent to someone else.
      const contacts: Record<string, { contactId: string; verified: boolean }> = {
        'alice@example.com': { contactId: '11111111-1111-4111-8111-111111111111', verified: true },
        'bob@example.com': { contactId: '22222222-2222-4222-8222-222222222222', verified: true },
        'shared@other.example': { contactId: '33333333-3333-4333-8333-333333333333', verified: false },
      };
      const resolveByChannelIdentity = vi.fn(async (_channel: string, address: string) => contacts[address] ?? null);
      const mockRegister = vi.fn().mockResolvedValue('entry-1');
      Object.assign(ctx as unknown as Record<string, unknown>, {
        agentId: 'coordinator',
        contactService: { resolveByChannelIdentity },
        outboundContext: {
          register: mockRegister,
          release: vi.fn(),
          defaultExpiryHours: 6,
          explicitExpiryHours: 24,
          defaultExpiryHoursFor: () => 72,
        },
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      expect(resolveByChannelIdentity).toHaveBeenCalledWith('email', 'alice@example.com');
      expect(mockRegister).toHaveBeenCalledWith(expect.objectContaining({
        recipientContactIds: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
      }));
    });

    it('still registers the entry when a recipient lookup throws', async () => {
      const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1', body: 'Got it, thanks' });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, messageId: 'reply-1' });
      const mockRegister = vi.fn().mockResolvedValue('entry-1');
      Object.assign(ctx as unknown as Record<string, unknown>, {
        agentId: 'coordinator',
        contactService: { resolveByChannelIdentity: vi.fn().mockRejectedValue(new Error('db down')) },
        outboundContext: {
          register: mockRegister,
          release: vi.fn(),
          defaultExpiryHours: 6,
          explicitExpiryHours: 24,
          defaultExpiryHoursFor: () => 72,
        },
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      expect(mockRegister).toHaveBeenCalledOnce();
      expect(mockRegister.mock.calls[0]![0]).not.toHaveProperty('recipientContactIds');
    });

    it('logs warning but succeeds when bridge registration fails', async () => {
      const ctx = makeCtx({
        reply_to_message_id: 'nylas-msg-1',
        body: 'Sounds good',
        context_bridge: JSON.stringify({ agent_id: 'coordinator' }),
      });
      (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        from: [{ email: 'alice@example.com' }],
        to: [],
        cc: [],
        subject: 'Plan',
        body: '',
        date: 0,
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'reply-1',
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

  describe('attachments', () => {
    it('passes attachments to the gateway when provided', async () => {
      const ctx = makeCtx({
        reply_to_message_id: 'nylas-msg-1',
        body: 'See attached.',
        attachments: [
          { file_url: 'file:///tmp/report.pdf', filename: 'report.pdf', content_type: 'application/pdf' },
        ],
      });
      (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        from: [{ email: 'alice@example.com' }],
        to: [],
        cc: [],
        subject: 'Project',
        body: '',
        date: 0,
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'reply-attach-1',
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      const callArg = (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      expect(callArg.attachments).toEqual([
        { fileUrl: 'file:///tmp/report.pdf', filename: 'report.pdf', contentType: 'application/pdf' },
      ]);
    });

    it('does not include attachments key when attachments is undefined', async () => {
      const ctx = makeCtx({
        reply_to_message_id: 'nylas-msg-1',
        body: 'Thanks.',
      });
      (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        from: [{ email: 'alice@example.com' }],
        to: [],
        cc: [],
        subject: 'Hi',
        body: '',
        date: 0,
      });
      (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true, messageId: 'reply-1',
      });

      await handler.execute(ctx);

      const callArg = (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      expect(callArg.attachments).toBeUndefined();
    });

    it('returns error when attachments is not an array', async () => {
      const ctx = makeCtx({
        reply_to_message_id: 'nylas-msg-1',
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
        reply_to_message_id: 'nylas-msg-1',
        body: 'Hi',
        attachments: [{ filename: 'a.pdf', content_type: 'application/pdf' }],
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('file_url');
      expect(ctx.outboundGateway!.send).not.toHaveBeenCalled();
    });
  });

  describe('auto-generated sender suppress (#1734)', () => {
    it('blocks email-reply to the machine sender when autoGeneratedSuppress is stamped', async () => {
      const ctx = makeCtx(
        { reply_to_message_id: 'nylas-msg-1', body: 'Thanks for declining' },
        {
          taskMetadata: {
            autoGeneratedSuppress: true,
            autoGeneratedSenderId: 'alice@example.com',
          },
        },
      );

      const result = await handler.execute(ctx);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/auto-generated/i);
      expect(ctx.outboundGateway!.send).not.toHaveBeenCalled();
    });

    it('allows email-reply when the original sender is not the suppressed address', async () => {
      const ctx = makeCtx(
        { reply_to_message_id: 'nylas-msg-1', body: 'Looping you in' },
        {
          taskMetadata: {
            autoGeneratedSuppress: true,
            autoGeneratedSenderId: 'machine@exchange.example',
          },
        },
      );
      (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        from: [{ email: 'colleague@example.com' }],
        to: [],
        cc: [],
        subject: 'Different thread',
        body: '',
        date: 0,
      });

      const result = await handler.execute(ctx);

      expect(result.success).toBe(true);
      expect(ctx.outboundGateway!.send).toHaveBeenCalled();
    });
  });

  // #2131: cc takes addresses and contact references mixed, resolved as email-send does.
  describe('cc references (#2131)', () => {
    let contacts: ContactService;
    let principalId: string;
    let danaId: string;

    beforeEach(async () => {
      contacts = ContactService.createInMemory();
      const principal = await contacts.createContact({ displayName: 'Pat Principal', source: 'ceo_stated', tier: 'known' });
      principalId = principal.id;
      await contacts.linkIdentity({ contactId: principalId, channel: 'email', channelIdentifier: 'pat@work.example', source: 'ceo_stated', label: 'work' });
      await contacts.linkIdentity({ contactId: principalId, channel: 'email', channelIdentifier: 'pat@home.example', source: 'ceo_stated', label: 'personal' });
      await contacts.updateContactFields(principalId, { primaryEmail: 'pat@work.example' });
      const dana = await contacts.createContact({ displayName: 'Dana Lee', source: 'ceo_stated', tier: 'known' });
      danaId = dana.id;
      await contacts.linkIdentity({ contactId: danaId, channel: 'email', channelIdentifier: 'dana@example.com', source: 'ceo_stated' });
    });

    /** A ctx whose gateway resolves references with the real resolver. */
    function ctxWithResolver(input: Record<string, unknown>): ToolContext {
      const ctx = makeCtx(input);
      (ctx.outboundGateway as unknown as Record<string, unknown>).resolveRecipientReference = vi.fn(
        (channel: string, value: string, fields: { field: string }) =>
          resolveRecipientReference(value, channel, fields, { contactService: contacts, principalContactId: principalId }),
      );
      return ctx;
    }

    function sentCc(ctx: ToolContext): unknown {
      const send = ctx.outboundGateway!.send as unknown as ReturnType<typeof vi.fn>;
      return (send.mock.calls[0]![0] as { cc?: string[] }).cc;
    }

    it('copies the principal\'s primary address for cc: "principal"', async () => {
      const ctx = ctxWithResolver({ reply_to_message_id: 'nylas-msg-1', body: 'Thanks!', cc: 'principal' });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      expect(sentCc(ctx)).toEqual(['pat@work.example']);
      if (result.success) expect((result.data as { cc: string }).cc).toBe('pat@work.example');
    });

    it('picks the labelled address for principal#<label>', async () => {
      const ctx = ctxWithResolver({ reply_to_message_id: 'nylas-msg-1', body: 'Thanks!', cc: 'principal#personal' });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      expect(sentCc(ctx)).toEqual(['pat@home.example']);
    });

    it('resolves a contact UUID to its verified address, mixed with literal addresses', async () => {
      const ctx = ctxWithResolver({
        reply_to_message_id: 'nylas-msg-1',
        body: 'Thanks!',
        cc: `bob@vendor.example, ${danaId}, principal`,
      });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      expect(sentCc(ctx)).toEqual(['bob@vendor.example', 'dana@example.com', 'pat@work.example']);
    });

    it('does not add a resolved address that is already listed', async () => {
      const ctx = ctxWithResolver({ reply_to_message_id: 'nylas-msg-1', body: 'Thanks!', cc: 'PAT@work.example, principal' });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      expect(sentCc(ctx)).toEqual(['PAT@work.example']);
    });

    it('dedupes a literal address that a reference already resolved to, in either order', async () => {
      const ctx = ctxWithResolver({ reply_to_message_id: 'nylas-msg-1', body: 'Thanks!', cc: 'principal, PAT@work.example' });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      expect(sentCc(ctx)).toEqual(['pat@work.example']);
    });

    it('refuses an explicit cc with no entries, rather than replying sender-only', async () => {
      const ctx = ctxWithResolver({ reply_to_message_id: 'nylas-msg-1', body: 'Thanks!', cc: ' , ,' });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/cc has no entries/);
        expect(result.error).toContain('"principal"');
      }
      expect(ctx.outboundGateway!.getEmailMessage).not.toHaveBeenCalled();
      expect(ctx.outboundGateway!.send).not.toHaveBeenCalled();
    });

    it('tolerates a stray empty segment beside real entries', async () => {
      const ctx = ctxWithResolver({ reply_to_message_id: 'nylas-msg-1', body: 'Thanks!', cc: 'bob@vendor.example,, principal,' });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(true);
      expect(sentCc(ctx)).toEqual(['bob@vendor.example', 'pat@work.example']);
    });

    it.each([
      ['a name', 'Pat Principal'],
      ['a role', 'the principal'],
      ['a template token', '${principal_email}'],
      ['a half address', 'pat@'],
    ])('refuses %s before any fetch or send, naming "principal"', async (_label, entry) => {
      const ctx = ctxWithResolver({ reply_to_message_id: 'nylas-msg-1', body: 'Thanks!', cc: `bob@vendor.example, ${entry}` });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('"principal"');
        expect(result.error).toMatch(/Nothing was sent/);
      }
      expect(ctx.outboundGateway!.getEmailMessage).not.toHaveBeenCalled();
      expect(ctx.outboundGateway!.send).not.toHaveBeenCalled();
    });

    it('refuses a reference that does not resolve, and sends nothing', async () => {
      const ctx = ctxWithResolver({
        reply_to_message_id: 'nylas-msg-1',
        body: 'Thanks!',
        cc: '00000000-0000-4000-8000-000000000000',
      });
      const result = await handler.execute(ctx);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/No contact has ID/);
      expect(ctx.outboundGateway!.send).not.toHaveBeenCalled();
    });

    it('keeps literal addresses, reply-all and sender-only as before, without resolving', async () => {
      const literal = ctxWithResolver({ reply_to_message_id: 'nylas-msg-1', body: 'Thanks!', cc: 'bob@vendor.example, carol@vendor.example' });
      expect((await handler.execute(literal)).success).toBe(true);
      expect(sentCc(literal)).toEqual(['bob@vendor.example', 'carol@vendor.example']);

      const senderOnly = ctxWithResolver({ reply_to_message_id: 'nylas-msg-1', body: 'Thanks!', cc: '' });
      expect((await handler.execute(senderOnly)).success).toBe(true);
      expect(sentCc(senderOnly)).toBeUndefined();

      const replyAll = ctxWithResolver({ reply_to_message_id: 'nylas-msg-1', body: 'Thanks!' });
      (replyAll.outboundGateway!.getEmailMessage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        from: [{ email: 'alice@example.com' }],
        to: [{ email: 'principal@ignored.example' }],
        cc: [{ email: 'dave@example.com' }],
        subject: 'Test subject',
        body: '',
        date: 0,
      });
      expect((await handler.execute(replyAll)).success).toBe(true);
      // Reply-all keeps the original To on To (#2273); CC is the original CC.
      expect(sentCc(replyAll)).toEqual(['dave@example.com']);
      expect((replyAll.outboundGateway!.send as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
        to: 'alice@example.com',
        additionalTo: ['principal@ignored.example'],
      });

      for (const ctx of [literal, senderOnly, replyAll]) {
        expect(ctx.outboundGateway!.resolveRecipientReference).not.toHaveBeenCalled();
      }
    });
  });
});

describe('email-reply relay budget (#1320)', () => {
  const OUTSIDER = { originator: { contactId: 'dana-contact', systemRole: null, channel: 'email', initiatedAt: '2026-10-19T12:00:00Z', tier: 'known' } };

  it('passes the task originator to the gateway and surfaces a relay-budget deferral', async () => {
    const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1', body: 'Dana confirmed.' }, { taskMetadata: OUTSIDER });
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, deferredToDigest: true });
    const outboundContext = { register: vi.fn().mockResolvedValue('entry-1'), release: vi.fn(), defaultExpiryHours: 6, explicitExpiryHours: 24, defaultExpiryHoursFor: () => 6 };
    (ctx as unknown as Record<string, unknown>).outboundContext = outboundContext;

    const result = await new EmailReplyHandler().execute(ctx);

    expect(ctx.outboundGateway!.send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ originator: OUTSIDER.originator }));
    expect(result.success).toBe(true);
    // Nothing reached the principal, so no reply should bind to it.
    expect(outboundContext.register).not.toHaveBeenCalled();
    if (result.success) expect(result.data).toMatchObject({ deferred_to_digest: true, note: expect.stringMatching(/digest/) });
  });
});

// #2312: the agent is told what was removed, and the entry records what was delivered.
describe('EmailReplyHandler redactions (#2312)', () => {
  const RED = [{ label: 'phone_us', field: 'body' as const }];
  const SENT = 'x [REDACTED: PHONE_US]';

  function withContext(ctx: ToolContext) {
    const register = vi.fn().mockResolvedValue('entry-1');
    (ctx as unknown as Record<string, unknown>).outboundContext = {
      register, release: vi.fn(), defaultExpiryHours: 6, explicitExpiryHours: 24, defaultExpiryHoursFor: () => 6,
    };
    return register;
  }

  it('reports the redactions and records the delivered content', async () => {
    const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1', body: 'x 519-555-0100' });
    const register = withContext(ctx);
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, messageId: 'm', redactions: RED, sentContent: SENT });
    const result = await new EmailReplyHandler().execute(ctx);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject({ redactions: RED, redaction_note: REDACTION_NOTE });
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ content: SENT }));
  });

  it('returns the subject as delivered when redaction changed it', async () => {
    const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1', body: 'x' });
    withContext(ctx);
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true, messageId: 'm', redactions: [{ label: 'phone_us', field: 'subject' }], sentContent: 'x', sentSubject: 'Re: [REDACTED: PHONE_US]',
    });
    const result = await new EmailReplyHandler().execute(ctx);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject({ subject: 'Re: [REDACTED: PHONE_US]' });
  });

  it('adds no redactions key when nothing was removed', async () => {
    const ctx = makeCtx({ reply_to_message_id: 'nylas-msg-1', body: 'hello' });
    const register = withContext(ctx);
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, messageId: 'm' });
    const result = await new EmailReplyHandler().execute(ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('redactions');
      expect(result.data).not.toHaveProperty('redaction_note');
    }
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ content: 'hello' }));
  });
});

describe('EmailReplyHandler task outreach (#2312)', () => {
  it('with no task title, summarises the outreach row by the reply subject, never the body', async () => {
    const ctx = makeCtx(
      { reply_to_message_id: 'nylas-msg-1', body: 'My card ends 4242, call me on 416-555-0100.' },
      { taskMetadata: { originator: { contactId: 'principal-id', systemRole: 'principal', authenticated: true, channel: 'email', initiatedAt: '2026-10-26T00:00:00Z' } } },
    );
    (ctx.outboundGateway!.getEmailMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      from: [{ email: 'bookings@acme.example' }], to: [], cc: [], subject: 'Appointment', body: '', date: 0,
    });
    (ctx.outboundGateway!.send as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, messageId: 'reply-1' });
    const record = vi.fn(async (input: TaskOutreachInput) => ({ id: 'outreach-1', ...input } as unknown as TaskOutreachRow));
    Object.assign(ctx as unknown as Record<string, unknown>, {
      liveTurn: true,
      conversationId: 'conv-1',
      taskEventId: 'evt-1',
      taskOutreach: new TaskOutreachService({ record } as unknown as TaskOutreachRepo, {
        principalIdentities: [], selfEmails: ['curia@office.example'], log: makeLogger(),
      }),
    });

    expect((await new EmailReplyHandler().execute(ctx)).success).toBe(true);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ taskId: null, summary: 'Re: Appointment' }));
    expect(JSON.stringify(record.mock.calls)).not.toContain('4242');
  });
});
