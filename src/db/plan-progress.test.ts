import { describe, it, expect } from 'vitest';
import {
  PLAN_BLOCK_MAX_BYTES,
  computePlanRollup,
  isPlannedStep,
  mergePlanIntoProgress,
  parsePlanBlock,
  planBlockBytes,
  preparePlanBlock,
  readPlanBlock,
  writePlanBlock,
  type PlanStepDescriptor,
} from './plan-progress.js';

const CHILD_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CHILD_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CHILD_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const STEPS: PlanStepDescriptor[] = [
  { id: 'gather-exec-input', taskId: CHILD_A },
  { id: 'synthesize-themes', taskId: CHILD_B },
  { id: 'assemble-kickoff', taskId: CHILD_C },
];

const BASE_INPUT = {
  steps: STEPS,
  deliverableStepId: 'assemble-kickoff',
  done: 1,
  total: 3,
  next: 'Wait for exec input, then synthesize themes',
};

describe('parsePlanBlock', () => {
  it('parses a valid block', () => {
    const block = parsePlanBlock({
      steps: STEPS,
      deliverableStepId: 'assemble-kickoff',
      done: 1,
      total: 3,
      next: 'Continue planning',
      plannedAt: '2026-06-29T00:00:00.000Z',
    });
    expect(block).toEqual({
      steps: STEPS,
      deliverableStepId: 'assemble-kickoff',
      done: 1,
      total: 3,
      next: 'Continue planning',
      plannedAt: '2026-06-29T00:00:00.000Z',
    });
  });

  it('accepts snake_case fields from persisted JSON', () => {
    const block = parsePlanBlock({
      steps: [{ id: 'step-1', task_id: CHILD_A }],
      deliverable_step_id: null,
      done: 0,
      total: 1,
      next: 'Materialize first step',
      planned_at: '2026-06-29T00:00:00.000Z',
    });
    expect(block?.steps[0]?.taskId).toBe(CHILD_A);
    expect(block?.deliverableStepId).toBeNull();
    expect(block?.plannedAt).toBe('2026-06-29T00:00:00.000Z');
  });

  it('accepts unmaterialized steps with null taskId', () => {
    const block = parsePlanBlock({
      steps: [
        { id: 'step-1', taskId: CHILD_A },
        { id: 'step-2', taskId: null },
      ],
      deliverableStepId: null,
      done: 0,
      total: 2,
      next: 'Create step 2 when step 1 completes',
    });
    expect(block?.steps[1]?.taskId).toBeNull();
  });

  it('returns null for invalid blocks', () => {
    expect(parsePlanBlock(null)).toBeNull();
    expect(parsePlanBlock({ ...BASE_INPUT, done: -1 })).toBeNull();
    expect(parsePlanBlock({ ...BASE_INPUT, next: '   ' })).toBeNull();
    expect(parsePlanBlock({ ...BASE_INPUT, total: 99 })).toBeNull();
    expect(parsePlanBlock({ ...BASE_INPUT, done: 5 })).toBeNull();
    expect(parsePlanBlock({ ...BASE_INPUT, deliverableStepId: 'missing-step' })).toBeNull();
    expect(parsePlanBlock({ ...BASE_INPUT, steps: [] })).toBeNull();
    expect(parsePlanBlock({ ...BASE_INPUT, steps: [{ id: 'dup' }, { id: 'dup' }] })).toBeNull();
    expect(parsePlanBlock({ ...BASE_INPUT, steps: [{ id: 'bad', taskId: 'not-a-uuid' }] })).toBeNull();
  });
});

describe('isPlannedStep', () => {
  it('detects a planned step solely from the plan block', () => {
    const progress = { notes: [], resumable: { cursor: 'x', done: 0, total: 1 } };
    expect(isPlannedStep(progress)).toBe(false);

    const written = writePlanBlock(progress, BASE_INPUT);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(isPlannedStep(written.progress)).toBe(true);
  });
});

