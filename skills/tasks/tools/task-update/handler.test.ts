import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { TaskUpdateHandler } from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import type { TaskRepo } from '../../../../src/db/task-repo.js';
import type { TaskRow } from '../../../../src/db/queries/tasks.js';

const silentLog = pino({ level: 'silent' });
const VALID_UUID = '00000000-0000-0000-0000-000000000001';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    input: {},
    secret: () => 'unused',
    log: silentLog,
    agentId: 'coordinator',
    timezone: 'America/Toronto',
    ...overrides,
  } as unknown as ToolContext;
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
    originator: null,
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

  it('passes status=cancelled to TaskRepo.updateTask (atomically cancels wake-ups in repo)', async () => {
    // Wake-up job cancellation is now handled atomically inside TaskRepo.updateTask.
    // The handler simply passes the status; no separate cancelWakeUpJobs call.
    const taskRepo = makeTaskRepo({
      updateTask: vi.fn().mockResolvedValue(makeTaskRow({ status: 'cancelled' })),
    });
    const ctx = makeCtx({ input: { task_id: VALID_UUID, status: 'cancelled' }, taskRepo });

    const result = await new TaskUpdateHandler().execute(ctx);

    expect(result.success).toBe(true);
    const calls = (taskRepo.updateTask as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![1].status).toBe('cancelled');
    // cancelWakeUpJobs is NOT called from the handler — repo handles it
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

  // #2084: on 2026-10-07 a 2,073-char note made the whole call fail, the retry
  // dropped wake_at, and a self-re-arming loop lost its next tick.
  describe('over-long progress_note (#2084)', () => {
    const longNote = 'x'.repeat(2073);

    it('still applies wake_at and status when the note is over the limit', async () => {
      const taskRepo = makeTaskRepo();
      const ctx = makeCtx({
        input: {
          task_id: VALID_UUID,
          status: 'waiting',
          wake_at: '2026-10-08T01:34:00-04:00',
          progress_note: longNote,
        },
        taskRepo,
      });

      const result = await new TaskUpdateHandler().execute(ctx);

      expect(result.success).toBe(true);
      const fields = (taskRepo.updateTask as ReturnType<typeof vi.fn>).mock.calls[0]![1];
      expect(fields.wakeAt).toEqual(new Date('2026-10-08T05:34:00Z'));
      expect(fields.status).toBe('waiting');
    });

    it('saves the note truncated to the limit, with a visible marker', async () => {
      const taskRepo = makeTaskRepo();
      const ctx = makeCtx({
        input: { task_id: VALID_UUID, wake_at: '2026-10-08T01:34:00-04:00', progress_note: longNote },
        taskRepo,
      });

      await new TaskUpdateHandler().execute(ctx);

      const note = (taskRepo.updateTask as ReturnType<typeof vi.fn>).mock.calls[0]![1].progressNote as string;
      expect(note.length).toBeLessThanOrEqual(2000);
      expect(note.startsWith('x'.repeat(1900))).toBe(true);
      expect(note).toMatch(/\[truncated: \d+ characters cut\]$/);
    });

    it('tells the agent the note was cut and the rest of the call was applied', async () => {
      const ctx = makeCtx({
        input: { task_id: VALID_UUID, wake_at: '2026-10-08T01:34:00-04:00', progress_note: longNote },
        taskRepo: makeTaskRepo(),
      });

      const result = await new TaskUpdateHandler().execute(ctx);

      const data = (result as { success: true; data: { warning?: string } }).data;
      expect(data.warning).toMatch(/2073 characters/);
      expect(data.warning).toMatch(/truncated/);
      expect(data.warning).toMatch(/other fields.*applied/i);
    });

    it('leaves a note at the limit untouched and adds no warning', async () => {
      const taskRepo = makeTaskRepo();
      const exact = 'y'.repeat(2000);
      const ctx = makeCtx({ input: { task_id: VALID_UUID, progress_note: exact }, taskRepo });

      const result = await new TaskUpdateHandler().execute(ctx);

      expect((taskRepo.updateTask as ReturnType<typeof vi.fn>).mock.calls[0]![1].progressNote).toBe(exact);
      expect((result as { success: true; data: { warning?: string } }).data.warning).toBeUndefined();
    });
  });

  it('returns task-not-found error when TaskRepo returns null', async () => {
    const taskRepo = makeTaskRepo({ updateTask: vi.fn().mockResolvedValue(null) });
    const ctx = makeCtx({ input: { task_id: VALID_UUID, status: 'in_progress' }, taskRepo });

    const result = await new TaskUpdateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/not found/);
  });
});
