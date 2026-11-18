import { describe, expect, it } from 'vitest';
import type { InboundSenderContext, SenderContext } from '../../../src/contacts/types.js';
import { stampOriginator } from '../../../src/contacts/stamp-originator.js';

const FIXED_AT = '2026-07-29T12:00:00.000Z';

function principalSender(overrides: Partial<SenderContext> = {}): SenderContext {
  return {
    resolved: true,
    contactId: '11111111-1111-1111-1111-111111111111',
    displayName: 'CEO',
    role: 'ceo',
    systemRole: 'principal',
    verified: true,
    kgNodeId: null,
    knowledgeSummary: '',
    authorization: null,
    contactConfidence: 1.0,
    tier: 'principal',
    kind: 'principal',
    ...overrides,
  };
}

function knownSender(overrides: Partial<SenderContext> = {}): SenderContext {
  return {
    resolved: true,
    contactId: '22222222-2222-2222-2222-222222222222',
    displayName: 'Alex Partner',
    role: 'partner',
    systemRole: null,
    verified: true,
    kgNodeId: null,
    knowledgeSummary: '',
    authorization: null,
    contactConfidence: 0.8,
    tier: 'trusted',
    kind: 'person',
    ...overrides,
  };
}

describe('stampOriginator', () => {
  it('stamps an authenticated principal originator with liveTurn=true', () => {
    const { originator, liveTurn } = stampOriginator({
      senderContext: principalSender(),
      channel: 'voice',
      senderId: 'ceo-web-user',
      initiatedAt: FIXED_AT,
      authenticated: true,
    });

    expect(liveTurn).toBe(true);
    expect(originator).toEqual({
      contactId: '11111111-1111-1111-1111-111111111111',
      systemRole: 'principal',
      channel: 'voice',
      initiatedAt: FIXED_AT,
      tier: 'principal',
      authenticated: true,
    });
  });

  // GHSA-p49r-jqh2-v668: a forged email From or a spoofed SMS number resolves to the principal.
  // It keeps the principal's identity but gets no live turn, the sole satisfier of the elevated gate.
  it.each([
    ['sms', '+15550100199'],
    ['email', 'ceo@example.test'],
  ])('keeps principal identity but grants no live turn on an unauthenticated %s inbound', (channel, senderId) => {
    const { originator, liveTurn } = stampOriginator({
      senderContext: principalSender(),
      channel,
      senderId,
      initiatedAt: FIXED_AT,
      authenticated: false,
    });

    expect(liveTurn).toBe(false);
    expect(originator.systemRole).toBe('principal');
    expect(originator.authenticated).toBe(false);
  });

  it.each(['signal', 'email', 'voice', 'web', 'cli'])('grants an authenticated %s principal inbound a live turn', (channel) => {
    const { liveTurn } = stampOriginator({
      senderContext: principalSender(),
      channel,
      senderId: 'x',
      authenticated: true,
    });
    expect(liveTurn).toBe(true);
  });

  it('stamps a non-principal caller with their tier/trust and liveTurn=false', () => {
    const { originator, liveTurn } = stampOriginator({
      senderContext: knownSender({ tier: 'known' }),
      channel: 'voice',
      senderId: '+15551234567',
      initiatedAt: FIXED_AT,
      authenticated: false,
    });

    expect(liveTurn).toBe(false);
    expect(originator).toEqual({
      contactId: '22222222-2222-2222-2222-222222222222',
      systemRole: null,
      channel: 'voice',
      initiatedAt: FIXED_AT,
      tier: 'known',
      authenticated: false,
    });
  });

  it('fail-closes unresolved senders with tier=unknown and liveTurn=false', () => {
    const senderContext: InboundSenderContext = {
      resolved: false,
      channel: 'voice',
      senderId: 'unknown-token',
    };
    const { originator, liveTurn } = stampOriginator({
      senderContext,
      channel: 'voice',
      senderId: 'unknown-token',
      initiatedAt: FIXED_AT,
      authenticated: false,
    });

    expect(liveTurn).toBe(false);
    expect(originator).toEqual({
      contactId: 'unknown-token',
      systemRole: null,
      channel: 'voice',
      initiatedAt: FIXED_AT,
      tier: 'unknown',
      authenticated: false,
    });
  });

  it('treats a missing senderContext like unresolved (#1059)', () => {
    const { originator, liveTurn } = stampOriginator({
      senderContext: undefined,
      channel: 'email',
      senderId: 'stranger@example.com',
      initiatedAt: FIXED_AT,
      authenticated: false,
    });

    expect(liveTurn).toBe(false);
    expect(originator.tier).toBe('unknown');
    expect(originator.contactId).toBe('stranger@example.com');
    expect(originator.systemRole).toBeNull();
  });

  it('does not treat agent/system roles as a live principal turn', () => {
    const { liveTurn: agentTurn } = stampOriginator({
      senderContext: knownSender({ systemRole: 'agent', tier: 'trusted' }),
      channel: 'voice',
      senderId: 'agent-1',
      authenticated: false,
    });
    const { liveTurn: systemTurn } = stampOriginator({
      senderContext: knownSender({ systemRole: 'system', tier: 'trusted' }),
      channel: 'voice',
      senderId: 'system',
      authenticated: false,
    });
    expect(agentTurn).toBe(false);
    expect(systemTurn).toBe(false);
  });

  it('carries whether the originating message authenticated its sender (#2312)', () => {
    const { originator } = stampOriginator({
      senderContext: principalSender(),
      channel: 'signal',
      senderId: '+15550100199',
      initiatedAt: FIXED_AT,
      authenticated: true,
    });
    expect(originator.authenticated).toBe(true);

    // An unresolved sender keeps the flag too: authentication is about the message, not the contact.
    const { originator: stranger } = stampOriginator({
      senderContext: undefined,
      channel: 'signal',
      senderId: '+15550100100',
      authenticated: true,
    });
    expect(stranger.authenticated).toBe(true);
    expect(stranger.tier).toBe('unknown');
  });
});
