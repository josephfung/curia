// escalation-policy.test.ts — unit tests for mapActionRiskToConsequenceClass.
//
// The action/disclosure policy tables themselves are exercised via escalation-judge.test.ts;
// this file pins the manifest action_risk → consequence-class mapping, which Gate C relies on.

import { describe, it, expect } from 'vitest';
import { mapActionRiskToConsequenceClass } from './escalation-policy.js';

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
