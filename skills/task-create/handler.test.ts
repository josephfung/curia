import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { TaskCreateHandler } from './handler.js';
import type { SkillContext } from '../../src/skills/types.js';
import type { TaskRepo } from '../../src/db/task-repo.js';
import type { TaskRow } from '../../src/db/queries/tasks.js';
import type { AgentRegistry } from '../../src/agents/agent-registry.js';

const silentLog = pino({ level: 'silent' });

// Minimal AgentRegistry stub — task-create only calls has() to validate a
// cross-agent target exists before redirecting the wake to it.
function makeRegistry(knownAgents: string[] = []): AgentRegistry {
  return {
    has: vi.fn((name: string) => knownAgents.includes(name)),
  } as unknown as AgentRegistry;
}

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
    id: '00000000-0000-0000-0000-000000000001',
    agentId: 'coordinator',
    intentAnchor: 'Book dentist appointment',
    title: 'Book dentist appointment',
    description: null,
    status: 'open',
    progress: { notes: [] },
    errorBudget: {},
    conversationId: null,
    createdAt: '2026-06-03T10:00:00.000Z',
    updatedAt: '2026-06-03T10:00:00.000Z',
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
    createTask: vi.fn().mockResolvedValue(makeTaskRow()),
    getTask: vi.fn(),
    listTasks: vi.fn(),
    updateTask: vi.fn(),
    completeTask: vi.fn(),
    cancelWakeUpJobs: vi.fn(),
    ...overrides,
  } as unknown as TaskRepo;
}

