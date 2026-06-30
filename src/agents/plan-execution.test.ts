import { describe, it, expect } from 'vitest';
import {
  buildPlanStepDescriptors,
  countMaterializationKinds,
  existingTaskIdForStep,
  findRemovedChildTaskIds,
  isPlanReadyForAutoComplete,
  parsePlanStepsInput,
  planStepDriftsFromChild,
  preflightPlanBlockWrite,
  resolveBlockedByTaskId,
  resolvePlanCompletionNote,
  validateDeliverableStepId,
  validatePlanStepsGraph,
} from './plan-execution.js';
import type { PlanProgressBlock } from '../db/plan-progress.js';

describe('validatePlanStepsGraph', () => {
  it('rejects self-referential and cyclic dependencies', () => {
    expect(validatePlanStepsGraph([
      { id: 'a', title: 'A', target_agent_id: 'coordinator', blocked_by_step_id: 'a' },
    ])).toMatch(/cycle/);
    expect(validatePlanStepsGraph([
      { id: 'a', title: 'A', target_agent_id: 'coordinator', blocked_by_step_id: 'b' },
      { id: 'b', title: 'B', target_agent_id: 'coordinator', blocked_by_step_id: 'a' },
    ])).toMatch(/cycle/);
  });

  it('rejects dependencies on lazy (unmaterialized) predecessors', () => {
    expect(validatePlanStepsGraph([
      { id: 'lazy', title: 'Lazy', target_agent_id: 'coordinator', materialize: false },
      { id: 'child', title: 'Child', target_agent_id: 'coordinator', blocked_by_step_id: 'lazy' },
    ])).toMatch(/lazy step/);
  });
});

describe('parsePlanStepsInput', () => {
  it('returns null for cyclic dependency graphs', () => {
    expect(parsePlanStepsInput([
      { id: 'a', title: 'A', target_agent_id: 'coordinator', blocked_by_step_id: 'b' },
      { id: 'b', title: 'B', target_agent_id: 'coordinator', blocked_by_step_id: 'a' },
    ])).toBeNull();
  });

  it('parses heterogeneous and iterate-leaf steps', () => {
    const steps = parsePlanStepsInput([
      { id: 'gather', title: 'Gather exec input', target_agent_id: 'coordinator' },
      {
        id: 'audit',
        title: 'Audit follows',
        target_agent_id: 'social-media',
        resumable: true,
      },
      {
        id: 'synthesis',
        title: 'Assemble kickoff plan',
        target_agent_id: 'coordinator',
        blocked_by_step_id: 'gather',
        materialize: false,
      },
    ]);
    expect(steps).toHaveLength(3);
    expect(steps?.[1]?.resumable).toBe(true);
    expect(steps?.[2]?.materialize).toBe(false);
  });
});

describe('resolveBlockedByTaskId', () => {
  it('maps step ids to child task ids', () => {
    const map = { gather: 'aaa', synthesis: 'bbb' };
    expect(resolveBlockedByTaskId('gather', map)).toBe('aaa');
    expect(resolveBlockedByTaskId(null, map)).toBeNull();
  });
});

describe('findRemovedChildTaskIds', () => {
  it('returns task ids for steps dropped from the plan', () => {
    const existing: PlanProgressBlock = {
      steps: [
        { id: 'a', taskId: 'task-a' },
        { id: 'b', taskId: 'task-b' },
      ],
      deliverableStepId: null,
      done: 0,
      total: 2,
      next: 'Run',
    };
    expect(findRemovedChildTaskIds(existing, new Set(['a']))).toEqual(['task-b']);
  });
});

describe('existingTaskIdForStep', () => {
  it('reuses prior task id for adaptive re-plan', () => {
    const existing: PlanProgressBlock = {
      steps: [{ id: 'gather', taskId: 'child-1' }],
      deliverableStepId: null,
      done: 0,
      total: 1,
      next: 'Run',
    };
    expect(existingTaskIdForStep(existing, 'gather')).toBe('child-1');
    expect(existingTaskIdForStep(existing, 'new-step')).toBeNull();
  });
});

