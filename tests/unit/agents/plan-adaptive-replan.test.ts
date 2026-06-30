import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildPlanDivergenceGuidanceBlock,
  detectPlanAdaptiveBreach,
  detectPlanDivergence,
  readPlanAdaptiveState,
  mergePlanAdaptiveState,
  resolvePlanDepthForWrite,
  resolvePlanAdaptiveCeilings,
} from '../../../src/agents/plan-adaptive-replan.js';
import { DEFAULT_RESUMABLE_CEILINGS } from '../../../src/config.js';
import type { TaskRow } from '../../../src/db/queries/tasks.js';

const CHILD_1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function childRow(overrides: Partial<TaskRow> = {}): Pick<TaskRow, 'id' | 'status' | 'updatedAt' | 'progress' | 'errorBudget' | 'title'> {
  return {
    id: CHILD_1,
    status: 'open',
    updatedAt: '2026-06-01T00:00:00Z',
    progress: {},
    errorBudget: {},
    title: 'Audit follows',
    ...overrides,
  };
}

describe('plan-adaptive-replan (#1266)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('detects failed/cancelled children and over-blocked steps', () => {
    const now = new Date('2026-06-10T00:00:00Z');
    const children = new Map([
      [CHILD_1, childRow({ status: 'failed' })],
      ['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', childRow({
        id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        status: 'blocked',
        updatedAt: '2026-06-01T00:00:00Z',
        title: 'Legal review',
      })],
    ]);

    const signals = detectPlanDivergence({
      steps: [
        { id: 'step-1', taskId: CHILD_1 },
        { id: 'step-2', taskId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
      ],
      children,
      ceilings: { ...DEFAULT_RESUMABLE_CEILINGS, blockedStepHours: 48 },
      now,
    });

    expect(signals.some((s) => s.reason === 'child_failed')).toBe(true);
    expect(signals.some((s) => s.reason === 'step_over_blocked')).toBe(true);
  });

  it('detects throughput far below the implied iteration pace', () => {
    const children = new Map([
      [CHILD_1, childRow({
        progress: {
          resumable: {
            cursor: 'p1',
            done: 2,
            total: 100,
            lastSliceUnits: 1,
            next: 'continue',
            accumulator: [],
          },
          resumableCircuit: {
            stallCount: 0,
            iterationCount: 5,
            startedAt: '2026-06-01T00:00:00Z',
            totalCostUsd: 0.5,
            lastProgress: { done: 2, cursor: 'p1' },
          },
        },
      })],
    ]);

    const signals = detectPlanDivergence({
      steps: [{ id: 'step-1', taskId: CHILD_1 }],
      children,
      ceilings: { ...DEFAULT_RESUMABLE_CEILINGS, throughputDivergenceRatio: 0.5 },
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]!.reason).toBe('throughput_below_estimate');
  });

  it('returns no signals for a healthy plan', () => {
    const children = new Map([
      [CHILD_1, childRow({
        status: 'in_progress',
        progress: {
          resumable: {
            cursor: 'p5',
            done: 50,
            total: 100,
            lastSliceUnits: 10,
            next: 'continue',
            accumulator: [],
          },
          resumableCircuit: {
            stallCount: 0,
            iterationCount: 5,
            startedAt: '2026-06-01T00:00:00Z',
            totalCostUsd: 1,
            lastProgress: { done: 50, cursor: 'p5' },
          },
        },
      })],
    ]);

    const signals = detectPlanDivergence({
      steps: [{ id: 'step-1', taskId: CHILD_1 }],
      children,
      ceilings: DEFAULT_RESUMABLE_CEILINGS,
    });

    expect(signals).toEqual([]);
  });

  it('builds advisory divergence guidance without forcing re-plan', () => {
    const block = buildPlanDivergenceGuidanceBlock([
      { reason: 'child_failed', message: 'Child failed — consider re-running plan.' },
    ]);
    expect(block).toContain('advisory');
    expect(block).toContain('optional');
    expect(block).toContain('Child failed');
    expect(block).toContain('healthy plan');
  });

  it('breaches on depth or re-plan count limits', () => {
    expect(detectPlanAdaptiveBreach(
      { planDepth: 4, replanCount: 0 },
      { ...DEFAULT_RESUMABLE_CEILINGS, maxPlanDepth: 3 },
    )?.reason).toBe('max_plan_depth');

    expect(detectPlanAdaptiveBreach(
      { planDepth: 2, replanCount: 6 },
      { ...DEFAULT_RESUMABLE_CEILINGS, maxReplansPerSubtree: 5 },
    )?.reason).toBe('max_replans');
  });

  it('resolves plan depth for first plan and re-plan', () => {
    expect(resolvePlanDepthForWrite({ parentTaskId: null, progress: {} }, null, false)).toBe(1);
    expect(resolvePlanDepthForWrite(
      { parentTaskId: 'parent', progress: {} },
      { progress: { planAdaptive: { planDepth: 2, replanCount: 0, pendingSignals: [] } } },
      false,
    )).toBe(3);
    expect(resolvePlanDepthForWrite(
      { parentTaskId: null, progress: { planAdaptive: { planDepth: 2, replanCount: 1, pendingSignals: [] } } },
      null,
      true,
    )).toBe(2);
  });

  it('reads and merges planAdaptive state', () => {
    const progress = mergePlanAdaptiveState({}, {
      planDepth: 2,
      replanCount: 1,
      pendingSignals: [{ reason: 'child_failed', message: 'oops' }],
    });
    const state = readPlanAdaptiveState(progress);
    expect(state?.planDepth).toBe(2);
    expect(state?.pendingSignals).toHaveLength(1);
  });

  it('honours per-task error_budget overrides for adaptive ceilings', () => {
    const ceilings = resolvePlanAdaptiveCeilings(DEFAULT_RESUMABLE_CEILINGS, {
      max_plan_depth: 5,
      throughput_divergence_ratio: 0.25,
    });
    expect(ceilings.maxPlanDepth).toBe(5);
    expect(ceilings.throughputDivergenceRatio).toBe(0.25);
  });
});
