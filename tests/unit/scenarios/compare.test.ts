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
  it('averages case-agent usage over runs without double-subtracting cache reads', () => {
    const totals = {
      ...emptyTotals(),
      calls: 4,
      // Already uncached (Anthropic meaning).
      inputTokens: 2000,
      cacheReadInputTokens: 500,
      cacheCreationInputTokens: 100,
    };
    const c = caseResult({
      name: 'example',
      agent: 'coordinator',
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
      usage: {
        byAgent: {
          coordinator: {
            ...totals,
            calls: 8,
            inputTokens: 4000,
            cacheReadInputTokens: 1000,
            cacheCreationInputTokens: 200,
          },
        },
        judge: emptyTotals(),
        total: {
          ...totals,
          calls: 8,
          inputTokens: 4000,
          cacheReadInputTokens: 1000,
          cacheCreationInputTokens: 200,
        },
      },
    });
    const m = caseMetrics(c);
    expect(m.agentCalls).toBe(4);
    expect(m.uncachedInputTokens).toBe(2000);
    expect(m.cachedInputTokens).toBe(500);
    expect(m.totalInputTokens).toBe(2600);
    expect(m.p50DurationMs).toBe(2000);
    expect(m.skillsByPath).toEqual({ model: ['tasks'], wake: ['email'] });
  });

  it('reads specialist usage from the case agent', () => {
    const totals = { ...emptyTotals(), calls: 2, inputTokens: 800, cacheReadInputTokens: 0 };
    const c = caseResult({
      name: 'calendar case',
      agent: 'calendar',
      usage: {
        byAgent: { calendar: totals },
        judge: emptyTotals(),
        total: totals,
      },
      runs: [{
        runIndex: 0, inboundContent: '', refs: {}, toolCalls: [], reply: 'ok',
        durationMs: 500, unstubbedCalls: 0,
        usage: { byAgent: { calendar: totals }, judge: emptyTotals(), total: totals },
        providerRetries: [],
      }],
      behaviors: [
        { behavior: { id: 'x', weight: 'critical' as const, description: 'x' }, ratings: [], passRate: 1, strictPassRate: 1 },
      ],
    });
    expect(caseMetrics(c).agentCalls).toBe(2);
    expect(caseMetrics(c).uncachedInputTokens).toBe(800);
  });

  it('flags live-turn cases outside the Layer 2 thresholds', () => {
    const baseTotals = { ...emptyTotals(), calls: 2, inputTokens: 1000, cacheReadInputTokens: 0 };
    const branchTotals = { ...emptyTotals(), calls: 4, inputTokens: 900, cacheReadInputTokens: 0 };
    const baseline = suite([caseResult({
      name: 'slow',
      agent: 'coordinator',
      runs: [{
        runIndex: 0, inboundContent: '', refs: {}, toolCalls: [], reply: 'ok',
        durationMs: 1000, unstubbedCalls: 0,
        usage: { byAgent: { coordinator: baseTotals }, judge: emptyTotals(), total: baseTotals },
        providerRetries: [],
      }],
      behaviors: [
        { behavior: { id: 'x', weight: 'critical' as const, description: 'x' }, ratings: [], passRate: 1, strictPassRate: 1 },
      ],
      usage: { byAgent: { coordinator: baseTotals }, judge: emptyTotals(), total: baseTotals },
    })]);
    const branch = suite([caseResult({
      name: 'slow',
      agent: 'coordinator',
      runs: [{
        runIndex: 0, inboundContent: '', refs: {}, toolCalls: [], reply: 'ok',
        durationMs: 2000, unstubbedCalls: 0,
        usage: { byAgent: { coordinator: branchTotals }, judge: emptyTotals(), total: branchTotals },
        providerRetries: [],
      }],
      behaviors: [
        { behavior: { id: 'x', weight: 'critical' as const, description: 'x' }, ratings: [], passRate: 1, strictPassRate: 1 },
      ],
      usage: { byAgent: { coordinator: branchTotals }, judge: emptyTotals(), total: branchTotals },
    })]);
    const rows = compareCases(baseline, branch, DEFAULT_THRESHOLDS);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.flags.some(f => f.includes('total input'))).toBe(true);
    expect(rows[0]!.flags.some(f => f.includes('calls'))).toBe(true);
    expect(rows[0]!.flags.some(f => f.includes('p50 duration'))).toBe(true);
  });

  it('flags a pass-rate drop of more than one run', () => {
    const totals = { ...emptyTotals(), calls: 1, inputTokens: 100, cacheReadInputTokens: 0 };
    const mk = (passRate: number, n: number): CaseResult => caseResult({
      name: 'flaky',
      agent: 'coordinator',
      runs: Array.from({ length: n }, (_, i) => ({
        runIndex: i, inboundContent: '', refs: {}, toolCalls: [], reply: 'ok',
        durationMs: 100, unstubbedCalls: 0,
        usage: { byAgent: { coordinator: totals }, judge: emptyTotals(), total: totals },
        providerRetries: [],
      })),
      behaviors: [
        { behavior: { id: 'x', weight: 'critical' as const, description: 'x' }, ratings: [], passRate, strictPassRate: passRate },
      ],
      usage: {
        byAgent: { coordinator: { ...totals, calls: n, inputTokens: 100 * n } },
        judge: emptyTotals(),
        total: { ...totals, calls: n, inputTokens: 100 * n },
      },
    });
    const rows = compareCases(suite([mk(1, 5)]), suite([mk(0.4, 5)]));
    expect(rows[0]!.flags.some(f => f.includes('pass rate'))).toBe(true);
  });

  it('for scheduled cases forbids call increases and skips the −40% token gate', () => {
    const baseTotals = { ...emptyTotals(), calls: 2, inputTokens: 1000, cacheReadInputTokens: 0 };
    const branchTotals = { ...emptyTotals(), calls: 3, inputTokens: 900, cacheReadInputTokens: 0 };
    const baseline = suite([caseResult({
      name: 'scheduled job',
      agent: 'coordinator',
      tags: ['scheduler'],
      runs: [{
        runIndex: 0, inboundContent: '', refs: {}, toolCalls: [], reply: 'ok',
        durationMs: 1000, unstubbedCalls: 0,
        usage: { byAgent: { coordinator: baseTotals }, judge: emptyTotals(), total: baseTotals },
        providerRetries: [],
      }],
      behaviors: [
        { behavior: { id: 'x', weight: 'critical' as const, description: 'x' }, ratings: [], passRate: 1, strictPassRate: 1 },
      ],
      usage: { byAgent: { coordinator: baseTotals }, judge: emptyTotals(), total: baseTotals },
    })]);
    const branch = suite([caseResult({
      name: 'scheduled job',
      agent: 'coordinator',
      tags: ['scheduler'],
      runs: [{
        runIndex: 0, inboundContent: '', refs: {}, toolCalls: [], reply: 'ok',
        durationMs: 1000, unstubbedCalls: 0,
        usage: { byAgent: { coordinator: branchTotals }, judge: emptyTotals(), total: branchTotals },
        providerRetries: [],
      }],
      behaviors: [
        { behavior: { id: 'x', weight: 'critical' as const, description: 'x' }, ratings: [], passRate: 1, strictPassRate: 1 },
      ],
      usage: { byAgent: { coordinator: branchTotals }, judge: emptyTotals(), total: branchTotals },
    })]);
    const flags = compareCases(baseline, branch)[0]!.flags;
    expect(flags.some(f => f.includes('scheduled calls'))).toBe(true);
    expect(flags.some(f => f.includes('total input'))).toBe(false);
  });

  it('passes when the branch improves within thresholds', () => {
    const baseInt = { ...emptyTotals(), calls: 3, inputTokens: 1000, cacheReadInputTokens: 0 };
    const branchInt = { ...emptyTotals(), calls: 3, inputTokens: 500, cacheReadInputTokens: 0 };
    const baseline = suite([caseResult({
      name: 'ok',
      agent: 'coordinator',
      runs: [{
        runIndex: 0, inboundContent: '', refs: {}, toolCalls: [], reply: 'ok',
        durationMs: 1000, unstubbedCalls: 0,
        usage: { byAgent: { coordinator: baseInt }, judge: emptyTotals(), total: baseInt },
        providerRetries: [],
      }],
      behaviors: [
        { behavior: { id: 'x', weight: 'critical' as const, description: 'x' }, ratings: [], passRate: 1, strictPassRate: 1 },
      ],
      usage: { byAgent: { coordinator: baseInt }, judge: emptyTotals(), total: baseInt },
    })]);
    const branch = suite([caseResult({
      name: 'ok',
      agent: 'coordinator',
      runs: [{
        runIndex: 0, inboundContent: '', refs: {}, toolCalls: [], reply: 'ok',
        durationMs: 1050, unstubbedCalls: 0,
        usage: { byAgent: { coordinator: branchInt }, judge: emptyTotals(), total: branchInt },
        providerRetries: [],
      }],
      behaviors: [
        { behavior: { id: 'x', weight: 'critical' as const, description: 'x' }, ratings: [], passRate: 1, strictPassRate: 1 },
      ],
      usage: { byAgent: { coordinator: branchInt }, judge: emptyTotals(), total: branchInt },
    })]);
    expect(compareCases(baseline, branch)[0]!.flags).toEqual([]);
  });
});