describe('buildPlanStepDescriptors', () => {
  it('leaves lazy steps unmaterialized', () => {
    const steps = parsePlanStepsInput([
      { id: 'now', title: 'Now', target_agent_id: 'coordinator' },
      { id: 'later', title: 'Later', target_agent_id: 'coordinator', materialize: false },
    ])!;
    const descriptors = buildPlanStepDescriptors(steps, { now: 'task-1', later: null });
    expect(descriptors).toEqual([
      { id: 'now', taskId: 'task-1' },
      { id: 'later', taskId: null },
    ]);
  });
});

describe('countMaterializationKinds', () => {
  it('counts iterate leaves vs heterogeneous rows vs lazy steps', () => {
    const steps = parsePlanStepsInput([
      { id: 'a', title: 'A', target_agent_id: 'coordinator' },
      { id: 'b', title: 'B', target_agent_id: 'social-media', resumable: true },
      { id: 'c', title: 'C', target_agent_id: 'coordinator', materialize: false },
    ])!;
    expect(countMaterializationKinds(steps)).toEqual({
      heterogeneousRows: 1,
      iterateLeaves: 1,
      lazySteps: 1,
    });
  });
});

describe('validateDeliverableStepId', () => {
  it('accepts null and known step ids only', () => {
    const steps = parsePlanStepsInput([
      { id: 'final', title: 'Final', target_agent_id: 'coordinator' },
    ])!;
    expect(validateDeliverableStepId(null, steps!)).toBeNull();
    expect(validateDeliverableStepId('final', steps!)).toBe('final');
    expect(validateDeliverableStepId('missing', steps!)).toBeUndefined();
  });
});

describe('planStepDriftsFromChild', () => {
  it('detects field drift on reused children', () => {
    const step = { id: 'a', title: 'New title', target_agent_id: 'coordinator' };
    expect(planStepDriftsFromChild(step, {
      title: 'Old title',
      description: null,
      agentId: 'coordinator',
      waitingOnContactId: null,
      waitingOnText: null,
      errorBudget: {},
    })).toBe(true);
    expect(planStepDriftsFromChild(step, {
      title: 'New title',
      description: null,
      agentId: 'coordinator',
      waitingOnContactId: null,
      waitingOnText: null,
      errorBudget: {},
    })).toBe(false);
  });
});

describe('preflightPlanBlockWrite', () => {
  it('rejects oversized plan blocks before child mutations', () => {
    const steps = parsePlanStepsInput([
      { id: 'a', title: 'A', target_agent_id: 'coordinator' },
    ])!;
    const hugeNext = 'x'.repeat(9000);
    const result = preflightPlanBlockWrite(steps!, null, null, hugeNext);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('block_overflow');
    }
  });
});

describe('plan completion helpers (#1239)', () => {
  const plan: PlanProgressBlock = {
    steps: [
      { id: 'step-1', taskId: 'child-1' },
      { id: 'step-2', taskId: 'child-2' },
      { id: 'deliverable', taskId: 'child-3' },
    ],
    deliverableStepId: 'deliverable',
    done: 3,
    total: 3,
    next: 'Done',
  };

  it('requires the deliverable child to be done before auto-complete', () => {
    expect(isPlanReadyForAutoComplete(plan, {
      'child-1': 'done',
      'child-2': 'done',
      'child-3': 'done',
    })).toBe(true);
    expect(isPlanReadyForAutoComplete(plan, {
      'child-1': 'done',
      'child-2': 'done',
      'child-3': 'cancelled',
    })).toBe(false);
    expect(isPlanReadyForAutoComplete({ ...plan, done: 2 }, {
      'child-1': 'done',
      'child-2': 'done',
      'child-3': 'open',
    })).toBe(false);
  });

  it('surfaces the deliverable step output as the completion note', () => {
    const children = new Map([
      ['child-3', {
        title: 'Synthesis',
        description: null,
        progress: { notes: [{ at: 't', note: 'Kickoff plan ready' }] },
      }],
    ]);
    expect(resolvePlanCompletionNote(plan, children)).toBe('Kickoff plan ready');
  });
});
