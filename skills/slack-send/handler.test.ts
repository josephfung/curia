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

// Stored identities the handler must refuse, each reachable through its own reference.
// Enterprise Grid W… ids, channel ids and lowercase u… ids are not Slack user ids it can DM.
const UNSUPPORTED_IDENTITIES: Record<string, string> = {
  'grid-user': 'W012ABCDEF',
  'channel-user': 'C012CHANNEL',
  'lowercase-user': 'u012abcdef',
};

/** Stands in for the gateway's reference resolver (#2033); its rules are tested elsewhere. */
const resolveRecipientReference = vi.fn(async (_channel: string, value: string) => {
  if (value === 'principal') return { ok: true, kind: 'principal', contactId: 'principal-id', identifier: 'U0PRINCIPAL', displayName: 'Principal' };
  const unsupported = UNSUPPORTED_IDENTITIES[value];
  if (unsupported) return { ok: true, kind: 'contact', contactId: 'other-id', identifier: unsupported, displayName: 'Other' };
  return { ok: false, error: `No contact for "${value}". Nothing was sent.` };
});

describe('slack-send handler', () => {
  it('requires a recipient and message', async () => {
    const handler = new SlackSendHandler();
    expect((await handler.execute(makeCtx({ input: { message: 'hi' } }))).success).toBe(false);
  });

  it('rejects missing gateway', async () => {
    const handler = new SlackSendHandler();
    const result = await handler.execute(makeCtx({
      input: { recipient: 'principal', message: 'hi' },
    }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/outboundGateway/);
  });

  it('surfaces blockedReason when gateway refuses', async () => {
    const send = vi.fn().mockResolvedValue({ success: false, blockedReason: 'contact blocked' });
    const handler = new SlackSendHandler();
    const result = await handler.execute(makeCtx({
      input: { recipient: 'principal', message: 'Hello' },
      outboundGateway: { send, resolveRecipientReference } as never,
    }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe('contact blocked');
  });

  describe('send by reference (#2033)', () => {
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

    it.each(Object.entries(UNSUPPORTED_IDENTITIES))(
      'refuses a stored identity that is not a U… user id (%s)',
      async (reference, identifier) => {
        const send = vi.fn();
        const result = await new SlackSendHandler().execute(makeCtx({
          input: { recipient: reference, message: 'Hello' },
          outboundGateway: { send, resolveRecipientReference } as never,
        }));
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toMatch(/not a U… user id/);
          // The stored id stays out of the agent-facing error.
          expect(result.error).not.toContain(identifier);
        }
        expect(send).not.toHaveBeenCalled();
      },
    );

    it('sends nothing when the reference does not resolve', async () => {
      const send = vi.fn();
      const result = await new SlackSendHandler().execute(makeCtx({
        input: { recipient: 'U012ABCDEF', message: 'Hello' },
        outboundGateway: { send, resolveRecipientReference } as never,
      }));
      expect(result.success).toBe(false);
      expect(send).not.toHaveBeenCalled();
    });

    it('refuses the retired recipient_user_id (#2041)', async () => {
      const send = vi.fn();
      const result = await new SlackSendHandler().execute(makeCtx({
        input: { recipient: 'principal', recipient_user_id: 'U012ABCDEF', message: 'Hello' },
        outboundGateway: { send, resolveRecipientReference } as never,
      }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/no longer accepted/);
        expect(result.error).toMatch(/contact-create/);
      }
      expect(send).not.toHaveBeenCalled();
    });

    it('refuses the retired recipient_user_id on its own (#2041)', async () => {
      const send = vi.fn();
      const result = await new SlackSendHandler().execute(makeCtx({
        input: { recipient_user_id: 'U012ABCDEF', message: 'Hello' },
        outboundGateway: { send, resolveRecipientReference } as never,
      }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/no longer accepted/);
      expect(send).not.toHaveBeenCalled();
    });

    // Review Focus 1: models fill unused optional inputs with "" or whitespace.
    it.each([[''], ['  '], [null], [[]]])(
      'ignores a blank retired recipient_user_id %o beside a reference (Review Focus 1)',
      async (blank) => {
        const send = vi.fn().mockResolvedValue({ success: true, messageId: '1.2' });
        const result = await new SlackSendHandler().execute(makeCtx({
          input: { recipient: 'principal', recipient_user_id: blank, message: 'Hello' },
          outboundGateway: { send, resolveRecipientReference } as never,
        }));
        expect(result.success).toBe(true);
        expect(send).toHaveBeenCalledWith(
          { channel: 'slack', slackChannelId: 'U0PRINCIPAL', slackUserId: 'U0PRINCIPAL', message: 'Hello' },
          expect.any(Object),
        );
      },
    );
  });
});
