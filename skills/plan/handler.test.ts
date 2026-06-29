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
  return {
    input: {},
    secret: () => 'unused',
    log: silentLog,
    agentId: 'coordinator',
    ...overrides,
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

  it('reuses existing children on adaptive re-plan without duplicating', async () => {
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
          { id: 'gather', title: 'Gather exec input (updated)', target_agent_id: 'coordinator' },
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

  it('cancels children removed from the plan', async () => {
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
        if (id === CHILD_GATHER) return makeTaskRow({ id: CHILD_GATHER, parentTaskId: PARENT_ID, status: 'done' });
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
});
