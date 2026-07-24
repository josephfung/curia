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
      input: { recipient: 'C012CHANNEL', message: 'hi' },
    }));
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error).toMatch(/Slack user id/);

    // Lowercase U… and Enterprise Grid W… ids are rejected (exact-match principal compare).
    for (const recipient of ['u012abcdef', 'W012ABCDEF']) {
      const rejected = await handler.execute(makeCtx({
        input: { recipient, message: 'hi' },
      }));
      expect(rejected.success).toBe(false);
      if (!rejected.success) expect(rejected.error).toMatch(/Slack user id/);
    }
  });

  it('rejects missing gateway', async () => {
    const handler = new SlackSendHandler();
    const result = await handler.execute(makeCtx({
      input: { recipient: 'U012ABCDEF', message: 'hi' },
    }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/outboundGateway/);
  });

  it('dispatches via outboundGateway with U… as channel and user id', async () => {
    const send = vi.fn().mockResolvedValue({ success: true, messageId: '1234.5678' });
    const handler = new SlackSendHandler();
    const result = await handler.execute(makeCtx({
      input: { recipient: 'U012ABCDEF', message: 'Hello' },
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
      input: { recipient: 'U012ABCDEF', message: 'Hello' },
      outboundGateway: { send } as never,
    }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe('contact blocked');
  });
});
