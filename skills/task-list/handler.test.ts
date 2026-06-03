import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { TaskListHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { TaskRepo, TaskListRow } from '../../src/db/task-repo.js';

const silentLog = pino({ level: 'silent' });

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

function makeListRow(overrides: Partial<TaskListRow> = {}): TaskListRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    agentId: 'coordinator',
    intentAnchor: 'Write Q3 report',
    title: 'Write Q3 report',
    description: null,
    status: 'open',
    progress: { notes: [{ at: '2026-06-01T10:00:00.000Z', note: 'Started outline' }] },
    errorBudget: {},
    conversationId: null,
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:00:00.000Z',
    owner: 'curia',
    waitingOnContactId: null,
    waitingOnText: null,
    parentTaskId: null,
    blockedByTaskId: null,
    priority: 60,
    dueAt: null,
    source: 'coordinator',
    sourceAgentId: 'coordinator',
    createdBy: 'coordinator',
    tags: ['board-prep'],
    nextWakeAt: null,
    ...overrides,
  };
}

function makeTaskRepo(overrides: Partial<TaskRepo> = {}): TaskRepo {
  return {
    createTask: vi.fn(),
    getTask: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    updateTask: vi.fn(),
    completeTask: vi.fn(),
    cancelWakeUpJobs: vi.fn(),
    ...overrides,
  } as unknown as TaskRepo;
}

describe('TaskListHandler', () => {
  // ── Input validation ──────────────────────────────────────────────────────

  it('returns error for invalid status value', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: { status: 'pending' }, taskRepo });

    const result = await new TaskListHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/status/);
  });

  it('returns error for invalid owner', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: { owner: 'robot' }, taskRepo });

    const result = await new TaskListHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/owner/);
  });

  it('returns error when taskRepo is not injected', async () => {
    const ctx = makeCtx({ input: {} });

    const result = await new TaskListHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/taskRepo/);
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it('returns empty tasks list when no tasks match', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: {}, taskRepo });

    const result = await new TaskListHandler().execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { tasks: unknown[]; count: number } }).data;
    expect(data.tasks).toHaveLength(0);
    expect(data.count).toBe(0);
  });

  it('returns tasks with required fields', async () => {
    const taskRepo = makeTaskRepo({
      listTasks: vi.fn().mockResolvedValue([makeListRow()]),
    });
    const ctx = makeCtx({ input: {}, taskRepo });

    const result = await new TaskListHandler().execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { tasks: Array<{ task_id: string; title: string; last_progress_note: string | null }> } }).data;
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0]!.task_id).toBe('00000000-0000-0000-0000-000000000001');
    expect(data.tasks[0]!.title).toBe('Write Q3 report');
    // Last progress note from progress.notes
    expect(data.tasks[0]!.last_progress_note).toBe('Started outline');
  });

  it('passes comma-separated statuses as array to TaskRepo.listTasks', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: { status: 'open,in_progress' }, taskRepo });

    await new TaskListHandler().execute(ctx);

    const calls = (taskRepo.listTasks as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0].statuses).toEqual(['open', 'in_progress']);
  });

  it('caps limit at 100', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: { limit: 500 }, taskRepo });

    await new TaskListHandler().execute(ctx);

    const calls = (taskRepo.listTasks as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0].limit).toBe(100);
  });

  it('defaults limit to 25', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: {}, taskRepo });

    await new TaskListHandler().execute(ctx);

    const calls = (taskRepo.listTasks as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0].limit).toBe(25);
  });

  it('includes next_wake_at when scheduled', async () => {
    const taskRepo = makeTaskRepo({
      listTasks: vi.fn().mockResolvedValue([
        makeListRow({ nextWakeAt: '2026-06-10T09:00:00.000Z' }),
      ]),
    });
    const ctx = makeCtx({ input: {}, taskRepo });

    const result = await new TaskListHandler().execute(ctx);

    const data = (result as { success: true; data: { tasks: Array<{ next_wake_at: string | null }> } }).data;
    expect(data.tasks[0]!.next_wake_at).not.toBeNull();
  });

  it('returns displayTimezone in the result', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: {}, taskRepo });

    const result = await new TaskListHandler().execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { displayTimezone: string } }).data;
    expect(typeof data.displayTimezone).toBe('string');
  });
});
