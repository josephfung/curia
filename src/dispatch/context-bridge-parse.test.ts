// src/dispatch/context-bridge-parse.test.ts
import { describe, it, expect, vi } from 'vitest';
import { registerOutboundContext } from './context-bridge-parse.js';
import type { OutboundContextCapability } from './outbound-context.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

// Mirrors the real service's channel-aware defaults (#1816) so these tests
// exercise the same resolution the dispatcher sees.
const CHANNEL_TTL: Record<string, number> = { email: 72 };

function makeCap(overrides?: Partial<OutboundContextCapability>): OutboundContextCapability {
  return {
    register: vi.fn().mockResolvedValue('entry-id'),
    release: vi.fn().mockResolvedValue(undefined),
    releaseEntry: vi.fn().mockResolvedValue(undefined),
    getEntry: vi.fn().mockResolvedValue(null),
    clearBySubjects: vi.fn().mockResolvedValue({ totalReleased: 0, perSubject: [], unmatched: [] }),
    defaultExpiryHours: 6,
    explicitExpiryHours: 24,
    defaultExpiryHoursFor: (channelId: string) => CHANNEL_TTL[channelId] ?? 6,
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

  it('auto-binds task-wake sends when boundTask is present without context_bridge (#1299)', async () => {
    const cap = makeCap();
    await registerOutboundContext(cap, undefined, {
      ...baseOpts,
      boundTask: { taskId: 'f9e9a0d9-0000-4000-8000-000000000001' },
    });

    expect(cap.register).toHaveBeenCalledOnce();
    expect(cap.register).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'test-agent',
        expectedReply: expect.stringContaining("CEO's reply to:"),
        metadata: {
          bind_reply: true,
          task_id: 'f9e9a0d9-0000-4000-8000-000000000001',
        },
        expiresInHours: 168,
      }),
    );
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

  // #1816 — the reported failure: an email auto-registered at 6h expired ~15h
  // before the recipient answered the next business day.
  it('auto-registers an email with the channel default TTL, not the flat default', async () => {
    const cap = makeCap();
    await registerOutboundContext(cap, undefined, { ...baseOpts, channelId: 'email' });

    expect(cap.register).toHaveBeenCalledWith({
      channelId: 'email',
      agentId: 'test-agent',
      content: 'Hello world',
      expiresInHours: 72,
    });
  });

  it('raises an explicit email bridge to the channel default when it names no expires_in_hours', async () => {
    const cap = makeCap();
    const bridge = JSON.stringify({ agent_id: 'coordinator', delegation_hint: 'contacts' });

    await registerOutboundContext(cap, bridge, { ...baseOpts, channelId: 'email' });

    // An annotated entry must never expire sooner than a bare one on the same channel.
    expect(cap.register).toHaveBeenCalledWith(
      expect.objectContaining({ expiresInHours: 72 }),
    );
  });

  it('keeps the 24h explicit tier on synchronous channels', async () => {
    const cap = makeCap();
    const bridge = JSON.stringify({ agent_id: 'coordinator' });

    await registerOutboundContext(cap, bridge, { ...baseOpts, channelId: 'signal' });

    expect(cap.register).toHaveBeenCalledWith(
      expect.objectContaining({ expiresInHours: 24 }),
    );
  });

  it('lets a caller-specified expires_in_hours win even when shorter than the channel default', async () => {
    const cap = makeCap();
    const bridge = JSON.stringify({ agent_id: 'coordinator', expires_in_hours: 3 });

    await registerOutboundContext(cap, bridge, { ...baseOpts, channelId: 'email' });

    expect(cap.register).toHaveBeenCalledWith(
      expect.objectContaining({ expiresInHours: 3 }),
    );
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

  it('preserves valid agent_id and drops malformed optional fields', async () => {
    const cap = makeCap();
    const bridge = JSON.stringify({
      agent_id: 'sales-agent',
      expected_reply: 123, // wrong type — should be string
      delegation_hint: 'delegate to sales',
    });

    await registerOutboundContext(cap, bridge, baseOpts);

    expect(cap.register).toHaveBeenCalledOnce();
    expect(cap.register).toHaveBeenCalledWith({
      channelId: 'signal',
      agentId: 'sales-agent', // preserved from bridge, not fallback
      content: 'Hello world',
      delegationHint: 'delegate to sales', // valid field kept
      expiresInHours: 24, // explicit path TTL
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
