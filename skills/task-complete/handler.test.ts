import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { TaskCompleteHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { TaskRepo } from '../../src/db/task-repo.js';
import type { TaskRow } from '../../src/db/queries/tasks.js';

const silentLog = pino({ level: 'silent' });
const VALID_UUID = '00000000-0000-0000-0000-000000000002';

function makeCtx(overrides: Partial<SkillContext> = {}): SkillContext {
  return {
    input: {},
    secret: () => 'unused',
    log: silentLog,
    agentId: 'coordinator',
    timezone: 'America/Toronto',
    ...overrides,
  } as unknown as SkillContext;
}

function makeTaskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: VALID_UUID,
    agentId: 'coordinator',
    intentAnchor: 'Call accountant',
    title: 'Call accountant',
    description: null,
    status: 'done',
    progress: { notes: [{ at: '2026-06-03T15:00:00.000Z', note: 'Called — filed extension' }] },
    errorBudget: {},
    conversationId: null,
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-03T15:00:00.000Z',
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
    ...overrides,
  };
}

function makeTaskRepo(overrides: Partial<TaskRepo> = {}): TaskRepo {
  return {
    createTask: vi.fn(),
    getTask: vi.fn(),
    listTasks: vi.fn(),
    updateTask: vi.fn(),
    completeTask: vi.fn().mockResolvedValue(makeTaskRow()),
    cancelWakeUpJobs: vi.fn(),
    ...overrides,
  } as unknown as TaskRepo;
}

describe('TaskCompleteHandler', () => {
  // ── Input validation ──────────────────────────────────────────────────────

  it('returns error when task_id is missing', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: {}, taskRepo });

    const result = await new TaskCompleteHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/task_id/);
  });

  it('returns error when task_id is not a valid UUID', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: { task_id: 'not-a-uuid' }, taskRepo });

    const result = await new TaskCompleteHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/UUID/);
  });

  it('returns error when taskRepo is not injected', async () => {
    const ctx = makeCtx({ input: { task_id: VALID_UUID } });

    const result = await new TaskCompleteHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/taskRepo/);
  });

  // ── Status transition guards ──────────────────────────────────────────────

  it('propagates already-terminal error when trying to complete a done task', async () => {
    const taskRepo = makeTaskRepo({
      completeTask: vi.fn().mockRejectedValue(
        new Error("Cannot complete task — it is already in terminal state 'done'."),
      ),
    });
    const ctx = makeCtx({ input: { task_id: VALID_UUID }, taskRepo });

    const result = await new TaskCompleteHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/terminal state/);
  });

  it('propagates error when trying to complete a cancelled task', async () => {
    const taskRepo = makeTaskRepo({
      completeTask: vi.fn().mockRejectedValue(
        new Error("Cannot complete task — it is already in terminal state 'cancelled'."),
      ),
    });
    const ctx = makeCtx({ input: { task_id: VALID_UUID }, taskRepo });

    const result = await new TaskCompleteHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/terminal state/);
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it('completes a task and returns status=done', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: { task_id: VALID_UUID }, taskRepo });

    const result = await new TaskCompleteHandler().execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { status: string; task_id: string } }).data;
    expect(data.status).toBe('done');
    expect(data.task_id).toBe(VALID_UUID);
  });

  it('passes completion_note to TaskRepo.completeTask', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({
      input: { task_id: VALID_UUID, completion_note: 'Filed extension with accountant' },
      taskRepo,
    });

    await new TaskCompleteHandler().execute(ctx);

    const calls = (taskRepo.completeTask as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![1]).toBe('Filed extension with accountant');
  });

  it('returns task-not-found error when TaskRepo returns null', async () => {
    const taskRepo = makeTaskRepo({ completeTask: vi.fn().mockResolvedValue(null) });
    const ctx = makeCtx({ input: { task_id: VALID_UUID }, taskRepo });

    const result = await new TaskCompleteHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/not found/);
  });

  it('returns displayTimezone in the result', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: { task_id: VALID_UUID }, taskRepo });

    const result = await new TaskCompleteHandler().execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { displayTimezone: string } }).data;
    expect(typeof data.displayTimezone).toBe('string');
  });
});
