import { describe, expect, it } from 'vitest';
import type { InboundSenderContext, SenderContext } from '../contacts/types.js';
import { stampOriginator } from './stamp-originator.js';

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
  it('stamps principal originator with liveTurn=true', () => {
    const { originator, liveTurn } = stampOriginator({
      senderContext: principalSender(),
      channel: 'voice',
      senderId: 'ceo-web-user',
      initiatedAt: FIXED_AT,
    });

    expect(liveTurn).toBe(true);
    expect(originator).toEqual({
      contactId: '11111111-1111-1111-1111-111111111111',
      systemRole: 'principal',
      channel: 'voice',
      initiatedAt: FIXED_AT,
      tier: 'principal',
    });
  });

  it('stamps a non-principal caller with their tier/trust and liveTurn=false', () => {
    const { originator, liveTurn } = stampOriginator({
      senderContext: knownSender({ tier: 'known' }),
      channel: 'voice',
      senderId: '+15551234567',
      initiatedAt: FIXED_AT,
    });

    expect(liveTurn).toBe(false);
    expect(originator).toEqual({
      contactId: '22222222-2222-2222-2222-222222222222',
      systemRole: null,
      channel: 'voice',
      initiatedAt: FIXED_AT,
      tier: 'known',
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
    });

    expect(liveTurn).toBe(false);
    expect(originator).toEqual({
      contactId: 'unknown-token',
      systemRole: null,
      channel: 'voice',
      initiatedAt: FIXED_AT,
      tier: 'unknown',
    });
  });

  it('treats a missing senderContext like unresolved (#1059)', () => {
    const { originator, liveTurn } = stampOriginator({
      senderContext: undefined,
      channel: 'email',
      senderId: 'stranger@example.com',
      initiatedAt: FIXED_AT,
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
    });
    const { liveTurn: systemTurn } = stampOriginator({
      senderContext: knownSender({ systemRole: 'system', tier: 'trusted' }),
      channel: 'voice',
      senderId: 'system',
    });
    expect(agentTurn).toBe(false);
    expect(systemTurn).toBe(false);
  });
});
