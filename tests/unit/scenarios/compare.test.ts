import { describe, expect, it } from 'vitest';
import { emptyBreakdown, emptyTotals } from '../../shared/usage.js';
import { caseMetrics, compareCases, DEFAULT_THRESHOLDS } from '../../scenarios/compare.js';
import type { CaseResult, SuiteResult } from '../../scenarios/types.js';

function caseResult(overrides: Partial<CaseResult> & { name: string }): CaseResult {
  return {
    runs: [],
    behaviors: [],
    weightedScore: 1,
    criticalFailures: [],
    requiredPassRate: 0.8,
    judgeErrors: 0,
    usage: emptyBreakdown(),
    ...overrides,
  };
}

function suite(cases: CaseResult[]): SuiteResult {
  return {
    timestamp: '2026-11-26T00:00:00.000Z',
    model: 'test',
    runsPerCase: Object.fromEntries(cases.map(c => [c.name, c.runs.length || 1])),
    cases,
    passed: true,
    knownFailures: [],
    warnings: [],
    gateFailures: [],
    durationMs: 1,
    concurrency: 1,
    usage: emptyBreakdown(),
    overheadUsage: emptyBreakdown(),
  };
}

describe('caseMetrics / compareCases (#2764)', () => {
  it('averages coordinator usage over runs and groups skills by path', () => {
    const totals = {
      ...emptyTotals(),
      calls: 4,
      inputTokens: 2000,
      cacheReadInputTokens: 500,
    };
    const c = caseResult({
      name: 'example',
      runs: [
        {
          runIndex: 0,
          inboundContent: 'a',
          refs: {},
          toolCalls: [],
          reply: 'ok',
          durationMs: 1000,
          unstubbedCalls: 0,
          usage: { byAgent: { coordinator: totals }, judge: emptyTotals(), total: totals },
          providerRetries: [],
          skillActivations: [
            { skill: 'tasks', by: 'model', agentId: 'coordinator' },
            { skill: 'email', by: 'wake', agentId: 'coordinator' },
          ],
        },
        {
          runIndex: 1,
          inboundContent: 'b',
          refs: {},
          toolCalls: [],
          reply: 'ok',
          durationMs: 3000,
          unstubbedCalls: 0,
          usage: { byAgent: { coordinator: totals }, judge: emptyTotals(), total: totals },
          providerRetries: [],
          skillActivations: [{ skill: 'tasks', by: 'model', agentId: 'coordinator' }],
        },
      ],
      behaviors: [
        { behavior: { id: 'x', weight: 'critical' as const, description: 'x' }, ratings: [], passRate: 1, strictPassRate: 1 },
      ],
      // Case usage is the sum across runs (cli.ts aggregates that way).
      usage: {
        byAgent: { coordinator: { ...totals, calls: 8, inputTokens: 4000, cacheReadInputTokens: 1000 } },
        judge: emptyTotals(),
        total: { ...totals, calls: 8, inputTokens: 4000, cacheReadInputTokens: 1000 },
      },
    });
    const m = caseMetrics(c);
    expect(m.coordinatorCalls).toBe(4);
    expect(m.inputTokens).toBe(2000);
    expect(m.cachedInputTokens).toBe(500);
    expect(m.uncachedInputTokens).toBe(1500);
    expect(m.p50DurationMs).toBe(2000);
    expect(m.skillsByPath).toEqual({ model: ['tasks'], wake: ['email'] });
  });

  it('flags cases outside the Layer 2 thresholds', () => {
    const baseTotals = { ...emptyTotals(), calls: 2, inputTokens: 1000, cacheReadInputTokens: 0 };
    const branchTotals = { ...emptyTotals(), calls: 4, inputTokens: 900, cacheReadInputTokens: 0 };
    const baseline = suite([caseResult({
      name: 'slow',
      runs: [{
        runIndex: 0, inboundContent: '', refs: {}, toolCalls: [], reply: 'ok',
        durationMs: 1000, unstubbedCalls: 0,
        usage: { byAgent: { coordinator: baseTotals }, judge: emptyTotals(), total: baseTotals },
        providerRetries: [],
      }],
      usage: { byAgent: { coordinator: baseTotals }, judge: emptyTotals(), total: baseTotals },
    })]);
    const branch = suite([caseResult({
      name: 'slow',
      runs: [{
        runIndex: 0, inboundContent: '', refs: {}, toolCalls: [], reply: 'ok',
        durationMs: 2000, unstubbedCalls: 0,
        usage: { byAgent: { coordinator: branchTotals }, judge: emptyTotals(), total: branchTotals },
        providerRetries: [],
      }],
      usage: { byAgent: { coordinator: branchTotals }, judge: emptyTotals(), total: branchTotals },
    })]);
    const rows = compareCases(baseline, branch, DEFAULT_THRESHOLDS);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.flags.some(f => f.includes('uncached input'))).toBe(true);
    expect(rows[0]!.flags.some(f => f.includes('coordinator calls'))).toBe(true);
    expect(rows[0]!.flags.some(f => f.includes('p50 duration'))).toBe(true);
  });

  it('passes when the branch improves within thresholds', () => {
    const baseTotals = { ...emptyTotals(), calls: 3, inputTokens: 1000, cacheReadInputTokens: 0 };
    const branchTotals = { ...emptyTotals(), calls: 3.2, inputTokens: 500, cacheReadInputTokens: 0 };
    // Integer calls in UsageTotals — use 3 vs 3 (within +0.5) and halved tokens.
    const baseInt = { ...baseTotals, calls: 3 };
    const branchInt = { ...emptyTotals(), calls: 3, inputTokens: 500, cacheReadInputTokens: 0 };
    void branchTotals;
    const baseline = suite([caseResult({
      name: 'ok',
      runs: [{
        runIndex: 0, inboundContent: '', refs: {}, toolCalls: [], reply: 'ok',
        durationMs: 1000, unstubbedCalls: 0,
        usage: { byAgent: { coordinator: baseInt }, judge: emptyTotals(), total: baseInt },
        providerRetries: [],
      }],
      usage: { byAgent: { coordinator: baseInt }, judge: emptyTotals(), total: baseInt },
    })]);
    const branch = suite([caseResult({
      name: 'ok',
      runs: [{
        runIndex: 0, inboundContent: '', refs: {}, toolCalls: [], reply: 'ok',
        durationMs: 1050, unstubbedCalls: 0,
        usage: { byAgent: { coordinator: branchInt }, judge: emptyTotals(), total: branchInt },
        providerRetries: [],
      }],
      usage: { byAgent: { coordinator: branchInt }, judge: emptyTotals(), total: branchInt },
    })]);
    expect(compareCases(baseline, branch)[0]!.flags).toEqual([]);
  });
});
