// tests/unit/smoke/gate.test.ts — smoke's pass/fail gate (#1956).
import { describe, it, expect } from 'vitest';
import { caseFailures, type GateInput } from '../../smoke/gate.js';
import type { BehaviorRating, BehaviorWeight, TestCase } from '../../smoke/types.js';

function gateInput(
  behaviors: Array<[id: string, weight: BehaviorWeight, rating: BehaviorRating]>,
  weightedScore: number,
  extra: Partial<GateInput> = {},
): GateInput {
  const testCase: TestCase = {
    name: 'Case',
    description: '',
    tags: [],
    sender: 'principal',
    judgeToolCalls: false,
    turns: [{ role: 'user', content: 'hi' }],
    expectedBehaviors: behaviors.map(([id, weight]) => ({ id, description: id, weight })),
    failureModes: [],
  };
  return {
    testCase,
    scores: behaviors.map(([id, , rating]) => ({ behaviorId: id, rating, justification: '' })),
    weightedScore,
    ...extra,
  };
}

describe('smoke gate', () => {
  it('passes at the 80% threshold with no critical MISS', () => {
    expect(caseFailures(gateInput([['a', 'critical', 'PASS'], ['b', 'nice-to-have', 'PARTIAL']], 0.8))).toEqual([]);
  });

  it('fails below 80%', () => {
    expect(caseFailures(gateInput([['a', 'important', 'PARTIAL']], 0.5)))
      .toEqual(['weighted score 50% is below 80%']);
  });

  it('fails a critical MISS even when the weighted score clears 80%', () => {
    // Five critical PASS and one critical MISS is 15/18 = 83%.
    const behaviors: Array<[string, BehaviorWeight, BehaviorRating]> = [
      ['a', 'critical', 'PASS'], ['b', 'critical', 'PASS'], ['c', 'critical', 'PASS'],
      ['d', 'critical', 'PASS'], ['e', 'critical', 'PASS'], ['f', 'critical', 'MISS'],
    ];
    expect(caseFailures(gateInput(behaviors, 15 / 18))).toEqual(["critical behavior 'f' rated MISS"]);
  });

  it('tolerates a critical PARTIAL that keeps the score at 80%', () => {
    const behaviors: Array<[string, BehaviorWeight, BehaviorRating]> = [
      ['a', 'critical', 'PARTIAL'], ['b', 'critical', 'PASS'], ['c', 'critical', 'PASS'],
      ['d', 'critical', 'PASS'],
    ];
    expect(caseFailures(gateInput(behaviors, 10.5 / 12))).toEqual([]);
  });

  it('reports only the cause for a case that did not complete', () => {
    expect(caseFailures(gateInput([['a', 'critical', 'MISS']], 0, { error: 'Timeout' })))
      .toEqual(['did not complete: Timeout']);
  });

  it('reports a judge error apart from model failures', () => {
    expect(caseFailures(gateInput([['a', 'critical', 'MISS']], 0, { judgeError: 'unparseable reply' })))
      .toEqual(['judge error (not a model failure): unparseable reply']);
  });

  it('fails a passing case whose cleanup failed', () => {
    expect(caseFailures(gateInput([['a', 'critical', 'PASS']], 1, { cleanupError: 'reset' })))
      .toEqual(['cleanup failed (leftover rows leak into later turns): reset']);
  });
});