describe('readPlanBlock / writePlanBlock round-trip', () => {
  it('writes and reads back from progress JSON', () => {
    const progress = { notes: [{ at: '2026-06-29T00:00:00.000Z', note: 'started' }] };
    const written = writePlanBlock(progress, BASE_INPUT);
    expect(written.ok).toBe(true);
    if (!written.ok) return;

    expect(written.progress.notes).toEqual(progress.notes);
    const reread = readPlanBlock(written.progress);
    expect(reread?.deliverableStepId).toBe('assemble-kickoff');
    expect(reread?.done).toBe(1);
    expect(reread?.total).toBe(3);
    expect(reread?.steps).toEqual(STEPS);
    expect(reread?.next).toBe(BASE_INPUT.next);
    expect(reread?.plannedAt).toBeDefined();
  });
});

describe('computePlanRollup', () => {
  it('counts done and cancelled children as resolved', () => {
    const rollup = computePlanRollup(STEPS, {
      [CHILD_A]: 'done',
      [CHILD_B]: 'in_progress',
      [CHILD_C]: 'cancelled',
    });
    expect(rollup).toEqual({ done: 2, total: 3 });
  });

  it('ignores unmaterialized steps and unknown task ids', () => {
    const steps: PlanStepDescriptor[] = [
      { id: 'a', taskId: CHILD_A },
      { id: 'b', taskId: null },
    ];
    const rollup = computePlanRollup(steps, {
      [CHILD_A]: 'done',
      [CHILD_B]: 'done',
      'dddddddd-dddd-dddd-dddd-dddddddddddd': 'done',
    });
    expect(rollup).toEqual({ done: 1, total: 2 });
  });

  it('returns zero done when no children are resolved', () => {
    const rollup = computePlanRollup(STEPS, {
      [CHILD_A]: 'in_progress',
      [CHILD_B]: 'open',
      [CHILD_C]: 'failed',
    });
    expect(rollup).toEqual({ done: 0, total: 3 });
  });
});

describe('preparePlanBlock', () => {
  it('always stamps plannedAt at write time', () => {
    const result = preparePlanBlock(BASE_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.block.plannedAt).toBeDefined();
    expect(Number.isNaN(Date.parse(result.block.plannedAt!))).toBe(false);
  });
});

describe('block bounding', () => {
  it('rejects blocks over the cap', () => {
    const manySteps: PlanStepDescriptor[] = Array.from({ length: 200 }, (_, i) => ({
      id: `step-${String(i).padStart(4, '0')}-with-a-long-descriptor-id-suffix`,
      taskId: `${String(i).padStart(8, '0')}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`,
    }));

    const result = preparePlanBlock({
      steps: manySteps,
      deliverableStepId: null,
      done: 0,
      total: manySteps.length,
      next: 'This plan is intentionally wide to test the block size cap',
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.code !== 'block_overflow') return;
    expect(result.bytes).toBeGreaterThan(PLAN_BLOCK_MAX_BYTES);
  });

  it('keeps a typical plan well under the cap', () => {
    const result = preparePlanBlock(BASE_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(planBlockBytes(result.block)).toBeLessThanOrEqual(PLAN_BLOCK_MAX_BYTES);
  });
});

describe('mergePlanIntoProgress', () => {
  it('preserves sibling progress blocks', () => {
    const block = preparePlanBlock(BASE_INPUT);
    if (!block.ok) throw new Error('expected valid block');

    const resumable = { cursor: 'page:1', done: 0, total: 10 };
    const merged = mergePlanIntoProgress(
      {
        notes: [],
        resumable,
        resumableCircuit: { stallCount: 0 },
        custom: true,
      },
      block.block,
    );

    expect(merged.custom).toBe(true);
    expect(merged.notes).toEqual([]);
    expect(merged.resumable).toEqual(resumable);
    expect(merged.resumableCircuit).toEqual({ stallCount: 0 });
    expect(merged.plan).toEqual(block.block);
  });
});
