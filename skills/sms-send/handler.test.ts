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
      input: { recipient: '4155552671', message: 'hi' },
    }));
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error).toMatch(/E\.164/);
  });

  it('dispatches via outboundGateway', async () => {
    const send = vi.fn().mockResolvedValue({ success: true, messageId: 'm1' });
    const handler = new SmsSendHandler();
    const result = await handler.execute(makeCtx({
      input: { recipient: '+14155552671', message: 'Hello' },
      outboundGateway: { send } as never,
      outboundContext: undefined,
    }));
    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledWith(
      { channel: 'sms', recipient: '+14155552671', message: 'Hello' },
      expect.any(Object),
    );
  });
});
