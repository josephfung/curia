// tests/unit/smoke/gate.test.ts — smoke's pass/fail gate (#1956).
import { describe, it, expect } from 'vitest';
import { caseFailures, gatingFailures, staleKnownFailures, type GateInput } from '../../smoke/gate.js';
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
    toolStubs: {},
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

});

describe('known failures', () => {
  function result(passed: boolean, knownFailure?: string, extra: { error?: string; judgeError?: string } = {}) {
    const input = gateInput([['a', 'critical', passed ? 'PASS' : 'MISS']], passed ? 1 : 0);
    return {
      ...input,
      testCase: { ...input.testCase, ...(knownFailure ? { knownFailure: { issue: knownFailure } } : {}) },
      passed,
      ...extra,
    };
  }

  it('does not gate a known_failure case the model failed', () => {
    expect(gatingFailures([result(false, '#1')])).toEqual([]);
  });

  it('still gates an unmarked failure', () => {
    expect(gatingFailures([result(false)])).toHaveLength(1);
  });

  it('gates a known_failure case that errored or was misjudged — that says nothing about its bug', () => {
    expect(gatingFailures([result(false, '#1', { error: 'Timeout' })])).toHaveLength(1);
    expect(gatingFailures([result(false, '#1', { judgeError: 'unparseable' })])).toHaveLength(1);
  });

  it('flags a known_failure case that passed as possibly stale', () => {
    expect(staleKnownFailures([result(true, '#1'), result(true), result(false, '#2')]).map(c => c.testCase.knownFailure?.issue))
      .toEqual(['#1']);
  });
});
