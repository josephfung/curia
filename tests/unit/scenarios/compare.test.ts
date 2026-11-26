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
    expect(rows[0]!.flags.some(f => f.includes('behaviour x pass rate'))).toBe(true);
  });

  it('flags a single regressed behaviour even when the mean stays within allowance', () => {
    const totals = { ...emptyTotals(), calls: 1, inputTokens: 100, cacheReadInputTokens: 0 };
    const mk = (rates: Record<string, number>): CaseResult => caseResult({
      name: 'multi',
      agent: 'coordinator',
      scheduled: false,
      runs: Array.from({ length: 5 }, (_, i) => ({
        runIndex: i, inboundContent: '', refs: {}, toolCalls: [], reply: 'ok',
        durationMs: 100, unstubbedCalls: 0,
        usage: { byAgent: { coordinator: totals }, judge: emptyTotals(), total: totals },
        providerRetries: [],
      })),
      behaviors: Object.entries(rates).map(([id, passRate]) => ({
        behavior: { id, weight: 'critical' as const, description: id },
        ratings: [],
        passRate,
        strictPassRate: passRate,
      })),
      usage: {
        byAgent: { coordinator: { ...totals, calls: 5, inputTokens: 500 } },
        judge: emptyTotals(),
        total: { ...totals, calls: 5, inputTokens: 500 },
      },
    });
    // Five behaviours: one drops 5/5 → 2/5 (−0.6); mean drop is only 0.12 (< 0.2).
    const baseline = suite([mk({ a: 1, b: 1, c: 1, d: 1, e: 1 })]);
    const branch = suite([mk({ a: 1, b: 1, c: 1, d: 1, e: 0.4 })]);
    const flags = compareCases(baseline, branch)[0]!.flags;
    expect(flags.some(f => f.includes('behaviour e pass rate'))).toBe(true);
  });

  it('for scheduled cases forbids call increases and skips the −40% token gate', () => {
    const baseTotals = { ...emptyTotals(), calls: 2, inputTokens: 1000, cacheReadInputTokens: 0 };
    const branchTotals = { ...emptyTotals(), calls: 3, inputTokens: 900, cacheReadInputTokens: 0 };
    const baseline = suite([caseResult({
      name: 'scheduled job',
      agent: 'coordinator',
      scheduled: true,
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
      scheduled: true,
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

  it('treats a scheduler-tagged principal turn (05a-shaped) as a live turn', () => {
    // 05a–05c carry tags: [scheduler] but inbound.from: principal — live-turn gates apply.
    const baseTotals = { ...emptyTotals(), calls: 2, inputTokens: 1000, cacheReadInputTokens: 0 };
    const mk = (totals: ReturnType<typeof emptyTotals> & { calls: number; inputTokens: number }): CaseResult => caseResult({
      name: '05a-shaped',
      agent: 'coordinator',
      scheduled: false,
      tags: ['scheduler'],
      runs: [{
        runIndex: 0, inboundContent: '', refs: {}, toolCalls: [], reply: 'ok',
        durationMs: 1000, unstubbedCalls: 0,
        usage: { byAgent: { coordinator: totals }, judge: emptyTotals(), total: totals },
        providerRetries: [],
      }],
      behaviors: [
        { behavior: { id: 'x', weight: 'critical' as const, description: 'x' }, ratings: [], passRate: 1, strictPassRate: 1 },
      ],
      usage: { byAgent: { coordinator: totals }, judge: emptyTotals(), total: totals },
    });
    // Tokens meet −40% (500 ≤ 1000×0.6); +0.2 calls within live +0.5 — but scheduled
    // "no increase" would still flag the calls. Correct classification → no flags.
    const soft = compareCases(
      suite([mk(baseTotals)]),
      suite([mk({ ...emptyTotals(), calls: 2.2, inputTokens: 500, cacheReadInputTokens: 0 })]),
    )[0]!.flags;
    expect(soft.some(f => f.includes('scheduled calls'))).toBe(false);
    expect(soft).toEqual([]);
    // Unchanged total input fails the live −40% gate; a scheduled misclassify would skip it.
    const tokens = compareCases(
      suite([mk(baseTotals)]),
      suite([mk({ ...emptyTotals(), calls: 2, inputTokens: 1000, cacheReadInputTokens: 0 })]),
    )[0]!.flags;
    expect(tokens.some(f => f.includes('total input'))).toBe(true);
    expect(tokens.some(f => f.includes('scheduled calls'))).toBe(false);
  });

  it('falls back to the scheduler tag when CaseResult.scheduled is absent (older results)', () => {
    const baseTotals = { ...emptyTotals(), calls: 2, inputTokens: 1000, cacheReadInputTokens: 0 };
    const branchTotals = { ...emptyTotals(), calls: 3, inputTokens: 900, cacheReadInputTokens: 0 };
    const mk = (totals: typeof baseTotals): CaseResult => caseResult({
      name: 'legacy scheduled',
      agent: 'coordinator',
      tags: ['scheduler'],
      // scheduled omitted — older results file
      runs: [{
        runIndex: 0, inboundContent: '', refs: {}, toolCalls: [], reply: 'ok',
        durationMs: 1000, unstubbedCalls: 0,
        usage: { byAgent: { coordinator: totals }, judge: emptyTotals(), total: totals },
        providerRetries: [],
      }],
      behaviors: [
        { behavior: { id: 'x', weight: 'critical' as const, description: 'x' }, ratings: [], passRate: 1, strictPassRate: 1 },
      ],
      usage: { byAgent: { coordinator: totals }, judge: emptyTotals(), total: totals },
    });
    const flags = compareCases(suite([mk(baseTotals)]), suite([mk(branchTotals)]))[0]!.flags;
    expect(flags.some(f => f.includes('scheduled calls'))).toBe(true);
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
