import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  advancePlanFrontier,
  handleChildTerminalResolution,
  isChildDispatchable,
  isChildTerminalStatus,
} from '../../../src/agents/plan-frontier.js';
import { isPlanParentWakeEligible } from '../../../src/agents/resumable-continuation.js';
import { DEFAULT_RESUMABLE_CEILINGS } from '../../../src/config.js';
import type { TaskRow } from '../../../src/db/queries/tasks.js';
import * as tasksQueries from '../../../src/db/queries/tasks.js';
import * as continuation from '../../../src/agents/resumable-continuation.js';

const CHILD_1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CHILD_2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CHILD_3 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const PARENT_1 = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

function sampleChild(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: CHILD_1,
    agentId: 'coordinator',
    intentAnchor: 'Step 1',
    status: 'open',
    progress: {},
    errorBudget: {},
    conversationId: null,
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    title: 'Child',
    description: null,
    owner: 'curia',
    waitingOnContactId: null,
    waitingOnText: null,
    parentTaskId: PARENT_1,
    blockedByTaskId: null,
    priority: 50,
    dueAt: null,
    source: 'coordinator',
    sourceAgentId: 'coordinator',
    createdBy: 'coordinator',
    tags: [],
    originator: null,
    ...overrides,
  };
}

function toDbRow(task: TaskRow) {
  return {
    id: task.id,
    agent_id: task.agentId,
    intent_anchor: task.intentAnchor,
    title: task.title,
    description: task.description,
    status: task.status,
    progress: task.progress,
    error_budget: task.errorBudget,
    conversation_id: task.conversationId,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    owner: task.owner,
    waiting_on_contact_id: task.waitingOnContactId,
    waiting_on_text: task.waitingOnText,
    parent_task_id: task.parentTaskId,
    blocked_by_task_id: task.blockedByTaskId,
    priority: task.priority,
    due_at: task.dueAt,
    source: task.source,
    source_agent_id: task.sourceAgentId,
    created_by: task.createdBy,
    tags: task.tags,
    originator: task.originator,
  };
}

function sampleParent(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    ...sampleChild({ id: PARENT_1, parentTaskId: null, title: 'Parent' }),
    progress: {
      plan: {
        steps: [
          { id: 'step-1', taskId: CHILD_1 },
          { id: 'step-2', taskId: CHILD_2 },
          { id: 'step-3', taskId: CHILD_3 },
        ],
        deliverableStepId: 'step-3',
        done: 0,
        total: 3,
        next: 'Run step 1',
      },
    },
    ...overrides,
  };
}

describe('isChildTerminalStatus', () => {
  it('recognizes terminal child statuses', () => {
    expect(isChildTerminalStatus('done')).toBe(true);
    expect(isChildTerminalStatus('cancelled')).toBe(true);
    expect(isChildTerminalStatus('failed')).toBe(true);
    expect(isChildTerminalStatus('open')).toBe(false);
  });
});

describe('isPlanParentWakeEligible', () => {
  it('requires a non-terminal task with a plan block', () => {
    expect(isPlanParentWakeEligible(sampleParent())).toBe(true);
    expect(isPlanParentWakeEligible(sampleParent({ status: 'done' }))).toBe(false);
    expect(isPlanParentWakeEligible(sampleParent({ status: 'failed' }))).toBe(false);
    expect(isPlanParentWakeEligible(sampleParent({ progress: {} }))).toBe(false);
  });
});

describe('isChildDispatchable', () => {
  const blockers = new Map([['blocker-1', 'done']]);

  it('dispatches open unblocked children without pending wakes', () => {
    expect(isChildDispatchable(sampleChild(), blockers, false)).toBe(true);
  });

  it('skips in_progress children and those with pending wakes', () => {
    expect(isChildDispatchable(sampleChild({ status: 'in_progress' }), blockers, false)).toBe(false);
    expect(isChildDispatchable(sampleChild(), blockers, true)).toBe(false);
  });

  it('waits until the blocker is resolved', () => {
    const blocked = sampleChild({ blockedByTaskId: 'blocker-2' });
    expect(isChildDispatchable(blocked, new Map([['blocker-2', 'open']]), false)).toBe(false);
    expect(isChildDispatchable(blocked, new Map([['blocker-2', 'done']]), false)).toBe(true);
  });
});

