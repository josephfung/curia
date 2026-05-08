import { describe, it, expect } from 'vitest';
import {
  computeConfidence,
  SATURATION,
  W_INTERACTION,
  W_RECENCY,
  GRANT_BOOST,
  MANUAL_BOOST,
  PAIRING_BOOST,
  RECENCY_HALF_LIFE_DAYS,
  type ConfidenceInput,
} from '../../../src/contacts/confidence-scorer.js';

// Helper to build inputs with sensible defaults
function input(overrides: Partial<ConfidenceInput> = {}): ConfidenceInput {
  return {
    inboundMessageCount: 0,
    outboundMessageCount: 0,
    lastSeenAt: null,
    trustLevel: null,
    verifiedIdentityCount: 0,
    hasCeoStatedIdentity: false,
    now: new Date('2026-01-15T12:00:00Z'),
    ...overrides,
  };
}

describe('computeConfidence', () => {
  it('returns 0 for a brand-new contact with no signals', () => {
    expect(computeConfidence(input())).toBe(0);
  });

  it('returns > 0 after first inbound message', () => {
    const score = computeConfidence(input({
      inboundMessageCount: 1,
      lastSeenAt: new Date('2026-01-15T12:00:00Z'),
    }));
    expect(score).toBeGreaterThan(0);
  });

  it('interaction score saturates at SATURATION messages', () => {
    const at20 = computeConfidence(input({
      inboundMessageCount: SATURATION,
      lastSeenAt: new Date('2026-01-15T12:00:00Z'),
    }));
    const at200 = computeConfidence(input({
      inboundMessageCount: 200,
      lastSeenAt: new Date('2026-01-15T12:00:00Z'),
    }));
    expect(at20).toBe(at200);
  });

  it('outbound messages contribute to interaction score', () => {
    const inboundOnly = computeConfidence(input({
      inboundMessageCount: 5,
      lastSeenAt: new Date('2026-01-15T12:00:00Z'),
    }));
    const withOutbound = computeConfidence(input({
      inboundMessageCount: 5,
      outboundMessageCount: 5,
      lastSeenAt: new Date('2026-01-15T12:00:00Z'),
    }));
    expect(withOutbound).toBeGreaterThan(inboundOnly);
  });

  it('recency decays with half-life', () => {
    const today = computeConfidence(input({
      inboundMessageCount: 10,
      lastSeenAt: new Date('2026-01-15T12:00:00Z'),
    }));
    const ninetyDaysAgo = computeConfidence(input({
      inboundMessageCount: 10,
      lastSeenAt: new Date('2025-10-17T12:00:00Z'),
    }));
    const yearAgo = computeConfidence(input({
      inboundMessageCount: 10,
      lastSeenAt: new Date('2025-01-15T12:00:00Z'),
    }));
    expect(today).toBeGreaterThan(ninetyDaysAgo);
    expect(ninetyDaysAgo).toBeGreaterThan(yearAgo);
  });

  it('recency is 0 when lastSeenAt is null', () => {
    const score = computeConfidence(input({
      outboundMessageCount: 5,
    }));
    const interactionOnly = (5 / SATURATION) * W_INTERACTION;
    expect(score).toBeCloseTo(interactionOnly);
  });

  it('CEO trust grant provides GRANT_BOOST', () => {
    const withoutGrant = computeConfidence(input({
      inboundMessageCount: 10,
      lastSeenAt: new Date('2026-01-15T12:00:00Z'),
    }));
    const withGrant = computeConfidence(input({
      inboundMessageCount: 10,
      lastSeenAt: new Date('2026-01-15T12:00:00Z'),
      trustLevel: 'high',
    }));
    expect(withGrant - withoutGrant).toBeCloseTo(GRANT_BOOST);
  });

  it('CEO-verified contact scores meaningfully higher than auto-resolved with same volume', () => {
    const autoResolved = computeConfidence(input({
      inboundMessageCount: 10,
      lastSeenAt: new Date('2026-01-15T12:00:00Z'),
    }));
    const ceoVerified = computeConfidence(input({
      inboundMessageCount: 10,
      lastSeenAt: new Date('2026-01-15T12:00:00Z'),
      trustLevel: 'high',
      hasCeoStatedIdentity: true,
    }));
    expect(ceoVerified - autoResolved).toBeGreaterThanOrEqual(0.2);
  });

  it('manual entry (ceo_stated identity) provides MANUAL_BOOST', () => {
    const without = computeConfidence(input());
    const with_ = computeConfidence(input({ hasCeoStatedIdentity: true }));
    expect(with_ - without).toBeCloseTo(MANUAL_BOOST);
  });

  it('verified identities provide pairing boost capped at 3', () => {
    const one = computeConfidence(input({ verifiedIdentityCount: 1 }));
    const three = computeConfidence(input({ verifiedIdentityCount: 3 }));
    const ten = computeConfidence(input({ verifiedIdentityCount: 10 }));
    expect(three).toBeGreaterThan(one);
    expect(ten).toBe(three);
  });

  it('result is clamped to [0.0, 1.0]', () => {
    const score = computeConfidence(input({
      inboundMessageCount: 1000,
      outboundMessageCount: 1000,
      lastSeenAt: new Date('2026-01-15T12:00:00Z'),
      trustLevel: 'high',
      hasCeoStatedIdentity: true,
      verifiedIdentityCount: 100,
    }));
    expect(score).toBeLessThanOrEqual(1.0);
    expect(score).toBeGreaterThanOrEqual(0.0);
  });

  it('result is never negative', () => {
    expect(computeConfidence(input())).toBe(0);
  });
});
