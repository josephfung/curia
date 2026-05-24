// src/dispatch/context-bridge-parse.test.ts
import { describe, it, expect, vi } from 'vitest';
import { registerOutboundContext } from './context-bridge-parse.js';
import type { OutboundContextCapability } from './outbound-context.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCap(overrides?: Partial<OutboundContextCapability>): OutboundContextCapability {
  return {
    register: vi.fn().mockResolvedValue('entry-id'),
    release: vi.fn().mockResolvedValue(undefined),
    defaultExpiryHours: 6,
    explicitExpiryHours: 24,
    ...overrides,
  };
}

const baseOpts = {
  channelId: 'signal',
  content: 'Hello world',
  agentId: 'test-agent',
  log: logger,
};

describe('registerOutboundContext', () => {
  it('no-ops when outboundContext is undefined', async () => {
    // Should complete without error and not call anything
    await expect(registerOutboundContext(undefined, undefined, baseOpts)).resolves.toBeUndefined();
  });

  it('registers minimal entry with defaultExpiryHours when context_bridge is absent/undefined', async () => {
    const cap = makeCap();
    await registerOutboundContext(cap, undefined, baseOpts);

    expect(cap.register).toHaveBeenCalledOnce();
    expect(cap.register).toHaveBeenCalledWith({
      channelId: 'signal',
      agentId: 'test-agent',
      content: 'Hello world',
      expiresInHours: 6,
    });
  });

  it('registers with explicit metadata and explicitExpiryHours when context_bridge is valid JSON', async () => {
    const cap = makeCap();
    const bridge = JSON.stringify({
      agent_id: 'meeting-debrief',
      expected_reply: 'Summary of decisions',
      delegation_hint: 'Delegate to meeting-debrief',
      metadata: { topic: 'standup' },
    });

    await registerOutboundContext(cap, bridge, baseOpts);

    expect(cap.register).toHaveBeenCalledOnce();
    expect(cap.register).toHaveBeenCalledWith({
      channelId: 'signal',
      agentId: 'meeting-debrief',
      content: 'Hello world',
      expectedReply: 'Summary of decisions',
      delegationHint: 'Delegate to meeting-debrief',
      metadata: { topic: 'standup' },
      expiresInHours: 24,
    });
  });

  it('uses caller-specified expires_in_hours over explicitExpiryHours', async () => {
    const cap = makeCap();
    const bridge = JSON.stringify({
      agent_id: 'meeting-debrief',
      expires_in_hours: 48,
    });

    await registerOutboundContext(cap, bridge, baseOpts);

    expect(cap.register).toHaveBeenCalledOnce();
    expect(cap.register).toHaveBeenCalledWith(
      expect.objectContaining({ expiresInHours: 48 }),
    );
  });

  it('falls back to auto-registration when context_bridge is malformed JSON', async () => {
    const cap = makeCap();
    await registerOutboundContext(cap, 'not valid json {{{', baseOpts);

    expect(cap.register).toHaveBeenCalledOnce();
    expect(cap.register).toHaveBeenCalledWith({
      channelId: 'signal',
      agentId: 'test-agent',
      content: 'Hello world',
      expiresInHours: 6,
    });
  });

  it('falls back to auto-registration when context_bridge has missing agent_id', async () => {
    const cap = makeCap();
    const bridge = JSON.stringify({
      expected_reply: 'Something',
      // agent_id is missing
    });

    await registerOutboundContext(cap, bridge, baseOpts);

    expect(cap.register).toHaveBeenCalledOnce();
    expect(cap.register).toHaveBeenCalledWith({
      channelId: 'signal',
      agentId: 'test-agent',
      content: 'Hello world',
      expiresInHours: 6,
    });
  });

  it('does not throw when register() rejects (best-effort)', async () => {
    const cap = makeCap({
      register: vi.fn().mockRejectedValue(new Error('DB down')),
    });

    // Should not throw
    await expect(registerOutboundContext(cap, undefined, baseOpts)).resolves.toBeUndefined();
  });
});
