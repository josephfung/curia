// src/dispatch/context-bridge-parse.test.ts
import { describe, it, expect, vi } from 'vitest';
import { registerOutboundContext } from './context-bridge-parse.js';
import { OutboundContextService, ScopedOutboundContext } from './outbound-context.js';
import type { OutboundContextCapability } from './outbound-context.js';
import type { DbPool } from '../db/connection.js';
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
      ttlSource: 'channel-default',
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
        ttlSource: 'task-wake',
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
      ttlSource: 'explicit-tier',
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
      ttlSource: 'channel-default',
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
      ttlSource: 'channel-default',
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
      ttlSource: 'channel-default',
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
      ttlSource: 'explicit-tier',
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

// The stubs above mirror the real service by hand, which is exactly how the two
// resolution sites drifted once already: every production registration logged
// ttlSource 'caller' because registerOutboundContext always passes an explicit
// expiresInHours, while a stub-free unit test asserted the branch production
// could never reach. These tests drive the real service so that cannot recur.
describe('registerOutboundContext against the real OutboundContextService', () => {
  function makeService(spyLogger: { debug: ReturnType<typeof vi.fn> } & object) {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'row-id' }] }),
    } as unknown as DbPool;
    const service = new OutboundContextService(pool, spyLogger as unknown as typeof logger);
    return { pool, scoped: new ScopedOutboundContext(service, 'conv-1') };
  }

  function makeSpyLogger() {
    return { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  }

  it('records a bare email send as channel-default, not as an agent choice', async () => {
    const spyLogger = makeSpyLogger();
    const { pool, scoped } = makeService(spyLogger);

    await registerOutboundContext(scoped, undefined, { ...baseOpts, channelId: 'email' });

    expect(spyLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'email', expiresInHours: 72, ttlSource: 'channel-default' }),
      'Outbound context entry registered',
    );
    // And the window actually written to the row matches what was logged.
    const expiresAt = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]![1][7] as Date;
    expect(Math.abs(expiresAt.getTime() - (Date.now() + 72 * 3_600_000))).toBeLessThan(5000);
  });

  it('records a bare signal send as channel-default at the short window', async () => {
    const spyLogger = makeSpyLogger();
    const { scoped } = makeService(spyLogger);

    await registerOutboundContext(scoped, undefined, { ...baseOpts, channelId: 'signal' });

    expect(spyLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'signal', expiresInHours: 6, ttlSource: 'channel-default' }),
      'Outbound context entry registered',
    );
  });

  it('records an agent-chosen window as agent', async () => {
    const spyLogger = makeSpyLogger();
    const { scoped } = makeService(spyLogger);

    await registerOutboundContext(
      scoped,
      JSON.stringify({ agent_id: 'coordinator', expires_in_hours: 240 }),
      { ...baseOpts, channelId: 'email' },
    );

    expect(spyLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ expiresInHours: 240, ttlSource: 'agent' }),
      'Outbound context entry registered',
    );
  });

  it('records an annotated entry with no chosen window as explicit-tier', async () => {
    const spyLogger = makeSpyLogger();
    const { scoped } = makeService(spyLogger);

    await registerOutboundContext(
      scoped,
      JSON.stringify({ agent_id: 'coordinator', delegation_hint: 'contacts' }),
      { ...baseOpts, channelId: 'email' },
    );

    expect(spyLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ expiresInHours: 72, ttlSource: 'explicit-tier' }),
      'Outbound context entry registered',
    );
  });

  it('records a system-injected task-wake binding as task-wake, not as agent', async () => {
    const spyLogger = makeSpyLogger();
    const { scoped } = makeService(spyLogger);

    await registerOutboundContext(scoped, undefined, {
      ...baseOpts,
      channelId: 'signal',
      boundTask: { taskId: 'f9e9a0d9-0000-4000-8000-000000000001' },
    });

    expect(spyLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ expiresInHours: 168, ttlSource: 'task-wake' }),
      'Outbound context entry registered',
    );
  });
});