describe('handleChildTerminalResolution', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('schedules a parent wake when a child resolves under a planned parent', async () => {
    const scheduleSpy = vi.spyOn(continuation, 'schedulePlanParentWake')
      .mockResolvedValue({ scheduled: true, jobId: 'job-1', agentId: 'coordinator', runAt: new Date() });

    vi.spyOn(tasksQueries, 'getTaskById')
      .mockResolvedValueOnce(sampleChild({ id: CHILD_1, status: 'done' }))
      .mockResolvedValueOnce(sampleParent());

    await handleChildTerminalResolution({
      pool: {} as never,
      schedulerService: {} as never,
      logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never,
      childTaskId: 'child-1',
      delaySeconds: 30,
      eligibleAgents: new Set(['coordinator']),
    });

    expect(scheduleSpy).toHaveBeenCalledWith(expect.objectContaining({ taskId: PARENT_1, delaySeconds: 30 }));
  });

  it('skips when the child has no parent', async () => {
    const scheduleSpy = vi.spyOn(continuation, 'schedulePlanParentWake')
      .mockResolvedValue({ scheduled: true, jobId: 'job-1', agentId: 'coordinator', runAt: new Date() });

    vi.spyOn(tasksQueries, 'getTaskById').mockResolvedValue(sampleChild({ parentTaskId: null }));

    await handleChildTerminalResolution({
      pool: {} as never,
      schedulerService: {} as never,
      logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never,
      childTaskId: 'child-1',
      delaySeconds: 30,
      eligibleAgents: new Set(['coordinator']),
    });

    expect(scheduleSpy).not.toHaveBeenCalled();
  });
});

