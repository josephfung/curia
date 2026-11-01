import { describe, expect, it, vi } from 'vitest';
import { WebSendHandler } from './handler.js';
import type { ToolContext } from '../../src/skills/types.js';
import type { OutboundSendResult } from '../../src/skills/outbound-gateway.js';
import { RELAY_DEFERRED_NOTE } from '../../src/skills/_shared/principal-directed.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'tool.json'), 'utf-8')) as {
  inputs: Record<string, string>;
};

function ctx(send: (request: { channel: string }) => Promise<OutboundSendResult>, resolveOk = true): ToolContext {
  return {
    input: { recipient: 'principal', message: 'The board moved to Thursday.' },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    outboundGateway: {
      send,
      resolveRecipientReference: vi.fn(async (channel: string) => (
        resolveOk && channel === 'signal'
          ? { ok: true, identifier: '+15555550123', kind: 'alias', contactId: 'c1' }
          : { ok: false, error: 'no identity' }
      )),
    },
  } as unknown as ToolContext;
}

describe('web-send', () => {
  const handler = new WebSendHandler();

  it('refuses anyone but the principal', async () => {
    const result = await handler.execute({
      input: { recipient: 'someone-else', message: 'hi' },
      log: { error: vi.fn() },
    } as unknown as ToolContext);
    expect(result.success).toBe(false);
  });

  it('reports a busy push service without trying another channel', async () => {
    const send = vi.fn(async () => ({
      success: false,
      webDelivery: 'unavailable' as const,
      blockedReason: 'The push service is busy.',
    }));
    const result = await handler.execute(ctx(send));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/busy/);
    expect(send).toHaveBeenCalledOnce();
  });

  it('sends the next channel when the phone subscription is dead', async () => {
    const send = vi.fn(async (request: { channel: string }) => {
      if (request.channel === 'web') {
        return {
          success: false,
          webDelivery: 'fallback' as const,
          webDeliveryDetail: 'The phone stopped receiving notifications.',
          blockedReason: 'The phone stopped receiving notifications.',
        };
      }
      return { success: true };
    });
    const result = await handler.execute(ctx(send));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        channel: 'signal',
        app_notice: 'The phone stopped receiving notifications.',
      });
    }
    expect(send).toHaveBeenCalledTimes(2);
    const fallbackCall = send.mock.calls[1] as unknown as [unknown, { principalDirected?: boolean; holdRecipe?: { toolName?: string } }];
    expect(fallbackCall[1]?.principalDirected).toBe(false);
    expect(fallbackCall[1]?.holdRecipe?.toolName).toBe('web-send');
  });

  it('does not try another channel when no phone is subscribed', async () => {
    const send = vi.fn(async () => ({
      success: false,
      webDelivery: 'unavailable' as const,
      blockedReason: 'No phone is subscribed to notifications.',
    }));
    const result = await handler.execute(ctx(send));
    expect(result.success).toBe(false);
    expect(send).toHaveBeenCalledOnce();
  });

  it('skips a channel that is not configured', async () => {
    const send = vi.fn(async (request: { channel: string }) => {
      if (request.channel === 'web') {
        return { success: false, webDelivery: 'fallback' as const, blockedReason: 'dead' };
      }
      return { success: true };
    });
    const base = ctx(send);
    const gateway = base.outboundGateway as NonNullable<typeof base.outboundGateway> & {
      configuredFallbackChannels: () => string[];
    };
    gateway.configuredFallbackChannels = () => ['email'];
    (gateway.resolveRecipientReference as ReturnType<typeof vi.fn>).mockImplementation(async (channel: string) => (
      channel === 'email'
        ? { ok: true, identifier: 'a@example.com', kind: 'alias', contactId: 'c1' }
        : { ok: false, error: 'no' }
    ));
    const result = await handler.execute(base);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject({ channel: 'email' });
    expect(send.mock.calls.map((call) => (call[0] as { channel: string }).channel)).toEqual(['web', 'email']);
    if (result.success) {
      expect(result.data).toMatchObject({
        delivered_to: 'a@example.com',
        note: expect.stringContaining('Standing preferences were not applied'),
      });
    }
  });

  it('stops when a fallback is held for review, and registers a delivered fallback', async () => {
    const register = vi.fn(async () => undefined);
    const send = vi.fn(async (request: { channel: string }) => {
      if (request.channel === 'web') {
        return { success: false, webDelivery: 'fallback' as const, blockedReason: 'dead' };
      }
      if (request.channel === 'signal') {
        return { success: false, gated: true, blockedReason: 'Held for review.' };
      }
      return { success: true, sentContent: 'sent' };
    });
    const base = ctx(send);
    const gateway = base.outboundGateway as NonNullable<typeof base.outboundGateway> & {
      configuredFallbackChannels: () => string[];
    };
    gateway.configuredFallbackChannels = () => ['signal', 'sms'];
    (gateway.resolveRecipientReference as ReturnType<typeof vi.fn>).mockImplementation(async (channel: string) => (
      channel === 'signal' || channel === 'sms'
        ? { ok: true, identifier: channel === 'signal' ? '+15555550123' : '+15555550199', kind: 'alias', contactId: 'c1' }
        : { ok: false, error: 'no' }
    ));
    const outboundContext = { register, explicitExpiryHours: 6, defaultExpiryHoursFor: () => 6 };
    const held = await handler.execute({ ...base, outboundContext } as unknown as ToolContext);
    expect(held.success).toBe(false);
    if (!held.success) expect(held.error).toBe('Held for review.');
    expect(send.mock.calls.map((call) => (call[0] as { channel: string }).channel)).toEqual(['web', 'signal']);

    send.mockImplementation(async (request: { channel: string }) => {
      if (request.channel === 'web') {
        return { success: false, webDelivery: 'fallback' as const, blockedReason: 'dead' };
      }
      return { success: true, sentContent: 'sent' };
    });
    const delivered = await handler.execute({ ...base, outboundContext } as unknown as ToolContext);
    expect(delivered.success).toBe(true);
    if (delivered.success) expect(delivered.data).toMatchObject({ channel: 'signal', delivered_to: '+15555550123' });
    expect(register).toHaveBeenCalled();
  });

  it('keeps both notes when the fallback channel defers to the digest', async () => {
    const send = vi.fn(async (request: { channel: string }) => {
      if (request.channel === 'web') {
        return { success: false, webDelivery: 'fallback' as const, blockedReason: 'dead' };
      }
      return { success: true, deferredToDigest: true };
    });
    const base = ctx(send);
    const gateway = base.outboundGateway as NonNullable<typeof base.outboundGateway> & {
      configuredFallbackChannels: () => string[];
    };
    gateway.configuredFallbackChannels = () => ['signal'];
    const result = await handler.execute(base);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({ channel: 'signal', deferred_to_digest: true });
    const note = (result.data as { note: string }).note;
    expect(note).toContain(RELAY_DEFERRED_NOTE);
    expect(note).toContain('Standing preferences were not applied. Skipped sms, slack, email because they are not configured.');
  });

  it('registers the given context bridge for a delivered fallback, and declares the input', async () => {
    const register = vi.fn(async (_entry: unknown) => undefined);
    const send = vi.fn(async (request: { channel: string }) => {
      if (request.channel === 'web') {
        return { success: false, webDelivery: 'fallback' as const, blockedReason: 'dead' };
      }
      return { success: true, sentContent: 'The board moved to Thursday.' };
    });
    const base = ctx(send);
    const outboundContext = { register, explicitExpiryHours: 6, defaultExpiryHoursFor: () => 6 };
    const bridge = JSON.stringify({ agent_id: 'coordinator', expected_reply: 'yes or no', expires_in_hours: 48 });
    const result = await handler.execute({
      ...base,
      input: { ...base.input, context_bridge: bridge },
      outboundContext,
    } as unknown as ToolContext);
    expect(result.success).toBe(true);
    expect(register).toHaveBeenCalledOnce();
    expect(JSON.stringify(register.mock.calls[0]![0])).toContain('yes or no');
    expect(manifest.inputs).toHaveProperty('context_bridge');
  });

  it('declares each output once', () => {
    const raw = readFileSync(join(import.meta.dirname, 'tool.json'), 'utf-8');
    const outputs = raw.slice(raw.indexOf('"outputs"'), raw.indexOf('"permissions"'));
    const keys = [...outputs.matchAll(/^\s*"([a-z_]+)":/gm)].map((m) => m[1]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('note');
  });
});