describe('TaskCreateHandler', () => {
  // ── Input validation ──────────────────────────────────────────────────────

  it('returns error when title is missing', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: {}, taskRepo });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/title/);
  });

  it('returns error when title is blank', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: { title: '   ' }, taskRepo });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/title/);
  });

  it('returns error when title exceeds 500 characters', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: { title: 'x'.repeat(501) }, taskRepo });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/500/);
  });

  it('returns error for invalid owner', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: { title: 'Do a thing', owner: 'robot' }, taskRepo });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/owner/);
  });

  it('returns error for non-ISO due_at (permissive date strings)', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: { title: 'Task', due_at: '2026/06/10 09:00:00' }, taskRepo });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/due_at/);
  });

  it('accepts and formats due_at with millisecond precision from DB', async () => {
    const taskRepo = makeTaskRepo({
      createTask: vi.fn().mockResolvedValue(
        makeTaskRow({ dueAt: '2026-06-10T09:00:00.123Z' }),
      ),
    });
    const ctx = makeCtx({
      input: { title: 'Task', due_at: '2026-06-10T09:00:00.000Z' },
      taskRepo,
    });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { due_at: string | null } }).data;
    expect(data.due_at).not.toBeNull();
  });

  it('returns error for priority out of range', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: { title: 'Do a thing', priority: 150 }, taskRepo });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/priority/);
  });

  it('returns error when taskRepo is not injected', async () => {
    const ctx = makeCtx({ input: { title: 'Do a thing' } });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/taskRepo/);
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it('creates a task and returns the task_id', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({
      input: { title: 'Book dentist appointment', owner: 'ceo', priority: 70 },
      taskRepo,
    });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { task_id: string; status: string } }).data;
    expect(data.task_id).toBe('00000000-0000-0000-0000-000000000001');
    expect(data.status).toBe('open');
  });

  it('passes title, owner, and priority to TaskRepo.createTask', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({
      input: { title: 'Prepare board deck', owner: 'ceo', priority: 80, tags: ['board-prep'] },
      taskRepo,
      agentId: 'ceo-inbox',
    });

    await new TaskCreateHandler().execute(ctx);

    const calls = (taskRepo.createTask as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0]).toMatchObject({
      title: 'Prepare board deck',
      owner: 'ceo',
      priority: 80,
      tags: ['board-prep'],
      agentId: 'ceo-inbox',
      source: 'agent',
    });
  });

  it('derives source=coordinator when agentId is coordinator', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({
      input: { title: 'Follow up with Alex' },
      taskRepo,
      agentId: 'coordinator',
    });

    await new TaskCreateHandler().execute(ctx);

    const calls = (taskRepo.createTask as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0].source).toBe('coordinator');
  });

  it('passes wake_at as a Date to TaskRepo.createTask', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({
      input: { title: 'Call Steve', wake_at: '2026-06-10T09:00:00.000Z' },
      taskRepo,
    });

    await new TaskCreateHandler().execute(ctx);

    const calls = (taskRepo.createTask as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0].wakeAt).toBeInstanceOf(Date);
    expect((calls[0]![0].wakeAt as Date).toISOString()).toBe('2026-06-10T09:00:00.000Z');
  });

  it('returns displayTimezone in the result', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({ input: { title: 'Task with timezone' }, taskRepo });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(true);
    const data = (result as { success: true; data: { displayTimezone: string } }).data;
    expect(typeof data.displayTimezone).toBe('string');
    expect(data.displayTimezone).not.toBe('');
  });

  // ── Cross-agent targeting (target_agent_id) ───────────────────────────────

  it('self-routes ownership to the calling agent when target_agent_id is omitted', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({
      input: { title: 'Self-owned task' },
      taskRepo,
      agentId: 'meeting-debrief',
    });

    await new TaskCreateHandler().execute(ctx);

    const calls = (taskRepo.createTask as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0]).toMatchObject({
      agentId: 'meeting-debrief',
      sourceAgentId: 'meeting-debrief',
      createdBy: 'meeting-debrief',
    });
  });

  it('routes ownership and the wake to a valid cross-agent target', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({
      input: {
        title: 'Debrief: Acme sync',
        target_agent_id: 'meeting-debrief',
        wake_at: '2026-06-10T17:00:00.000Z',
      },
      taskRepo,
      agentId: 'coordinator',
      agentRegistry: makeRegistry(['coordinator', 'meeting-debrief', 'ceo-inbox']),
    });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(true);
    const calls = (taskRepo.createTask as ReturnType<typeof vi.fn>).mock.calls;
    // The target owns the task (agent_id + source_agent_id) so re-wakes scheduled
    // by the target via task-update route back to it; created_by records the
    // actual creator for audit.
    expect(calls[0]![0]).toMatchObject({
      agentId: 'meeting-debrief',
      sourceAgentId: 'meeting-debrief',
      createdBy: 'coordinator',
    });
  });

  it('treats target_agent_id equal to the caller as self-routing (no registry needed)', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({
      input: { title: 'Self target', target_agent_id: 'meeting-debrief' },
      taskRepo,
      agentId: 'meeting-debrief',
      // No agentRegistry provided — self-targeting must not require it.
    });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(true);
    const calls = (taskRepo.createTask as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0]).toMatchObject({
      agentId: 'meeting-debrief',
      sourceAgentId: 'meeting-debrief',
      createdBy: 'meeting-debrief',
    });
  });

  it('rejects a target_agent_id that is not a registered agent', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({
      input: { title: 'Bad target', target_agent_id: 'ghost-agent' },
      taskRepo,
      agentId: 'coordinator',
      agentRegistry: makeRegistry(['coordinator', 'meeting-debrief']),
    });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/target_agent_id/);
    expect(taskRepo.createTask).not.toHaveBeenCalled();
  });

  it('rejects a non-string target_agent_id', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({
      input: { title: 'Task', target_agent_id: 123 as unknown as string },
      taskRepo,
      agentId: 'coordinator',
      agentRegistry: makeRegistry(['coordinator']),
    });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/target_agent_id/);
    expect(taskRepo.createTask).not.toHaveBeenCalled();
  });

  it('errors when target_agent_id is set but the agent registry is unavailable', async () => {
    const taskRepo = makeTaskRepo();
    const ctx = makeCtx({
      input: { title: 'Task', target_agent_id: 'meeting-debrief' },
      taskRepo,
      agentId: 'coordinator',
      // agentRegistry intentionally omitted.
    });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/agentRegistry|registry/);
    expect(taskRepo.createTask).not.toHaveBeenCalled();
  });

  // ── Error propagation ─────────────────────────────────────────────────────

  it('returns error when TaskRepo.createTask throws', async () => {
    const taskRepo = makeTaskRepo({
      createTask: vi.fn().mockRejectedValue(new Error('DB connection lost')),
    });
    const ctx = makeCtx({ input: { title: 'Failing task' }, taskRepo });

    const result = await new TaskCreateHandler().execute(ctx);

    expect(result.success).toBe(false);
    expect((result as { success: false; error: string }).error).toMatch(/DB connection lost/);
  });
});
