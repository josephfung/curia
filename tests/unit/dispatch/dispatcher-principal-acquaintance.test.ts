// Dispatcher elevation of a verified email sender the principal knows (#2227).

import { describe, it, expect, vi } from 'vitest';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createInboundMessage, type AgentTaskEvent } from '../../../src/bus/events.js';
import type { ContactResolver } from '../../../src/contacts/contact-resolver.js';
import type { ChannelPolicyConfig, ContactKind, ContactTier } from '../../../src/contacts/types.js';
import type { ConfidencePipeline } from '../../../src/contacts/confidence-pipeline.js';
import type { AcquaintanceEvidence } from '../../../src/contacts/principal-acquaintance.js';
import { createLogger } from '../../../src/logger.js';

function resolvedSender(tier: ContactTier, kind: ContactKind, contactConfidence = 0) {
  return {
    resolved: true,
    contactId: 'contact-1',
    displayName: 'Priya Shah',
    role: null,
    systemRole: null,
    tier,
    kind,
    verified: true,
    kgNodeId: null,
    knowledgeSummary: '',
    authorization: null,
    contactConfidence,
  };
}

function harness(opts: {
  tier?: ContactTier;
  kind?: ContactKind;
  evidence?: AcquaintanceEvidence | null;
  elevated?: boolean;
  scoring?: boolean;
} = {}) {
  const logger = createLogger('error');
  const bus = new EventBus(logger);
  const tier = opts.tier ?? 'unknown';
  const kind = opts.kind ?? 'person';
  const resolve = vi.fn()
    .mockResolvedValueOnce(resolvedSender(tier, kind))
    .mockResolvedValue(resolvedSender('known', kind, 0.25));
  const evidenceFor = vi.fn().mockResolvedValue(opts.evidence === undefined ? 'principal-correspondence' : opts.evidence);
  const elevateTierToKnown = vi.fn().mockResolvedValue(opts.elevated ?? true);
  const incrementalUpdate = vi.fn().mockResolvedValue(0.25);
  const dispatcher = new Dispatcher({
    bus,
    logger,
    contactResolver: { resolve } as unknown as ContactResolver,
    principalAcquaintance: { check: { evidenceFor }, contacts: { elevateTierToKnown } },
    ...(opts.scoring
      ? {
          // Path 3 counts through recordInboundMessage; route it to the same spy so each
          // test counts every message_seen once, whichever path counted it.
          confidencePipeline: {
            incrementalUpdate,
            recordInboundMessage: async (id: string) => ({
              confidence: (await incrementalUpdate(id, { type: 'message_seen' })) as number,
              prior: null,
            }),
          } as unknown as ConfidencePipeline,
          channelPolicies: { email: { trust: 'low', unknownSender: 'allow' } } as unknown as Record<string, ChannelPolicyConfig>,
        }
      : {}),
  });
  dispatcher.register();
  const tasks: AgentTaskEvent[] = [];
  bus.subscribe('agent.task', 'agent', (e) => { tasks.push(e as AgentTaskEvent); });
  return { bus, resolve, evidenceFor, elevateTierToKnown, incrementalUpdate, tasks };
}

async function send(bus: EventBus, opts: { channelId?: string; senderVerified?: unknown } = {}) {
  await bus.publish('channel', createInboundMessage({
    conversationId: 'email:thread-1',
    channelId: opts.channelId ?? 'email',
    senderId: 'priya.shah@example.test',
    content: 'Subject: Time this week?\n\nCould I get 30 minutes with Avery?',
    metadata: { senderVerified: 'senderVerified' in opts ? opts.senderVerified : true },
  }));
}

