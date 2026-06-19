import { describe, it, expect } from 'vitest';
import { computeTrustScore, DEFAULT_TRUST_WEIGHTS } from '../../../src/dispatch/trust-scorer.js';

describe('computeTrustScore', () => {
  const weights = DEFAULT_TRUST_WEIGHTS;

  it('known high-trust sender, no risk → near 0.8', () => {
    // channelWeight=1.0*0.4=0.4, contactConfidence=1.0*0.4=0.4, penalty=0 → 0.8
    const score = computeTrustScore({
      channelTrustLevel: 'high',
      contactConfidence: 1.0,
      injectionRiskScore: 0,
      tier: null,
      weights,
    });
    expect(score).toBeCloseTo(0.8);
  });

  it('unknown sender via email, no risk → 0.12', () => {
    // channelWeight=0.3*0.4=0.12, contactConfidence=0.0*0.4=0, penalty=0 → 0.12
    const score = computeTrustScore({
      channelTrustLevel: 'low',
      contactConfidence: 0.0,
      injectionRiskScore: 0,
      tier: null,
      weights,
    });
    expect(score).toBeCloseTo(0.12);
  });

  it('medium channel, partial confidence, no risk', () => {
    // channelWeight=0.6*0.4=0.24, contactConfidence=0.5*0.4=0.20, penalty=0 → 0.44
    const score = computeTrustScore({
      channelTrustLevel: 'medium',
      contactConfidence: 0.5,
      injectionRiskScore: 0,
      tier: null,
      weights,
    });
    expect(score).toBeCloseTo(0.44);
  });

  it('trusted tier overrides channel weight to high-equivalent', () => {
    // tier='trusted' → channelWeight=1.0, overrides 'low' channel
    // 1.0*0.4 + 0.5*0.4 = 0.60
    const score = computeTrustScore({
      channelTrustLevel: 'low',
      contactConfidence: 0.5,
      injectionRiskScore: 0,
      tier: 'trusted',
      weights,
    });
    expect(score).toBeCloseTo(0.60);
  });

  it('principal tier overrides channel weight to high-equivalent (same as trusted)', () => {
    const score = computeTrustScore({
      channelTrustLevel: 'low',
      contactConfidence: 0.5,
      injectionRiskScore: 0,
      tier: 'principal',
      weights,
    });
    expect(score).toBeCloseTo(0.60);
  });

  it('known tier overrides channel weight to medium-equivalent (0.6)', () => {
    // tier='known' → 0.6 override on low (0.3) channel
    // 0.6*0.4 + 0.5*0.4 = 0.44
    const score = computeTrustScore({
      channelTrustLevel: 'low',
      contactConfidence: 0.5,
      injectionRiskScore: 0,
      tier: 'known',
      weights,
    });
    expect(score).toBeCloseTo(0.44);
  });

  it('unknown tier uses channel floor (no override)', () => {
    // tier='unknown' → channel floor (0.3)
    // 0.3*0.4 + 0.5*0.4 = 0.32
    const score = computeTrustScore({
      channelTrustLevel: 'low',
      contactConfidence: 0.5,
      injectionRiskScore: 0,
      tier: 'unknown',
      weights,
    });
    expect(score).toBeCloseTo(0.32);
  });

  it('null tier uses channel floor (no override)', () => {
    // same as unknown: channel floor 0.3*0.4 + 0.5*0.4 = 0.32
    const score = computeTrustScore({
      channelTrustLevel: 'low',
      contactConfidence: 0.5,
      injectionRiskScore: 0,
      tier: null,
      weights,
    });
    expect(score).toBeCloseTo(0.32);
  });

  it('injection risk reduces score', () => {
    // high channel, full confidence, riskScore=1.0 → 0.8 - 0.2 = 0.6
    const score = computeTrustScore({
      channelTrustLevel: 'high',
      contactConfidence: 1.0,
      injectionRiskScore: 1.0,
      tier: null,
      weights,
    });
    expect(score).toBeCloseTo(0.6);
  });

  it('score is clamped to 0.0 minimum', () => {
    const score = computeTrustScore({
      channelTrustLevel: 'low',
      contactConfidence: 0.0,
      injectionRiskScore: 1.0,
      tier: null,
      weights,
    });
    expect(score).toBe(0.0);
  });

  it('score is clamped to 1.0 maximum', () => {
    const score = computeTrustScore({
      channelTrustLevel: 'high',
      contactConfidence: 1.0,
      injectionRiskScore: -1.0,
      tier: null,
      weights: { channelWeight: 0.6, contactWeight: 0.6, maxRiskPenalty: 0.2 },
    });
    expect(score).toBe(1.0);
  });

  it('partial injection risk applies proportional penalty', () => {
    // high channel, full confidence, riskScore=0.5 → 0.8 - 0.1 = 0.7
    const score = computeTrustScore({
      channelTrustLevel: 'high',
      contactConfidence: 1.0,
      injectionRiskScore: 0.5,
      tier: null,
      weights,
    });
    expect(score).toBeCloseTo(0.7);
  });

  it('respects custom weight configuration', () => {
    const customWeights = { channelWeight: 0.5, contactWeight: 0.5, maxRiskPenalty: 0.1 };
    const score = computeTrustScore({
      channelTrustLevel: 'high',
      contactConfidence: 1.0,
      injectionRiskScore: 0,
      tier: null,
      weights: customWeights,
    });
    expect(score).toBe(1.0);
  });
});
