import { describe, it, expect, vi } from 'vitest';
import { SmsSendHandler } from './handler.js';
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

// Resolves to a number that is not E.164, so the handler's own check is exercised.
const BOB_ID = '22222222-2222-4222-8222-222222222222';

/** Stands in for the gateway's reference resolver (#2033); its rules are tested elsewhere. */
const resolveRecipientReference = vi.fn(async (_channel: string, value: string) => {
  if (value === 'principal') return { ok: true, kind: 'principal', contactId: 'principal-id', identifier: '+15195550100', displayName: 'Principal' };
  if (value === BOB_ID) return { ok: true, kind: 'contact', contactId: BOB_ID, identifier: '4155552671', displayName: 'Bob' };
  return { ok: false, error: `No contact for "${value}". Nothing was sent.` };
});

describe('sms-send handler', () => {
  it('validates E.164 recipient and message', async () => {
    const handler = new SmsSendHandler();
    expect((await handler.execute(makeCtx({ input: { message: 'hi' } }))).success).toBe(false);
    const send = vi.fn();
    const bad = await handler.execute(makeCtx({
      input: { recipient: BOB_ID, message: 'hi' },
      outboundGateway: { send, resolveRecipientReference } as never,
    }));
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error).toMatch(/E\.164/);
    expect(send).not.toHaveBeenCalled();
  });

  describe('send by reference (#2033)', () => {
    it('resolves recipient through the gateway and sends to the looked-up number', async () => {
      const send = vi.fn().mockResolvedValue({ success: true, messageId: 'm2' });
      const result = await new SmsSendHandler().execute(makeCtx({
        input: { recipient: 'principal', message: 'Hello' },
        outboundGateway: { send, resolveRecipientReference } as never,
      }));
      expect(result.success).toBe(true);
      expect(resolveRecipientReference).toHaveBeenCalledWith('sms', 'principal', { field: 'recipient' });
      expect(send).toHaveBeenCalledWith({ channel: 'sms', recipient: '+15195550100', message: 'Hello' }, expect.any(Object));
      if (result.success) {
        expect(result.data).toMatchObject({ delivered_to: '+15195550100' });
        expect(result.data).not.toHaveProperty('contact_id');
      }
    });

    it('sends nothing when the reference does not resolve', async () => {
      const send = vi.fn();
      const result = await new SmsSendHandler().execute(makeCtx({
        input: { recipient: '+14155552671', message: 'Hello' },
        outboundGateway: { send, resolveRecipientReference } as never,
      }));
      expect(result.success).toBe(false);
      expect(send).not.toHaveBeenCalled();
    });

    it('refuses the retired recipient_number (#2041)', async () => {
      const send = vi.fn();
      const result = await new SmsSendHandler().execute(makeCtx({
        input: { recipient: 'principal', recipient_number: '+14155552671', message: 'Hello' },
        outboundGateway: { send, resolveRecipientReference } as never,
      }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toMatch(/no longer accepted/);
        expect(result.error).toMatch(/contact-create/);
      }
      expect(send).not.toHaveBeenCalled();
    });

    it('refuses the retired recipient_number on its own (#2041)', async () => {
      const send = vi.fn();
      const result = await new SmsSendHandler().execute(makeCtx({
        input: { recipient_number: '+14155552671', message: 'Hello' },
        outboundGateway: { send, resolveRecipientReference } as never,
      }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/no longer accepted/);
      expect(send).not.toHaveBeenCalled();
    });

    // Review Focus 1: models fill unused optional inputs with "" or whitespace.
    it.each([[''], ['  '], [null], [[]]])(
      'ignores a blank retired recipient_number %o beside a reference (Review Focus 1)',
      async (blank) => {
        const send = vi.fn().mockResolvedValue({ success: true, messageId: 'm3' });
        const result = await new SmsSendHandler().execute(makeCtx({
          input: { recipient: 'principal', recipient_number: blank, message: 'Hello' },
          outboundGateway: { send, resolveRecipientReference } as never,
        }));
        expect(result.success).toBe(true);
        expect(send).toHaveBeenCalledWith({ channel: 'sms', recipient: '+15195550100', message: 'Hello' }, expect.any(Object));
      },
    );
  });
});
