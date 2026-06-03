import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { TaskUpdateHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { TaskRepo } from '../../src/db/task-repo.js';
import type { TaskRow } from '../../src/db/queries/tasks.js';

const silentLog = pino({ level: 'silent' });
const VALID_UUID = '00000000-0000-0000-0000-000000000001';

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
    intentAnchor: 'Prepare report',
    title: 'Prepare report',
    description: null,
    status: 'open',
    progress: { notes: [] },
    errorBudget: {},
    conversationId: null,
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-03T12:00:00.000Z',
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
    updateTask: vi.fn().mockResolvedValue(makeTaskRow()),
    completeTask: vi.fn(),
    cancelWakeUpJobs: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as TaskRepo;
}

describe('TaskUpdateHandler', () => {
  // ── Input validation ──────────────────────────────────────────────────────

  it('returns error when task_id is missing', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: { status: 'in_progress' }, taskRepo });

    const result = await new TaskUpdateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/task_id/);
  });

  it('returns error when task_id is not a valid UUID', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: { task_id: 'not-a-uuid', status: 'in_progress' }, taskRepo });

    const result = await new TaskUpdateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/UUID/);
  });

  it('returns error for invalid status', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: { task_id: VALID_UUID, status: 'active' }, taskRepo });

    const result = await new TaskUpdateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/status/);
  });

  it('returns error when no fields are provided', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: { task_id: VALID_UUID }, taskRepo });

    const result = await new TaskUpdateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/at least one/i);
  });

  it('returns error when taskRepo is not injected', async () => {
    const ctx = makeCtx({ input: { task_id: VALID_UUID, status: 'in_progress' } });

    const result = await new TaskUpdateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/taskRepo/);
  });

  // ── Status transition guards ──────────────────────────────────────────────

  it('propagates terminal-state error from TaskRepo.updateTask', async () => {
    // TaskRepo.updateTask throws when trying to transition from a terminal state.
    const taskRepo = makeTaskRepo({
      updateTask: vi.fn().mockRejectedValue(
        new Error("Cannot transition task from 'done' — it is a terminal state."),
      ),
    });
    const ctx = makeCtx({
      input: { task_id: VALID_UUID, status: 'open' },
      taskRepo,
    });

    const result = await new TaskUpdateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/terminal state/);
  });

  it('propagates terminal-state error for cancelled → in_progress', async () => {
    const taskRepo = makeTaskRepo({
      updateTask: vi.fn().mockRejectedValue(
        new Error("Cannot transition task from 'cancelled' — it is a terminal state."),
      ),
    });
    const ctx = makeCtx({
      input: { task_id: VALID_UUID, status: 'in_progress' },
      taskRepo,
    });

    const result = await new TaskUpdateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/terminal state/);
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it('updates status and returns updated task fields', async () => {
    const taskRepo = makeTaskRepo({
      updateTask: vi.fn().mockResolvedValue(makeTaskRow({ status: 'in_progress' })),
    });
    const ctx = makeCtx({ input: { task_id: VALID_UUID, status: 'in_progress' }, taskRepo });

    const result = await new TaskUpdateHandler().execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { status: string; task_id: string } }).data;
    expect(data.status).toBe('in_progress');
    expect(data.task_id).toBe(VALID_UUID);
  });

  it('cancels wake-up jobs when status is set to cancelled', async () => {
    const taskRepo = makeTaskRepo({
      updateTask: vi.fn().mockResolvedValue(makeTaskRow({ status: 'cancelled' })),
    });
    const ctx = makeCtx({ input: { task_id: VALID_UUID, status: 'cancelled' }, taskRepo });

    await new TaskUpdateHandler().execute(ctx);

    expect((taskRepo.cancelWakeUpJobs as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((taskRepo.cancelWakeUpJobs as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(VALID_UUID);
  });

  it('does not call cancelWakeUpJobs for non-cancelled status updates', async () => {
    const taskRepo = makeTaskRepo({
      updateTask: vi.fn().mockResolvedValue(makeTaskRow({ status: 'in_progress' })),
    });
    const ctx = makeCtx({ input: { task_id: VALID_UUID, status: 'in_progress' }, taskRepo });

    await new TaskUpdateHandler().execute(ctx);

    expect((taskRepo.cancelWakeUpJobs as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('passes wake_at as a Date to TaskRepo.updateTask', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({
      input: { task_id: VALID_UUID, wake_at: '2026-06-15T14:00:00.000Z' },
      taskRepo,
    });

    await new TaskUpdateHandler().execute(ctx);

    const calls = (taskRepo.updateTask as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![1].wakeAt).toBeInstanceOf(Date);
  });

  it('returns task-not-found error when TaskRepo returns null', async () => {
    const taskRepo = makeTaskRepo({ updateTask: vi.fn().mockResolvedValue(null) });
    const ctx = makeCtx({ input: { task_id: VALID_UUID, status: 'in_progress' }, taskRepo });

    const result = await new TaskUpdateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/not found/);
  });
});
