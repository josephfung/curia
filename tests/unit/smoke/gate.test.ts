// tests/unit/smoke/gate.test.ts — smoke's pass/fail gate (#1956).
import { describe, it, expect } from 'vitest';
import { emptyBreakdown, UsageLedger, type UsageBreakdown } from '../../shared/usage.js';
import { caseFailures, gatingFailures, mergeRetries, staleKnownFailures, type GateInput } from '../../smoke/gate.js';
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

describe('mergeRetries', () => {
  type Attempt = { weightedScore: number; failures: string[] };
  type Named = GateInput & { failures: string[]; passed: boolean; firstAttempt?: Attempt; usage: UsageBreakdown; providerRetries: string[] };
  function named(name: string, weightedScore: number, failures: string[], extra: Partial<Named> = {}): Named {
    const input = gateInput([['a', 'critical', failures.length ? 'MISS' : 'PASS']], weightedScore);
    return { ...input, testCase: { ...input.testCase, name }, failures, passed: failures.length === 0, usage: emptyBreakdown(), providerRetries: [], ...extra };
  }

  it('charges a retried case for both attempts\' spend and provider retries (#1980)', () => {
    const spent = (usd: number): UsageBreakdown => {
      const u = new UsageLedger();
      u.addAgentCall('coordinator', { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, usd);
      return u.snapshot();
    };
    const [merged] = mergeRetries(
      [named('B', 0.4, ['x'], { usage: spent(1), providerRetries: ['provider stall (one model call ran 95s)'] })],
      [named('B', 0.9, [], { usage: spent(2) })],
    );
    expect(merged!.usage.total.estimatedCostUsd).toBe(3);
    expect(merged!.usage.byAgent['coordinator']!.calls).toBe(2);
    expect(merged!.providerRetries).toEqual(['provider stall (one model call ran 95s)']);
  });

  it('takes the retry\'s result and keeps what the first attempt said', () => {
    const merged = mergeRetries(
      [named('A', 1, []), named('B', 0.4, ['weighted score 40% is below 80%'])],
      [named('B', 0.9, [])],
    );
    expect(merged.map(c => [c.testCase.name, c.passed])).toEqual([['A', true], ['B', true]]);
    expect(merged[1]!.firstAttempt).toEqual({ weightedScore: 0.4, failures: ['weighted score 40% is below 80%'] });
    expect(merged[0]!.firstAttempt).toBeUndefined();
  });

  it('fails a case that fails its retry too', () => {
    const merged = mergeRetries([named('B', 0.4, ['x'])], [named('B', 0.5, ['y'])]);
    expect(merged[0]!.passed).toBe(false);
    expect(merged[0]!.failures).toEqual(['y']);
  });
});
