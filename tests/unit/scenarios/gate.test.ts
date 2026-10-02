import { describe, expect, it } from 'vitest';
import { gateFailures, passRate, scoreCase } from '../../scenarios/gate.js';
import type { ExpectedBehavior, RunRating, ScenarioRun } from '../../scenarios/types.js';

const P: RunRating = { rating: 'PASS', justification: '' };
const H: RunRating = { rating: 'PARTIAL', justification: '' };
const M: RunRating = { rating: 'MISS', justification: '' };

function runs(n: number, error?: string): ScenarioRun[] {
  return Array.from({ length: n }, (_, i) => ({
    runIndex: i, inboundContent: '', toolCalls: [], reply: 'x', durationMs: 1, unstubbedCalls: 0,
    ...(error && i === 0 ? { error } : {}),
  }));
}

const critical: ExpectedBehavior = { id: 'routes', description: '', weight: 'critical' };
const minor: ExpectedBehavior = { id: 'tone', description: '', weight: 'nice-to-have' };

describe('passRate', () => {
  it('averages PASS=1, PARTIAL=0.5, MISS=0', () => {
    expect(passRate([P, H, M, P])).toBe(0.625);
    expect(passRate([])).toBe(0);
  });
});

describe('scoreCase', () => {
  it('passes a critical behavior at exactly 4/5', () => {
    const result = scoreCase('c', [critical], runs(5), new Map([['routes', [P, P, P, P, M]]]));
    expect(result.criticalFailures).toEqual([]);
  });

  it('fails a critical behavior below 0.8 (3/5, or 3/3 short of unanimity)', () => {
    expect(scoreCase('c', [critical], runs(5), new Map([['routes', [P, P, P, M, M]]])).criticalFailures).toEqual(['routes']);
    expect(scoreCase('c', [critical], runs(3), new Map([['routes', [P, P, M]]])).criticalFailures).toEqual(['routes']);
  });

  it('never gates a non-critical behavior', () => {
    expect(scoreCase('c', [minor], runs(2), new Map([['tone', [M, M]]])).criticalFailures).toEqual([]);
  });

  it('weights the score by behavior weight', () => {
    // critical (3) at 1.0, nice-to-have (1) at 0 → 3/4
    const result = scoreCase('c', [critical, minor], runs(1), new Map([['routes', [P]], ['tone', [M]]]));
    expect(result.weightedScore).toBe(0.75);
  });

  it('throws when a behavior is missing ratings instead of scoring it silently', () => {
    expect(() => scoreCase('c', [critical], runs(3), new Map([['routes', [P]]]))).toThrow(/1 rating\(s\) for 3 run/);
  });
});

describe('gateFailures', () => {
  it('names each failing critical behavior and each errored case', () => {
    const failing = scoreCase('transfer', [critical], runs(5), new Map([['routes', [P, M, M, M, M]]]));
    const errored = scoreCase('sweep', [minor], runs(2, 'Timeout waiting for response'), new Map([['tone', [M, P]]]));
    const lines = gateFailures([failing, errored]);
    expect(lines).toEqual([
      "transfer: critical behavior 'routes' passed 20% of runs (needs 80%)",
      'sweep: 1 run(s) errored — Timeout waiting for response',
    ]);
  });

  it('is empty when everything clears', () => {
    expect(gateFailures([scoreCase('ok', [critical], runs(5), new Map([['routes', [P, P, P, P, P]]]))])).toEqual([]);
  });
});