describe('Dispatcher — senders the principal knows (#2227)', () => {
  it('elevates a verified unknown person with evidence, then resolves again', async () => {
    const h = harness();
    await send(h.bus);
    expect(h.evidenceFor).toHaveBeenCalledWith('priya.shah@example.test');
    expect(h.elevateTierToKnown).toHaveBeenCalledWith('contact-1', 'principal-correspondence');
    expect(h.resolve).toHaveBeenCalledTimes(2);
    expect(h.tasks).toHaveLength(1);
    expect(h.tasks[0]!.payload.senderContext).toMatchObject({ tier: 'known' });
    expect(h.tasks[0]!.payload.turnGuidance).toEqual(expect.arrayContaining(['principal-correspondent', 'acquaintance-time-request']));
  });

  it('counts the message once, before the trust score, so a first email clears scheduling', async () => {
    const h = harness({ scoring: true });
    await send(h.bus);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.incrementalUpdate).toHaveBeenCalledTimes(1);
    expect(h.incrementalUpdate).toHaveBeenCalledWith('contact-1', { type: 'message_seen' });
    // known on low-trust email: 0.6 x 0.4 + 0.25 x 0.4 = 0.34, over the 0.3 scheduling threshold.
    expect(h.tasks[0]!.payload.messageTrustScore).toBeCloseTo(0.34, 5);
  });

  it('still counts the message once when no elevation happens', async () => {
    const h = harness({ scoring: true, evidence: null });
    await send(h.bus);
    await vi.waitFor(() => expect(h.incrementalUpdate).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.incrementalUpdate).toHaveBeenCalledTimes(1);
  });

  it('scores any known sender after counting this message, so a new introduction can book', async () => {
    // Stored confidence 0 (a recently introduced contact): 0.24 before counting, under 0.3.
    const h = harness({ scoring: true, tier: 'known' });
    await send(h.bus);
    expect(h.evidenceFor).not.toHaveBeenCalled();
    expect(h.incrementalUpdate).toHaveBeenCalledTimes(1);
    expect(h.tasks[0]!.payload.messageTrustScore).toBeCloseTo(0.34, 5);
  });

  it('passes the evidence through as the elevation reason', async () => {
    const h = harness({ evidence: 'principal-domain' });
    await send(h.bus);
    expect(h.elevateTierToKnown).toHaveBeenCalledWith('contact-1', 'principal-domain');
  });

  it('leaves the sender unknown without evidence', async () => {
    const h = harness({ evidence: null });
    await send(h.bus);
    expect(h.elevateTierToKnown).not.toHaveBeenCalled();
    expect(h.resolve).toHaveBeenCalledTimes(1);
    expect(h.tasks[0]!.payload.senderContext).toMatchObject({ tier: 'unknown' });
    expect(h.tasks[0]!.payload.turnGuidance).not.toContain('acquaintance-time-request');
  });

  it('does not resolve again when the elevation did not happen', async () => {
    const h = harness({ elevated: false });
    await send(h.bus);
    expect(h.resolve).toHaveBeenCalledTimes(1);
    expect(h.tasks[0]!.payload.senderContext).toMatchObject({ tier: 'unknown' });
  });

  it.each([
    ['unverified mail', { senderVerified: false }],
    ['mail with no verification result', { senderVerified: undefined }],
    ['a truthy non-boolean verification flag', { senderVerified: 'true' }],
    ['a channel other than email', { channelId: 'signal' }],
  ])('never asks for %s', async (_name, sendOpts) => {
    const h = harness();
    await send(h.bus, sendOpts);
    expect(h.evidenceFor).not.toHaveBeenCalled();
    expect(h.elevateTierToKnown).not.toHaveBeenCalled();
  });

  it.each([
    ['an organization', { kind: 'organization' as const }],
    ['an automated sender', { kind: 'automated' as const }],
    ['a known contact', { tier: 'known' as const }],
    ['a blocked contact', { tier: 'blocked' as const }],
  ])('never asks for %s', async (_name, opts) => {
    const h = harness(opts);
    await send(h.bus);
    expect(h.evidenceFor).not.toHaveBeenCalled();
  });
});
