import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { PlanHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { TaskRepo } from '../../src/db/task-repo.js';
import type { TaskRow } from '../../src/db/queries/tasks.js';

const silentLog = pino({ level: 'silent' });
const PARENT_ID = '00000000-0000-0000-0000-000000000001';
const CHILD_GATHER = '00000000-0000-0000-0000-000000000002';
const CHILD_AUDIT = '00000000-0000-0000-0000-000000000003';
const CHILD_SYNTH = '00000000-0000-0000-0000-000000000004';

function makeCtx(overrides: Partial<SkillContext> = {}): SkillContext {
  const taskRepo = overrides.taskRepo
    ? { ...planRepoExtras(), ...overrides.taskRepo }
    : undefined;
  return {
    input: {},
    secret: () => 'unused',
    log: silentLog,
    agentId: 'coordinator',
    ...overrides,
    taskRepo,
  } as unknown as SkillContext;
}

function makeTaskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: PARENT_ID,
    agentId: 'coordinator',
    intentAnchor: 'Design kickoff',
    title: 'Design kickoff',
    description: null,
    status: 'in_progress',
    progress: { notes: [] },
    errorBudget: {},
    conversationId: null,
    createdAt: '2026-06-29T00:00:00.000Z',
    updatedAt: '2026-06-29T00:00:00.000Z',
    owner: 'curia',
    waitingOnContactId: null,
    waitingOnText: null,
    parentTaskId: null,
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

function planRepoExtras() {
  return {
    persistPlanAdaptiveState: vi.fn().mockResolvedValue(undefined),
  };
}

describe('PlanHandler', () => {
  it('materializes heterogeneous children with deps and human-wait steps', async () => {
    const created: TaskRow[] = [];
    const taskRepo = {
      getTask: vi.fn(async (id: string) => {
        if (id === PARENT_ID) return makeTaskRow();
        return created.find((t) => t.id === id) ?? null;
      }),
      createTask: vi.fn(async (params) => {
        const row = makeTaskRow({
          id: params.title.includes('Audit') ? CHILD_AUDIT : CHILD_GATHER,
          title: params.title,
          parentTaskId: params.parentTaskId ?? null,
          blockedByTaskId: params.blockedByTaskId ?? null,
          waitingOnContactId: params.waitingOnContactId ?? null,
          agentId: params.agentId,
          errorBudget: params.resumable ? { resumable: true } : {},
        });
        created.push(row);
        return row;
      }),
      updateTask: vi.fn().mockResolvedValue(makeTaskRow()),
      setPlanBlock: vi.fn().mockResolvedValue({
        task: makeTaskRow(),
        block: { done: 0, total: 2, steps: [] },
      }),
    } as unknown as TaskRepo;

    const handler = new PlanHandler();
    const result = await handler.execute(makeCtx({
      taskRepo,
      agentRegistry: { has: () => true } as unknown as SkillContext['agentRegistry'],
      input: {
        task_id: PARENT_ID,
        steps: [
          {
            id: 'gather',
            title: 'Gather exec input',
            target_agent_id: 'coordinator',
            waiting_on_contact_id: 'contact-1',
            waiting_on_text: 'Need your input',
          },
          {
            id: 'audit',
            title: 'Audit follows',
            target_agent_id: 'social-media',
            resumable: true,
            blocked_by_step_id: 'gather',
          },
        ],
        deliverable_step_id: 'audit',
        next: 'Wait for exec input',
      },
    }));

    expect(result.success).toBe(true);
    expect(taskRepo.createTask).toHaveBeenCalledTimes(2);
    expect(taskRepo.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        parentTaskId: PARENT_ID,
        waitingOnContactId: 'contact-1',
        resumable: false,
      }),
    );
    expect(taskRepo.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'social-media',
        resumable: true,
      }),
    );
    expect(taskRepo.updateTask).toHaveBeenCalledWith(
      CHILD_AUDIT,
      expect.objectContaining({ blockedByTaskId: CHILD_GATHER }),
      'coordinator',
    );
  });

  it('keeps lazy steps unmaterialized', async () => {
    const taskRepo = {
      getTask: vi.fn().mockResolvedValue(makeTaskRow()),
      createTask: vi.fn().mockResolvedValue(makeTaskRow({ id: CHILD_GATHER })),
      updateTask: vi.fn(),
      setPlanBlock: vi.fn().mockResolvedValue({
        task: makeTaskRow(),
        block: { done: 0, total: 2 },
      }),
    } as unknown as TaskRepo;

    const handler = new PlanHandler();
    const result = await handler.execute(makeCtx({
      taskRepo,
      agentRegistry: { has: () => true } as unknown as SkillContext['agentRegistry'],
      input: {
        task_id: PARENT_ID,
        steps: [
          { id: 'now', title: 'First step', target_agent_id: 'coordinator' },
          { id: 'later', title: 'Later step', target_agent_id: 'coordinator', materialize: false },
        ],
        deliverable_step_id: null,
        next: 'Complete first step',
      },
    }));

    expect(result.success).toBe(true);
    expect(taskRepo.createTask).toHaveBeenCalledTimes(1);
    if (result.success) {
      const data = result.data as {
        lazy_steps: number;
        steps: Array<{ id: string; task_id: string | null }>;
      };
      expect(data.lazy_steps).toBe(1);
      expect(data.steps).toEqual([
        { id: 'now', task_id: CHILD_GATHER },
        { id: 'later', task_id: null },
      ]);
    }
  });

  it('reuses existing children on adaptive re-plan when fields match', async () => {
    const existingChild = makeTaskRow({
      id: CHILD_GATHER,
      parentTaskId: PARENT_ID,
      title: 'Gather exec input',
    });
    const taskRepo = {
      getTask: vi.fn(async (id: string) => {
        if (id === PARENT_ID) {
          return makeTaskRow({
            progress: {
              plan: {
                steps: [{ id: 'gather', taskId: CHILD_GATHER }],
                deliverableStepId: null,
                done: 0,
                total: 1,
                next: 'Run',
              },
            },
          });
        }
        if (id === CHILD_GATHER) return existingChild;
        if (id === CHILD_SYNTH) {
          return makeTaskRow({ id: CHILD_SYNTH, parentTaskId: PARENT_ID, status: 'open' });
        }
        return null;
      }),
      createTask: vi.fn().mockResolvedValue(makeTaskRow({ id: CHILD_SYNTH, parentTaskId: PARENT_ID })),
      updateTask: vi.fn().mockResolvedValue(existingChild),
      setPlanBlock: vi.fn().mockResolvedValue({
        task: makeTaskRow(),
        block: { done: 0, total: 2 },
      }),
    } as unknown as TaskRepo;

    const handler = new PlanHandler();
    const result = await handler.execute(makeCtx({
      taskRepo,
      agentRegistry: { has: () => true } as unknown as SkillContext['agentRegistry'],
      input: {
        task_id: PARENT_ID,
        steps: [
          { id: 'gather', title: 'Gather exec input', target_agent_id: 'coordinator' },
          { id: 'synthesis', title: 'Synthesize', target_agent_id: 'coordinator', blocked_by_step_id: 'gather' },
        ],
        deliverable_step_id: 'synthesis',
        next: 'Finish gather then synthesize',
      },
    }));

    expect(result.success).toBe(true);
    expect(taskRepo.createTask).toHaveBeenCalledTimes(1);
    expect(taskRepo.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Synthesize' }),
    );
    if (result.success) {
      const data = result.data as { steps: Array<{ id: string; task_id: string | null }> };
      expect(data.steps[0]).toEqual({ id: 'gather', task_id: CHILD_GATHER });
    }
  });

  it('recreates reused children when step fields drift', async () => {
    const existingChild = makeTaskRow({
      id: CHILD_GATHER,
      parentTaskId: PARENT_ID,
      title: 'Gather exec input',
      status: 'open',
    });
    const replacementChild = makeTaskRow({
      id: '00000000-0000-0000-0000-000000000099',
      parentTaskId: PARENT_ID,
      title: 'Gather exec input (updated)',
    });
    const taskRepo = {
      getTask: vi.fn(async (id: string) => {
        if (id === PARENT_ID) {
          return makeTaskRow({
            progress: {
              plan: {
                steps: [{ id: 'gather', taskId: CHILD_GATHER }],
                deliverableStepId: null,
                done: 0,
                total: 1,
                next: 'Run',
              },
            },
          });
        }
        if (id === CHILD_GATHER) return existingChild;
        if (id === replacementChild.id) return replacementChild;
        return null;
      }),
      createTask: vi.fn().mockResolvedValue(replacementChild),
      updateTask: vi.fn().mockResolvedValue(existingChild),
      setPlanBlock: vi.fn().mockResolvedValue({
        task: makeTaskRow(),
        block: { done: 0, total: 1 },
      }),
    } as unknown as TaskRepo;

    const handler = new PlanHandler();
    const result = await handler.execute(makeCtx({
      taskRepo,
      agentRegistry: { has: () => true } as unknown as SkillContext['agentRegistry'],
      input: {
        task_id: PARENT_ID,
        steps: [
          { id: 'gather', title: 'Gather exec input (updated)', target_agent_id: 'coordinator' },
        ],
        deliverable_step_id: null,
        next: 'Run updated gather',
      },
    }));

    expect(result.success).toBe(true);
    expect(taskRepo.updateTask).toHaveBeenCalledWith(
      CHILD_GATHER,
      expect.objectContaining({ status: 'cancelled' }),
      'coordinator',
    );
    expect(taskRepo.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Gather exec input (updated)' }),
    );
  });

  it('cancels children removed from the plan', async () => {
    const gatherChild = makeTaskRow({
      id: CHILD_GATHER,
      parentTaskId: PARENT_ID,
      title: 'Gather',
      status: 'done',
    });
    const removedChild = makeTaskRow({
      id: CHILD_SYNTH,
      parentTaskId: PARENT_ID,
      status: 'open',
    });
    const taskRepo = {
      getTask: vi.fn(async (id: string) => {
        if (id === PARENT_ID) {
          return makeTaskRow({
            progress: {
              plan: {
                steps: [
                  { id: 'gather', taskId: CHILD_GATHER },
                  { id: 'synthesis', taskId: CHILD_SYNTH },
                ],
                deliverableStepId: 'synthesis',
                done: 0,
                total: 2,
                next: 'Run',
              },
            },
          });
        }
        if (id === CHILD_GATHER) return gatherChild;
        if (id === CHILD_SYNTH) return removedChild;
        return null;
      }),
      createTask: vi.fn(),
      updateTask: vi.fn().mockResolvedValue(removedChild),
      setPlanBlock: vi.fn().mockResolvedValue({
        task: makeTaskRow(),
        block: { done: 1, total: 1 },
      }),
    } as unknown as TaskRepo;

    const handler = new PlanHandler();
    await handler.execute(makeCtx({
      taskRepo,
      agentRegistry: { has: () => true } as unknown as SkillContext['agentRegistry'],
      input: {
        task_id: PARENT_ID,
        steps: [
          { id: 'gather', title: 'Gather', target_agent_id: 'coordinator' },
        ],
        deliverable_step_id: null,
        next: 'Only gather remains',
      },
    }));

    expect(taskRepo.updateTask).toHaveBeenCalledWith(
      CHILD_SYNTH,
      expect.objectContaining({ status: 'cancelled' }),
      'coordinator',
    );
  });

  it('inherits originator from the persisted parent row', async () => {
    const originator = {
      contactId: 'contact-principal',
      systemRole: 'principal' as const,
      channel: 'email',
      initiatedAt: '2026-06-29T00:00:00.000Z',
      tierAtInitiation: null,
    };
    const taskRepo = {
      getTask: vi.fn().mockResolvedValue(makeTaskRow({ originator })),
      createTask: vi.fn().mockResolvedValue(makeTaskRow({ id: CHILD_GATHER })),
      updateTask: vi.fn(),
      setPlanBlock: vi.fn().mockResolvedValue({
        task: makeTaskRow(),
        block: { done: 0, total: 1 },
      }),
    } as unknown as TaskRepo;

    const handler = new PlanHandler();
    await handler.execute(makeCtx({
      taskRepo,
      taskMetadata: { originator: null },
      input: {
        task_id: PARENT_ID,
        steps: [{ id: 'gather', title: 'Gather', target_agent_id: 'coordinator' }],
        deliverable_step_id: null,
        next: 'Run gather',
      },
    }));

    expect(taskRepo.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ originator }),
    );
  });

  it('rejects cyclic dependency graphs', async () => {
    const taskRepo = {
      getTask: vi.fn().mockResolvedValue(makeTaskRow()),
      createTask: vi.fn(),
      updateTask: vi.fn(),
      setPlanBlock: vi.fn(),
    } as unknown as TaskRepo;

    const handler = new PlanHandler();
    const result = await handler.execute(makeCtx({
      taskRepo,
      agentRegistry: { has: () => true } as unknown as SkillContext['agentRegistry'],
      input: {
        task_id: PARENT_ID,
        steps: [
          { id: 'a', title: 'A', target_agent_id: 'coordinator', blocked_by_step_id: 'b' },
          { id: 'b', title: 'B', target_agent_id: 'coordinator', blocked_by_step_id: 'a' },
        ],
        deliverable_step_id: null,
        next: 'Cannot run',
      },
    }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/cycle/);
    }
    expect(taskRepo.createTask).not.toHaveBeenCalled();
  });

  it('clears blockedByTaskId when dependency is removed on re-plan', async () => {
    const gatherChild = makeTaskRow({
      id: CHILD_GATHER,
      parentTaskId: PARENT_ID,
      title: 'Gather',
    });
    const dependentChild = makeTaskRow({
      id: CHILD_AUDIT,
      parentTaskId: PARENT_ID,
      title: 'Audit',
      agentId: 'coordinator',
      blockedByTaskId: CHILD_GATHER,
    });
    const taskRepo = {
      getTask: vi.fn(async (id: string) => {
        if (id === PARENT_ID) {
          return makeTaskRow({
            progress: {
              plan: {
                steps: [
                  { id: 'gather', taskId: CHILD_GATHER },
                  { id: 'audit', taskId: CHILD_AUDIT },
                ],
                deliverableStepId: null,
                done: 0,
                total: 2,
                next: 'Run',
              },
            },
          });
        }
        if (id === CHILD_GATHER) return gatherChild;
        if (id === CHILD_AUDIT) return dependentChild;
        return null;
      }),
      createTask: vi.fn(),
      updateTask: vi.fn().mockResolvedValue(dependentChild),
      setPlanBlock: vi.fn().mockResolvedValue({
        task: makeTaskRow(),
        block: { done: 0, total: 2 },
      }),
    } as unknown as TaskRepo;

    const handler = new PlanHandler();
    await handler.execute(makeCtx({
      taskRepo,
      agentRegistry: { has: () => true } as unknown as SkillContext['agentRegistry'],
      input: {
        task_id: PARENT_ID,
        steps: [
          { id: 'gather', title: 'Gather', target_agent_id: 'coordinator' },
          { id: 'audit', title: 'Audit', target_agent_id: 'coordinator' },
        ],
        deliverable_step_id: null,
        next: 'Run audit without blocker',
      },
    }));

    expect(taskRepo.updateTask).toHaveBeenCalledWith(
      CHILD_AUDIT,
      { blockedByTaskId: null },
      'coordinator',
    );
  });

  it('rolls back newly created children when setPlanBlock fails', async () => {
    const createdChild = makeTaskRow({ id: CHILD_GATHER, parentTaskId: PARENT_ID, status: 'open' });
    const taskRepo = {
      getTask: vi.fn(async (id: string) => {
        if (id === PARENT_ID) return makeTaskRow();
        if (id === CHILD_GATHER) return createdChild;
        return null;
      }),
      createTask: vi.fn().mockResolvedValue(createdChild),
      updateTask: vi.fn().mockResolvedValue(createdChild),
      setPlanBlock: vi.fn().mockResolvedValue({
        ok: false,
        code: 'block_overflow',
        bytes: 9000,
        maxBytes: 8192,
      }),
    } as unknown as TaskRepo;

    const handler = new PlanHandler();
    const result = await handler.execute(makeCtx({
      taskRepo,
      agentRegistry: { has: () => true } as unknown as SkillContext['agentRegistry'],
      input: {
        task_id: PARENT_ID,
        steps: [{ id: 'gather', title: 'Gather', target_agent_id: 'coordinator' }],
        deliverable_step_id: null,
        next: 'Run gather',
      },
    }));

    expect(result.success).toBe(false);
    expect(taskRepo.updateTask).toHaveBeenCalledWith(
      CHILD_GATHER,
      expect.objectContaining({
        status: 'cancelled',
        progressNote: expect.stringContaining('rolling back'),
      }),
      'coordinator',
    );
  });
});
