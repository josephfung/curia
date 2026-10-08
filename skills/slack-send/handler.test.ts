import { describe, it, expect, vi } from 'vitest';
import { SlackSendHandler } from './handler.js';
import type { ToolContext } from '../../src/skills/types.js';
import pino from 'pino';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    input: {},
    log: pino({ level: 'silent' }),
    agentId: 'coordinator',
    ...overrides,
  } as ToolContext;
}

describe('slack-send handler', () => {
  it('validates Slack user id recipient and message', async () => {
    const handler = new SlackSendHandler();
    expect((await handler.execute(makeCtx({ input: { message: 'hi' } }))).success).toBe(false);
    const bad = await handler.execute(makeCtx({
      input: { recipient_user_id: 'C012CHANNEL', message: 'hi' },
    }));
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error).toMatch(/Slack user id/);

    // Lowercase U… and Enterprise Grid W… ids are rejected (exact-match principal compare).
    for (const recipient of ['u012abcdef', 'W012ABCDEF']) {
      const rejected = await handler.execute(makeCtx({
        input: { recipient_user_id: recipient, message: 'hi' },
      }));
      expect(rejected.success).toBe(false);
      if (!rejected.success) expect(rejected.error).toMatch(/Slack user id/);
    }
  });

  it('rejects missing gateway', async () => {
    const handler = new SlackSendHandler();
    const result = await handler.execute(makeCtx({
      input: { recipient_user_id: 'U012ABCDEF', message: 'hi' },
    }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/outboundGateway/);
  });

  it('dispatches via outboundGateway with U… as channel and user id', async () => {
    const send = vi.fn().mockResolvedValue({ success: true, messageId: '1234.5678' });
    const handler = new SlackSendHandler();
    const result = await handler.execute(makeCtx({
      input: { recipient_user_id: 'U012ABCDEF', message: 'Hello' },
      outboundGateway: { send } as never,
      outboundContext: undefined,
    }));
    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledWith(
      {
        channel: 'slack',
        slackChannelId: 'U012ABCDEF',
        slackUserId: 'U012ABCDEF',
        message: 'Hello',
      },
      expect.any(Object),
    );
  });

  it('surfaces blockedReason when gateway refuses', async () => {
    const send = vi.fn().mockResolvedValue({ success: false, blockedReason: 'contact blocked' });
    const handler = new SlackSendHandler();
    const result = await handler.execute(makeCtx({
      input: { recipient_user_id: 'U012ABCDEF', message: 'Hello' },
      outboundGateway: { send } as never,
    }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe('contact blocked');
  });

  describe('send by reference (#2033)', () => {
    const resolveRecipientReference = vi.fn(async (_channel: string, value: string) => {
      if (value === 'principal') return { ok: true, kind: 'principal', contactId: 'principal-id', identifier: 'U0PRINCIPAL', displayName: 'Principal' };
      if (value === 'grid-user') return { ok: true, kind: 'contact', contactId: 'grid-id', identifier: 'W012ABCDEF', displayName: 'Grid' };
      return { ok: false, error: `No contact for "${value}". Nothing was sent.` };
    });

    it('resolves recipient through the gateway and DMs the looked-up user id', async () => {
      const send = vi.fn().mockResolvedValue({ success: true, messageId: '1.1' });
      const result = await new SlackSendHandler().execute(makeCtx({
        input: { recipient: 'principal', message: 'Hello' },
        outboundGateway: { send, resolveRecipientReference } as never,
      }));
      expect(result.success).toBe(true);
      expect(resolveRecipientReference).toHaveBeenCalledWith('slack', 'principal', { field: 'recipient' });
      expect(send).toHaveBeenCalledWith(
        { channel: 'slack', slackChannelId: 'U0PRINCIPAL', slackUserId: 'U0PRINCIPAL', message: 'Hello' },
        expect.any(Object),
      );
      if (result.success) {
        expect(result.data).toMatchObject({ delivered_to: 'U0PRINCIPAL' });
        expect(result.data).not.toHaveProperty('contact_id');
      }
    });

    it('keeps Enterprise Grid ids out of scope on the reference path', async () => {
      const send = vi.fn();
      const result = await new SlackSendHandler().execute(makeCtx({
        input: { recipient: 'grid-user', message: 'Hello' },
        outboundGateway: { send, resolveRecipientReference } as never,
      }));
      expect(result.success).toBe(false);
      expect(send).not.toHaveBeenCalled();
    });

    it('sends nothing when the reference does not resolve', async () => {
      const send = vi.fn();
      const result = await new SlackSendHandler().execute(makeCtx({
        input: { recipient: 'U012ABCDEF', message: 'Hello' },
        outboundGateway: { send, resolveRecipientReference } as never,
      }));
      expect(result.success).toBe(false);
      expect(send).not.toHaveBeenCalled();
    });
  });
});