// A system-injected TTL is a floor, not a ceiling. Task-wake binds at 168h,
// which beats email's 72h default — but an operator who raises a channel past
// 168h would otherwise have the system's own binding expire before a bare
// entry on that channel, losing task correlation in the gap.
describe('system-injected task-wake TTL vs a longer channel default', () => {
  function capWithEmailTtl(hours: number): OutboundContextCapability {
    return makeCap({
      defaultExpiryHoursFor: (channelId: string) => (channelId === 'email' ? hours : 6),
    });
  }

  it('raises a task-wake binding to the channel default when the channel is longer', async () => {
    const cap = capWithEmailTtl(240);
    await registerOutboundContext(cap, undefined, {
      ...baseOpts,
      channelId: 'email',
      boundTask: { taskId: 'f9e9a0d9-0000-4000-8000-000000000001' },
    });

    expect(cap.register).toHaveBeenCalledWith(
      expect.objectContaining({ expiresInHours: 240, ttlSource: 'task-wake' }),
    );
  });

  it('leaves the task-wake binding at 168h when the channel default is shorter', async () => {
    const cap = capWithEmailTtl(72);
    await registerOutboundContext(cap, undefined, {
      ...baseOpts,
      channelId: 'email',
      boundTask: { taskId: 'f9e9a0d9-0000-4000-8000-000000000001' },
    });

    expect(cap.register).toHaveBeenCalledWith(
      expect.objectContaining({ expiresInHours: 168, ttlSource: 'task-wake' }),
    );
  });

  it('still lets an agent choose a window shorter than the channel default on a bound task', async () => {
    const cap = capWithEmailTtl(240);
    await registerOutboundContext(
      cap,
      JSON.stringify({ agent_id: 'coordinator', expires_in_hours: 4 }),
      {
        ...baseOpts,
        channelId: 'email',
        boundTask: { taskId: 'f9e9a0d9-0000-4000-8000-000000000001' },
      },
    );

    // The agent's deliberate 4h is authoritative — floors apply to windows the
    // system picked, never to one an agent asked for.
    expect(cap.register).toHaveBeenCalledWith(
      expect.objectContaining({ expiresInHours: 4, ttlSource: 'agent' }),
    );
  });
});

// The numbers the manifests and docs quote to the agent, pinned against the
// code that produces them. These drifted once: the chat manifests advertised
// "about 6 hours" inside the description of the context_bridge parameter, but
// passing that parameter yields max(explicitExpiryHours=24, channelDefault=6)
// = 24h. Email hid the bug because both tiers resolve to 72.
describe('documented TTL tiers per channel', () => {
  const CHANNEL_DEFAULTS: Record<string, number> = { email: 72, signal: 6, slack: 6, sms: 6 };

  function capFor(channelId: string): OutboundContextCapability {
    return makeCap({ defaultExpiryHoursFor: () => CHANNEL_DEFAULTS[channelId]! });
  }

  function registeredTtl(cap: OutboundContextCapability): number {
    const call = (cap.register as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { expiresInHours: number };
    return call.expiresInHours;
  }

  it.each([
    // channel, bare send, with a valid bridge carrying no expires_in_hours
    ['email', 72, 72],
    ['signal', 6, 24],
    ['slack', 6, 24],
    ['sms', 6, 24],
  ])('%s: bare send = %ih, with a valid context_bridge = %ih', async (channelId, bare, withBridge) => {
    const bareCap = capFor(channelId);
    await registerOutboundContext(bareCap, undefined, { ...baseOpts, channelId });
    expect(registeredTtl(bareCap)).toBe(bare);

    const bridgeCap = capFor(channelId);
    await registerOutboundContext(bridgeCap, JSON.stringify({ agent_id: 'coordinator' }), {
      ...baseOpts,
      channelId,
    });
    expect(registeredTtl(bridgeCap)).toBe(withBridge);
  });

  // The 24h tier is earned by a *valid* bridge, not by passing the parameter.
  // parseContextBridge drops malformed metadata and returns null, so the send
  // falls through to auto-registration — silently costing ~18h on chat channels.
  // The manifests and docs quote these tiers, so pin the malformed case too.
  it.each([
    ['malformed JSON', 'not json {{{'],
    ['valid JSON, missing agent_id', JSON.stringify({ expected_reply: 'x' })],
    ['valid JSON, blank agent_id', JSON.stringify({ agent_id: '   ' })],
    ['a JSON array', JSON.stringify([{ agent_id: 'coordinator' }])],
    ['an empty string', ''],
  ])('signal: %s falls back to the 6h bare-send tier, not 24h', async (_label, raw) => {
    const cap = capFor('signal');
    await registerOutboundContext(cap, raw, { ...baseOpts, channelId: 'signal' });
    expect(registeredTtl(cap)).toBe(6);
  });

  it('email is unaffected by malformed metadata — both tiers resolve to 72h', async () => {
    const cap = capFor('email');
    await registerOutboundContext(cap, 'not json {{{', { ...baseOpts, channelId: 'email' });
    expect(registeredTtl(cap)).toBe(72);
  });
});
