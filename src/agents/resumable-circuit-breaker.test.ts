import { describe, it, expect } from 'vitest';
import {
  cursorsEqual,
  hasForwardProgress,
  hasFrontierProgress,
  processPausedSliceOutcome,
  processPlanFrontierWakeOutcome,
  readCircuitState,
  resolveResumableCeilings,
  mergeCircuitState,
  type ResumableCircuitState,
} from './resumable-circuit-breaker.js';
import { DEFAULT_RESUMABLE_CEILINGS } from '../config.js';
import type { ExecutionPausedPayload } from './resumable-task.js';

function paused(overrides: Partial<ExecutionPausedPayload> = {}): ExecutionPausedPayload {
  return {
    _curia_protocol: 'execution_paused',
    done: 25,
    total: 100,
    cursor: 'page:3',
    last_slice_units: 25,
    next: 'continue',
    ...overrides,
  };
}

describe('resumable-circuit-breaker (#1176)', () => {
  it('detects forward progress via done-count or cursor change', () => {
    expect(hasForwardProgress({ done: 10, cursor: 'a' }, { done: 11, cursor: 'a' })).toBe(true);
    expect(hasForwardProgress({ done: 10, cursor: 'a' }, { done: 10, cursor: 'b' })).toBe(true);
    expect(hasForwardProgress({ done: 10, cursor: 'a' }, { done: 10, cursor: 'a' })).toBe(false);
    expect(cursorsEqual({ x: 1 }, { x: 1 })).toBe(true);
    expect(cursorsEqual('page:1', 'page:2')).toBe(false);
  });

  it('resets stall counter on forward progress', () => {
    const circuit = {
      stallCount: 2,
      iterationCount: 5,
      startedAt: '2026-06-01T00:00:00.000Z',
      totalCostUsd: 0,
      lastProgress: { done: 20, cursor: 'page:2' },
    };
    const result = processPausedSliceOutcome({
      paused: paused({ done: 25, cursor: 'page:3' }),
      circuit,
      ceilings: { ...DEFAULT_RESUMABLE_CEILINGS, maxStalls: 3 },
      now: new Date('2026-06-01T01:00:00.000Z'),
    });
    expect(result.action).toBe('continue');
    if (result.action === 'continue') {
      expect(result.state.stallCount).toBe(0);
      expect(result.state.iterationCount).toBe(6);
    }
  });

  it('increments stall counter when paused with no progress', () => {
    const circuit = {
      stallCount: 0,
      iterationCount: 1,
      startedAt: '2026-06-01T00:00:00.000Z',
      totalCostUsd: 0,
      lastProgress: { done: 25, cursor: 'page:3' },
    };
    const result = processPausedSliceOutcome({
      paused: paused({ done: 25, cursor: 'page:3' }),
      circuit,
      ceilings: { ...DEFAULT_RESUMABLE_CEILINGS, maxStalls: 3 },
      now: new Date('2026-06-01T01:00:00.000Z'),
    });
    expect(result.action).toBe('continue');
    if (result.action === 'continue') {
      expect(result.state.stallCount).toBe(1);
    }
  });

  it('breaches after K consecutive stalls', () => {
    const circuit = {
      stallCount: 2,
      iterationCount: 10,
      startedAt: '2026-06-01T00:00:00.000Z',
      totalCostUsd: 0,
      lastProgress: { done: 25, cursor: 'page:3' },
    };
    const result = processPausedSliceOutcome({
      paused: paused({ done: 25, cursor: 'page:3' }),
      circuit,
      ceilings: { ...DEFAULT_RESUMABLE_CEILINGS, maxStalls: 3 },
      now: new Date('2026-06-01T01:00:00.000Z'),
    });
    expect(result.action).toBe('breach');
    if (result.action === 'breach') {
      expect(result.breach.reason).toBe('stall_limit');
    }
  });

  it('breaches on iteration, wallclock, and cost ceilings', () => {
    const base = {
      stallCount: 0,
      iterationCount: 99,
      startedAt: '2026-06-01T00:00:00.000Z',
      totalCostUsd: 9.5,
      lastProgress: { done: 25, cursor: 'page:3' },
    };
    const iteration = processPausedSliceOutcome({
      paused: paused({ done: 30, cursor: 'page:4' }),
      circuit: base,
      ceilings: { ...DEFAULT_RESUMABLE_CEILINGS, maxIterations: 100 },
      now: new Date('2026-06-01T01:00:00.000Z'),
    });
    expect(iteration.action).toBe('breach');
    if (iteration.action === 'breach') expect(iteration.breach.reason).toBe('max_iterations');

    const wallclock = processPausedSliceOutcome({
      paused: paused({ done: 30, cursor: 'page:4' }),
      circuit: { ...base, iterationCount: 5 },
      ceilings: { ...DEFAULT_RESUMABLE_CEILINGS, maxWallclockHours: 1 },
      now: new Date('2026-06-01T02:00:00.000Z'),
    });
    expect(wallclock.action).toBe('breach');
    if (wallclock.action === 'breach') expect(wallclock.breach.reason).toBe('max_wallclock');

    const cost = processPausedSliceOutcome({
      paused: paused({ done: 30, cursor: 'page:4' }),
      circuit: { ...base, iterationCount: 5 },
      ceilings: { ...DEFAULT_RESUMABLE_CEILINGS, maxCostUsd: 10 },
      sliceCostUsd: 0.6,
      now: new Date('2026-06-01T01:00:00.000Z'),
    });
    expect(cost.action).toBe('breach');
    if (cost.action === 'breach') expect(cost.breach.reason).toBe('max_cost');
  });

  it('rejects invalid startedAt in persisted circuit state', () => {
    expect(readCircuitState({
      resumableCircuit: {
        stallCount: 0,
        iterationCount: 1,
        startedAt: 'not-a-date',
        totalCostUsd: 0,
        lastProgress: { done: 0, cursor: null },
      },
    })).toBeNull();
  });

  it('uses slice_cost_usd from paused payload when side-channel is absent', () => {
    const result = processPausedSliceOutcome({
      paused: paused({ done: 20, cursor: 'page:2', slice_cost_usd: 1.5 }),
      circuit: {
        stallCount: 0,
        iterationCount: 0,
        startedAt: '2026-06-01T00:00:00.000Z',
        totalCostUsd: 9,
        lastProgress: { done: 20, cursor: 'page:2' },
      },
      ceilings: { ...DEFAULT_RESUMABLE_CEILINGS, maxCostUsd: 10 },
      now: new Date('2026-06-01T01:00:00.000Z'),
    });
    expect(result.action).toBe('breach');
    if (result.action === 'breach') expect(result.breach.reason).toBe('max_cost');
  });

  it('resolves per-task error_budget overrides', () => {
    expect(resolveResumableCeilings(DEFAULT_RESUMABLE_CEILINGS, { max_stalls: 5 })).toMatchObject({
      maxStalls: 5,
    });
  });

  it('round-trips circuit state in progress JSON', () => {
    const state = {
      stallCount: 1,
      iterationCount: 4,
      startedAt: '2026-06-01T00:00:00.000Z',
      totalCostUsd: 1.25,
      lastProgress: { done: 10, cursor: null },
    };
    const merged = mergeCircuitState({ notes: [] }, state);
    expect(readCircuitState(merged)).toEqual(state);
  });

  describe('planned-parent frontier progress (#1239)', () => {
    it('detects frontier progress via rollup or terminal children', () => {
      expect(hasFrontierProgress(
        { rollupDone: 1, terminalChildCount: 1 },
        { rollupDone: 2, terminalChildCount: 1 },
      )).toBe(true);
      expect(hasFrontierProgress(
        { rollupDone: 2, terminalChildCount: 2 },
        { rollupDone: 2, terminalChildCount: 3 },
      )).toBe(true);
      expect(hasFrontierProgress(
        { rollupDone: 2, terminalChildCount: 3 },
        { rollupDone: 2, terminalChildCount: 3 },
      )).toBe(false);
    });

    it('breaches after K parent wakes with no frontier progress', () => {
      const circuit = {
        stallCount: 2,
        iterationCount: 5,
        startedAt: '2026-06-01T00:00:00.000Z',
        totalCostUsd: 0,
        lastProgress: { done: 1, cursor: { terminalChildren: 1 } },
      };
      const result = processPlanFrontierWakeOutcome({
        snapshot: { rollupDone: 1, terminalChildCount: 1 },
        circuit,
        ceilings: { ...DEFAULT_RESUMABLE_CEILINGS, maxStalls: 3 },
        now: new Date('2026-06-01T01:00:00.000Z'),
      });
      expect(result.action).toBe('breach');
      if (result.action === 'breach') expect(result.breach.reason).toBe('stall_limit');
    });

    it('resets stall counter when the frontier advances', () => {
      const circuit = {
        stallCount: 2,
        iterationCount: 5,
        startedAt: '2026-06-01T00:00:00.000Z',
        totalCostUsd: 0,
        lastProgress: { done: 1, cursor: { terminalChildren: 1 } },
      };
      const result = processPlanFrontierWakeOutcome({
        snapshot: { rollupDone: 2, terminalChildCount: 2 },
        circuit,
        ceilings: { ...DEFAULT_RESUMABLE_CEILINGS, maxStalls: 3 },
        now: new Date('2026-06-01T01:00:00.000Z'),
      });
      expect(result.action).toBe('continue');
      if (result.action === 'continue') expect(result.state.stallCount).toBe(0);
    });
  });

  it('never escalates across several progressing continuation slices', () => {
    const startedAt = '2026-06-01T00:00:00.000Z';
    let circuit: ResumableCircuitState = {
      stallCount: 0,
      iterationCount: 0,
      startedAt,
      totalCostUsd: 0,
      lastProgress: { done: 0, cursor: null },
    };

    for (let slice = 1; slice <= 6; slice += 1) {
      const done = slice * 25;
      const result = processPausedSliceOutcome({
        paused: paused({
          done,
          cursor: `page:${slice}`,
          last_slice_units: 25,
        }),
        circuit,
        ceilings: { ...DEFAULT_RESUMABLE_CEILINGS, maxStalls: 3 },
        now: new Date(`2026-06-01T0${slice}:00:00.000Z`),
      });
      expect(result.action).toBe('continue');
      if (result.action !== 'continue') return;
      expect(result.state.stallCount).toBe(0);
      expect(result.state.iterationCount).toBe(slice);
      circuit = result.state;
    }
  });
});
