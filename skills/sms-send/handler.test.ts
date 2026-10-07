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

describe('sms-send handler', () => {
  it('validates E.164 recipient and message', async () => {
    const handler = new SmsSendHandler();
    expect((await handler.execute(makeCtx({ input: { message: 'hi' } }))).success).toBe(false);
    const bad = await handler.execute(makeCtx({
      input: { recipient_number: '4155552671', message: 'hi' },
    }));
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error).toMatch(/E\.164/);
  });

  it('dispatches via outboundGateway', async () => {
    const send = vi.fn().mockResolvedValue({ success: true, messageId: 'm1' });
    const handler = new SmsSendHandler();
    const result = await handler.execute(makeCtx({
      input: { recipient_number: '+14155552671', message: 'Hello' },
      outboundGateway: { send } as never,
      outboundContext: undefined,
    }));
    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledWith(
      { channel: 'sms', recipient: '+14155552671', message: 'Hello' },
      expect.any(Object),
    );
  });

  describe('send by reference (#2033)', () => {
    const resolveRecipientReference = vi.fn(async (_channel: string, value: string) =>
      value === 'principal'
        ? { ok: true, kind: 'principal', contactId: 'principal-id', identifier: '+15195550100', displayName: 'Principal' }
        : { ok: false, error: `No contact for "${value}". Nothing was sent.` });

    it('resolves recipient through the gateway and sends to the looked-up number', async () => {
      const send = vi.fn().mockResolvedValue({ success: true, messageId: 'm2' });
      const result = await new SmsSendHandler().execute(makeCtx({
        input: { recipient: 'principal', message: 'Hello' },
        outboundGateway: { send, resolveRecipientReference } as never,
      }));
      expect(result.success).toBe(true);
      expect(resolveRecipientReference).toHaveBeenCalledWith('sms', 'principal', { field: 'recipient', rawField: 'recipient_number' });
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

    it('rejects recipient and recipient_number together', async () => {
      const result = await new SmsSendHandler().execute(makeCtx({
        input: { recipient: 'principal', recipient_number: '+14155552671', message: 'Hello' },
      }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/either recipient or recipient_number/);
    });
  });
});
