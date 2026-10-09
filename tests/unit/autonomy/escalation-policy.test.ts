// escalation-policy.test.ts — unit tests for mapActionRiskToConsequenceClass and applyActionPolicy.
//
// The disclosure policy table is exercised via escalation-judge.test.ts;
// this file pins the manifest action_risk → consequence-class mapping and Gate C policy carve-outs.

import { describe, it, expect } from 'vitest';
import {
  mapActionRiskToConsequenceClass,
  applyActionPolicy,
  applyDisclosurePolicy,
  tierPermitsAllDisclosure,
  type DisclosureClass,
} from '../../../src/autonomy/escalation-policy.js';
import type { ContactTier } from '../../../src/contacts/types.js';

describe('mapActionRiskToConsequenceClass', () => {
  it('maps each named action_risk label to its consequence class', () => {
    expect(mapActionRiskToConsequenceClass('none')).toBe('none');
    expect(mapActionRiskToConsequenceClass('low')).toBe('reversible-internal');
    // medium (outbound comms) and high (calendar/commitment) are BOTH reversible-external.
    // Whether a given invocation is third-party-facing is a runtime property and is NOT
    // encoded here — Gate C consults the escalation judge for that distinction.
    expect(mapActionRiskToConsequenceClass('medium')).toBe('reversible-external');
    expect(mapActionRiskToConsequenceClass('high')).toBe('reversible-external');
    expect(mapActionRiskToConsequenceClass('critical')).toBe('irreversible');
  });

  it('treats numeric action_risk as irreversible (fail-closed — always escalates non-principal)', () => {
    expect(mapActionRiskToConsequenceClass(0)).toBe('irreversible');
    expect(mapActionRiskToConsequenceClass(55)).toBe('irreversible');
    expect(mapActionRiskToConsequenceClass(100)).toBe('irreversible');
  });

  it('fails closed on an unrecognized label', () => {
    // Defensive: not reachable through the typed ActionRisk union, but guards against a
    // widened/loosened input type silently allowing an action.
    expect(mapActionRiskToConsequenceClass('bogus' as unknown as 'none')).toBe('irreversible');
  });
});

describe('applyActionPolicy — principal-only carve-out (#1301)', () => {
  it('allows known-tier reversible-external to principal even when third-party-facing', () => {
    expect(applyActionPolicy('known', 'reversible-external', true, true)).toBe('allow');
  });

  it('still escalates irreversible actions to the principal', () => {
    expect(applyActionPolicy('known', 'irreversible', false, true)).toBe('escalate');
    expect(applyActionPolicy('trusted', 'irreversible', false, true)).toBe('escalate');
  });

  it('still escalates mixed recipient sets (third-party-facing, not principal-only)', () => {
    expect(applyActionPolicy('known', 'reversible-external', true, false)).toBe('escalate');
  });

  it('still escalates unknown-tier external sends to the principal (not a third-party carve-out)', () => {
    expect(applyActionPolicy('unknown', 'reversible-external', false, true)).toBe('escalate');
  });

  it('does not affect none/internal actions', () => {
    const tiers: ContactTier[] = ['unknown', 'known', 'trusted'];
    for (const tier of tiers) {
      expect(applyActionPolicy(tier, 'none', true, true)).toBe('allow');
      expect(applyActionPolicy(tier, 'reversible-internal', true, true)).toBe('allow');
    }
  });
});

describe('tierPermitsAllDisclosure (#1870)', () => {
  const ALL_CLASSES: DisclosureClass[] = ['public', 'principal-context', 'third-party', 'confidential'];

  it('is true only for tiers the policy table leaves unrestricted', () => {
    expect(tierPermitsAllDisclosure('principal')).toBe(true);
    expect(tierPermitsAllDisclosure('trusted')).toBe(true);
    expect(tierPermitsAllDisclosure('known')).toBe(false);
    expect(tierPermitsAllDisclosure('unknown')).toBe(false);
    expect(tierPermitsAllDisclosure('blocked')).toBe(false);
  });

  it('agrees with applyDisclosurePolicy for every tier', () => {
    // The short-circuit must never skip a tier the policy would escalate for.
    const tiers: ContactTier[] = ['blocked', 'unknown', 'known', 'trusted', 'principal'];
    for (const tier of tiers) {
      const allowsAll = ALL_CLASSES.every((c) => applyDisclosurePolicy(tier, c) === 'allow');
      expect(tierPermitsAllDisclosure(tier), tier).toBe(allowsAll);
    }
  });

  it('fails closed for an unrecognized tier', () => {
    expect(tierPermitsAllDisclosure('bogus' as ContactTier)).toBe(false);
  });
});