describe('advancePlanFrontier', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('recomputes rollup and dispatches unblocked children', async () => {
    const child1 = sampleChild({ id: CHILD_1, status: 'done' });
    const child2 = sampleChild({ id: CHILD_2, blockedByTaskId: CHILD_1 });
    const child3 = sampleChild({ id: CHILD_3, blockedByTaskId: CHILD_1 });
    const parent = sampleParent({ status: 'in_progress' });

    const taskRepo = {
      getTask: vi.fn().mockResolvedValue(parent),
      setPlanBlock: vi.fn().mockResolvedValue({
        task: parent,
        block: {
          steps: [
            { id: 'step-1', taskId: CHILD_1 },
            { id: 'step-2', taskId: CHILD_2 },
            { id: 'step-3', taskId: CHILD_3 },
          ],
          deliverableStepId: 'step-3',
          done: 1,
          total: 3,
          next: 'Run step 1',
        },
      }),
      completeTask: vi.fn().mockResolvedValue(null),
      persistPlanAdaptiveState: vi.fn().mockResolvedValue(undefined),
    };

    let tasksQueryCount = 0;
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('scheduled_jobs')) {
          return { rows: [{ pending: false }] };
        }
        tasksQueryCount++;
        if (tasksQueryCount === 1) {
          return { rows: [child1, child2, child3].map(toDbRow) };
        }
        return { rows: [toDbRow(child1)] };
      }),
    };

    const enqueueTaskWake = vi.fn().mockResolvedValue({ jobId: 'wake-1' });
    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };

    const result = await advancePlanFrontier({
      pool: pool as never,
      taskRepo: taskRepo as never,
      schedulerService: { enqueueTaskWake } as never,
      logger: logger as never,
      parentTaskId: PARENT_1,
      eligibleAgents: new Set(['coordinator']),
      resumableCeilings: DEFAULT_RESUMABLE_CEILINGS,
    });

    expect(result?.rollup).toEqual({ done: 1, total: 3 });
    expect(result?.rollupUpdated).toBe(true);
    expect(result?.dispatchedChildIds).toEqual([CHILD_2, CHILD_3]);
    expect(result?.autoCompleted).toBe(false);
    expect(enqueueTaskWake).toHaveBeenCalledTimes(2);
    expect(taskRepo.persistPlanAdaptiveState).toHaveBeenCalled();
  });

  it('persists divergence signals when a child failed', async () => {
    const child1 = sampleChild({ id: CHILD_1, status: 'failed' });
    const parent = sampleParent({ status: 'in_progress' });
    const updatedBlock = {
      steps: parent.progress.plan!.steps,
      deliverableStepId: 'step-3',
      done: 1,
      total: 3,
      next: 'Run step 1',
    };

    const persistPlanAdaptiveState = vi.fn().mockResolvedValue(undefined);
    const taskRepo = {
      getTask: vi.fn().mockResolvedValue(parent),
      setPlanBlock: vi.fn().mockResolvedValue({ task: parent, block: updatedBlock }),
      completeTask: vi.fn().mockResolvedValue(null),
      persistPlanAdaptiveState,
    };

    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('scheduled_jobs')) return { rows: [{ pending: false }] };
        return { rows: [child1].map(toDbRow) };
      }),
    };

    const result = await advancePlanFrontier({
      pool: pool as never,
      taskRepo: taskRepo as never,
      schedulerService: { enqueueTaskWake: vi.fn() } as never,
      logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never,
      parentTaskId: PARENT_1,
      eligibleAgents: new Set(['coordinator']),
      resumableCeilings: DEFAULT_RESUMABLE_CEILINGS,
    });

    expect(result?.divergenceSignals.some((s) => s.reason === 'child_failed')).toBe(true);
    expect(persistPlanAdaptiveState).toHaveBeenCalledWith(
      PARENT_1,
      expect.objectContaining({
        pendingSignals: expect.arrayContaining([
          expect.objectContaining({ reason: 'child_failed' }),
        ]),
      }),
    );
  });

  it('auto-completes the parent when all children and the deliverable step are done', async () => {
    const child1 = sampleChild({ id: CHILD_1, status: 'done', progress: { notes: [{ at: 't', note: 'Step 1 done' }] } });
    const child2 = sampleChild({ id: CHILD_2, status: 'done' });
    const child3 = sampleChild({
      id: CHILD_3,
      status: 'done',
      progress: { notes: [{ at: 't', note: 'Final deliverable output' }] },
    });
    const parent = sampleParent({ status: 'in_progress' });

    const completeTask = vi.fn().mockResolvedValue({ ...parent, status: 'done' });
    const taskRepo = {
      getTask: vi.fn().mockResolvedValue(parent),
      setPlanBlock: vi.fn().mockResolvedValue({
        task: parent,
        block: {
          steps: [
            { id: 'step-1', taskId: CHILD_1 },
            { id: 'step-2', taskId: CHILD_2 },
            { id: 'step-3', taskId: CHILD_3 },
          ],
          deliverableStepId: 'step-3',
          done: 3,
          total: 3,
          next: 'Done',
        },
      }),
      completeTask,
      persistPlanAdaptiveState: vi.fn().mockResolvedValue(undefined),
    };

    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('scheduled_jobs')) return { rows: [{ pending: false }] };
        return { rows: [child1, child2, child3].map(toDbRow) };
      }),
    };

    const result = await advancePlanFrontier({
      pool: pool as never,
      taskRepo: taskRepo as never,
      schedulerService: { enqueueTaskWake: vi.fn() } as never,
      logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never,
      parentTaskId: PARENT_1,
      eligibleAgents: new Set(['coordinator']),
      resumableCeilings: DEFAULT_RESUMABLE_CEILINGS,
    });

    expect(result?.autoCompleted).toBe(true);
    expect(completeTask).toHaveBeenCalledWith(
      PARENT_1,
      'Final deliverable output',
      'coordinator',
    );
  });

  it('auto-completes with a child-summary rollup when no deliverable step is marked', async () => {
    const child1 = sampleChild({
      id: CHILD_1,
      status: 'done',
      title: 'Research',
      progress: { notes: [{ at: 't', note: 'Found 12 competitors' }] },
    });
    const child2 = sampleChild({
      id: CHILD_2,
      status: 'done',
      title: 'Draft',
      progress: { notes: [{ at: 't', note: 'Outline complete' }] },
    });
    const parent = sampleParent({
      status: 'in_progress',
      progress: {
        plan: {
          steps: [
            { id: 'step-1', taskId: CHILD_1 },
            { id: 'step-2', taskId: CHILD_2 },
          ],
          deliverableStepId: null,
          done: 2,
          total: 2,
          next: 'Done',
        },
      },
    });

    const completeTask = vi.fn().mockResolvedValue({ ...parent, status: 'done' });
    const taskRepo = {
      getTask: vi.fn().mockResolvedValue(parent),
      setPlanBlock: vi.fn(),
      completeTask,
      persistPlanAdaptiveState: vi.fn().mockResolvedValue(undefined),
    };

    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('scheduled_jobs')) return { rows: [{ pending: false }] };
        return { rows: [child1, child2].map(toDbRow) };
      }),
    };

    const result = await advancePlanFrontier({
      pool: pool as never,
      taskRepo: taskRepo as never,
      schedulerService: { enqueueTaskWake: vi.fn() } as never,
      logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never,
      parentTaskId: PARENT_1,
      eligibleAgents: new Set(['coordinator']),
      resumableCeilings: DEFAULT_RESUMABLE_CEILINGS,
    });

    expect(result?.autoCompleted).toBe(true);
    expect(completeTask).toHaveBeenCalledWith(
      PARENT_1,
      'Research: Found 12 competitors\n\nDraft: Outline complete',
      'coordinator',
    );
  });
});
