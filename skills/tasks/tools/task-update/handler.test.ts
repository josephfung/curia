import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { DECLINE_HANDOFF_ERROR, TaskUpdateHandler } from './handler.js';
import { BLOCKED_BY_TASK_ID_ERROR, SELF_BLOCK_ERROR } from '../../optional-ref.js';
import { dedupPairTag } from '../../../../src/contacts/dedup-pair-key.js';
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

  // #2328: JSON null clears. A string placeholder is an error, even beside a
  // status change — a success that left the blocker set would look like a clear.
  // Omitting the field must not clear: the repo writes the column whenever the key is present.
  describe('blocked_by_task_id (#2328)', () => {
    const placeholders = ['', ' ', 'null', 'none', 'undefined', 'NULL', 'None', ' Undefined '];
    const blockerId = '8c4b1e2a-1111-4111-8111-111111111111';

    it.each(placeholders)('rejects %j even when another field is set', async (value) => {
      const updateTask = vi.fn().mockResolvedValue(makeTaskRow());
      const taskRepo = makeTaskRepo({ updateTask });
      const ctx = makeCtx({
        input: { task_id: VALID_UUID, status: 'waiting', blocked_by_task_id: value },
        taskRepo,
      });

      const result = await new TaskUpdateHandler().execute(ctx);

      expect(result.success).toBe(false);
      const error = (result as { success: false; error: string }).error;
      expect(error).toMatch(/pass JSON null to clear the blocker, or omit the field/);
      expect(error).toContain(JSON.stringify(value.trim()));
      expect(updateTask).not.toHaveBeenCalled();
    });

    it('does not clear the blocker when the field is omitted', async () => {
      const updateTask = vi.fn().mockResolvedValue(makeTaskRow());
      const taskRepo = makeTaskRepo({ updateTask });
      const ctx = makeCtx({ input: { task_id: VALID_UUID, status: 'in_progress' }, taskRepo });

      await new TaskUpdateHandler().execute(ctx);

      const updates = updateTask.mock.calls[0]![1] as object;
      expect(updates).not.toHaveProperty('blockedByTaskId');
    });

    it('clears the blocker when given JSON null', async () => {
      const updateTask = vi.fn().mockResolvedValue(makeTaskRow());
      const getTask = vi.fn();
      const taskRepo = makeTaskRepo({ updateTask, getTask });
      const ctx = makeCtx({
        input: { task_id: VALID_UUID, blocked_by_task_id: null },
        taskRepo,
      });

      const result = await new TaskUpdateHandler().execute(ctx);

      expect(result.success).toBe(true);
      expect(updateTask.mock.calls[0]![1].blockedByTaskId).toBeNull();
      expect(getTask).not.toHaveBeenCalled();
    });

    it('tells a placeholder-only call to pass JSON null or omit the field', async () => {
      const updateTask = vi.fn();
      const taskRepo = makeTaskRepo({ updateTask });
      const ctx = makeCtx({
        input: { task_id: VALID_UUID, blocked_by_task_id: 'null' },
        taskRepo,
      });

      const result = await new TaskUpdateHandler().execute(ctx);

      expect(result.success).toBe(false);
      expect((result as { success: false; error: string }).error).toBe(
        'blocked_by_task_id: "null" is a string; pass JSON null to clear the blocker, or omit the field.',
      );
      expect(updateTask).not.toHaveBeenCalled();
    });

    it('rejects a blocker that is the task itself and does not look it up', async () => {
      const updateTask = vi.fn();
      const getTask = vi.fn();
      const taskRepo = makeTaskRepo({ updateTask, getTask });
      const ctx = makeCtx({
        input: { task_id: VALID_UUID, blocked_by_task_id: VALID_UUID.toUpperCase() },
        taskRepo,
      });

      const result = await new TaskUpdateHandler().execute(ctx);

      expect(result.success).toBe(false);
      expect((result as { success: false; error: string }).error).toBe(SELF_BLOCK_ERROR);
      expect(updateTask).not.toHaveBeenCalled();
      expect(getTask).not.toHaveBeenCalled();
    });

    it('rejects "curia" and never calls the repo', async () => {
      const updateTask = vi.fn();
      const taskRepo = makeTaskRepo({ updateTask });
      const ctx = makeCtx({
        input: { task_id: VALID_UUID, blocked_by_task_id: 'curia' },
        taskRepo,
      });

      const result = await new TaskUpdateHandler().execute(ctx);

      expect(result.success).toBe(false);
      expect((result as { success: false; error: string }).error).toBe(BLOCKED_BY_TASK_ID_ERROR);
      expect(updateTask).not.toHaveBeenCalled();
    });

    it('returns task not found for a missing blocker and does not update', async () => {
      const updateTask = vi.fn();
      const taskRepo = makeTaskRepo({
        updateTask,
        getTask: vi.fn().mockResolvedValue(null),
      });
      const ctx = makeCtx({
        input: { task_id: VALID_UUID, blocked_by_task_id: blockerId },
        taskRepo,
      });

      const result = await new TaskUpdateHandler().execute(ctx);

      expect(result.success).toBe(false);
      expect((result as { success: false; error: string }).error).toMatch(/task not found/i);
      expect(updateTask).not.toHaveBeenCalled();
    });

    it('forwards a blocker uuid when that task exists', async () => {
      const updateTask = vi.fn().mockResolvedValue(makeTaskRow());
      const taskRepo = makeTaskRepo({
        updateTask,
        getTask: vi.fn().mockResolvedValue(makeTaskRow({ id: blockerId })),
      });
      const ctx = makeCtx({
        input: { task_id: VALID_UUID, blocked_by_task_id: blockerId },
        taskRepo,
      });

      const result = await new TaskUpdateHandler().execute(ctx);

      expect(result.success).toBe(true);
      expect(updateTask.mock.calls[0]![1].blockedByTaskId).toBe(blockerId);
    });

    it('rewrites a foreign-key failure as task not found', async () => {
      const fk = Object.assign(
        new Error('insert or update on table "tasks" violates foreign key constraint "tasks_blocked_by_task_id_fkey"'),
        { code: '23503', constraint: 'tasks_blocked_by_task_id_fkey' },
      );
      const taskRepo = makeTaskRepo({
        getTask: vi.fn().mockResolvedValue(makeTaskRow({ id: blockerId })),
        updateTask: vi.fn().mockRejectedValue(fk),
      });
      const ctx = makeCtx({
        input: { task_id: VALID_UUID, blocked_by_task_id: blockerId },
        taskRepo,
      });

      const result = await new TaskUpdateHandler().execute(ctx);

      const error = (result as { success: false; error: string }).error;
      expect(error).toMatch(/blocked_by_task_id: task not found/);
      expect(error).not.toMatch(/violates foreign key/);
    });
  });

  // ── Dedup review routed to Curia (#2493) ────────────────────────────────────

  describe('dedup review routed to Curia', () => {
    const curiaTask = makeTaskRow({ tags: ['dedup', 'contacts', 'dedup-route:curia'] });

    it('refuses to hand the task to the principal', async () => {
      const taskRepo = makeTaskRepo({ getTask: vi.fn().mockResolvedValue(curiaTask) });
      const result = await new TaskUpdateHandler().execute(makeCtx({
        input: { task_id: VALID_UUID, owner: 'ceo', status: 'waiting', progress_note: 'Merge?' },
        taskRepo,
      }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('yours to decide');
      expect(taskRepo.updateTask).not.toHaveBeenCalled();
    });

    it('allows the hand-over once a contact on the pair has become known since filing', async () => {
      const idA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const idB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const task = makeTaskRow({ tags: ['dedup', 'contacts', 'dedup-route:curia', dedupPairTag(idA, idB)] });
      const taskRepo = makeTaskRepo({ getTask: vi.fn().mockResolvedValue(task) });
      const contactService = {
        getContact: vi.fn(async (id: string) => ({
          id, kind: 'person', tier: id === idA ? 'known' : 'unknown',
        })),
      };
      const result = await new TaskUpdateHandler().execute(makeCtx({
        input: { task_id: VALID_UUID, owner: 'ceo', status: 'waiting', progress_note: 'Merge?' },
        taskRepo,
        contactService: contactService as never,
      }));
      expect(result.success).toBe(true);
      expect(taskRepo.updateTask).toHaveBeenCalled();
    });

    it('refuses a tags update that drops the dedup tag', async () => {
      const taskRepo = makeTaskRepo({ getTask: vi.fn().mockResolvedValue(curiaTask) });
      const result = await new TaskUpdateHandler().execute(makeCtx({
        input: { task_id: VALID_UUID, tags: ['dedup-route:curia'] },
        taskRepo,
      }));
      expect(result).toMatchObject({ success: false, error: expect.stringContaining('dedup tag') });
      expect(taskRepo.updateTask).not.toHaveBeenCalled();
    });

    it('refuses a tags update that adds the principal route tag next to the curia one', async () => {
      const taskRepo = makeTaskRepo({ getTask: vi.fn().mockResolvedValue(curiaTask) });
      const result = await new TaskUpdateHandler().execute(makeCtx({
        input: { task_id: VALID_UUID, tags: ['dedup', 'dedup-route:curia', 'dedup-route:principal'] },
        taskRepo,
      }));
      expect(result).toMatchObject({ success: false, error: expect.stringContaining('only the dedup-route:curia') });
      expect(taskRepo.updateTask).not.toHaveBeenCalled();
    });

    it('refuses a tags update that drops the route tag', async () => {
      const taskRepo = makeTaskRepo({ getTask: vi.fn().mockResolvedValue(curiaTask) });
      const result = await new TaskUpdateHandler().execute(makeCtx({
        input: { task_id: VALID_UUID, tags: ['dedup'] },
        taskRepo,
      }));
      expect(result.success).toBe(false);
      expect(taskRepo.updateTask).not.toHaveBeenCalled();
    });

    it('still lets the principal own a review routed to them', async () => {
      const principalTask = makeTaskRow({ tags: ['dedup', 'dedup-route:principal'] });
      const taskRepo = makeTaskRepo({ getTask: vi.fn().mockResolvedValue(principalTask) });
      const result = await new TaskUpdateHandler().execute(makeCtx({
        input: { task_id: VALID_UUID, owner: 'ceo', status: 'waiting' },
        taskRepo,
      }));
      expect(result.success).toBe(true);
      expect(taskRepo.updateTask).toHaveBeenCalled();
    });

    it('does not read the task for an update that neither changes owner nor tags', async () => {
      const taskRepo = makeTaskRepo();
      await new TaskUpdateHandler().execute(makeCtx({
        input: { task_id: VALID_UUID, status: 'in_progress' },
        taskRepo,
      }));
      expect(taskRepo.getTask).not.toHaveBeenCalled();
    });
  });

  describe('decline follow-up handoff to the principal (#2496)', () => {
    const declineTask = makeTaskRow({ owner: 'curia', tags: ['delegation-failure', 'ceo-inbox', 'specialist-decline'] });

    async function handOff(input: Record<string, unknown>, current: TaskRow = declineTask) {
      const repo = makeTaskRepo({ getTask: vi.fn().mockResolvedValue(current) });
      const result = await new TaskUpdateHandler().execute(
        makeCtx({ input: { task_id: VALID_UUID, owner: 'ceo', ...input }, taskRepo: repo }),
      );
      return { result, repo };
    }

    it('refuses to move it to the principal without a question', async () => {
      const { result, repo } = await handOff({ progress_note: 'Re-scope it smaller, or cancel.' });
      expect(result).toEqual({ success: false, error: DECLINE_HANDOFF_ERROR });
      expect(repo.updateTask).not.toHaveBeenCalled();
    });

    it('refuses with no progress note at all', async () => {
      const { result } = await handOff({});
      expect(result.success).toBe(false);
    });

    it('moves it with one question for the principal', async () => {
      const { result, repo } = await handOff({ progress_note: 'Should I send the Lena draft from your account as written?' });
      expect(result.success).toBe(true);
      expect(repo.updateTask).toHaveBeenCalledWith(
        VALID_UUID,
        expect.objectContaining({ owner: 'ceo' }),
        'coordinator',
      );
    });

    it('keeps the decline marker when the agent replaces the tags without it', async () => {
      const { result, repo } = await handOff({ tags: ['ceo-inbox'], progress_note: 'Should I send it?' });
      expect(result.success).toBe(true);
      expect(repo.updateTask).toHaveBeenCalledWith(
        VALID_UUID,
        expect.objectContaining({ tags: ['ceo-inbox', 'specialist-decline'] }),
        'coordinator',
      );
    });

    it('leaves other tasks alone', async () => {
      const { result } = await handOff({}, makeTaskRow({ owner: 'curia', tags: ['delegation-failure'] }));
      expect(result.success).toBe(true);
    });
  });
});


// SEC-L2 (#2475): the heartbeat's system-originated inbox drain cannot be re-armed or annotated
// by a lower-lineage turn, which would hand its notes to a system-standing successor.
describe('TaskUpdateHandler — the system inbox drain (SEC-L2)', () => {
  const drain = makeTaskRow({ tags: ['inbox-drain'], createdBy: 'heartbeat', originator: { contactId: 'system', systemRole: 'system', channel: 'declarative', initiatedAt: '2026-11-12T09:00:00.000Z' } as never });
  const run = (taskMetadata: Record<string, unknown> | undefined, input: Record<string, unknown> = { task_id: VALID_UUID, wake_at: '2026-11-12T10:00:00Z', progress_note: 'more' }) => {
    const taskRepo = makeTaskRepo({ getTask: vi.fn().mockResolvedValue(drain), updateTask: vi.fn().mockResolvedValue(drain) });
    return { taskRepo, result: new TaskUpdateHandler().execute(makeCtx({ input, taskRepo, taskMetadata } as Partial<ToolContext>)) };
  };

  it.each([
    ['an outsider-originated turn', { originator: { contactId: 'c-1', systemRole: null, tier: 'outsider' } }],
    ['an agent turn', { originator: { systemRole: 'agent', ladderedFrom: null } }],
    ['a turn with no lineage', undefined],
  ])('refuses %s and writes nothing', async (_who, meta) => {
    const { taskRepo, result } = run(meta);
    const r = await result;
    expect(r.success).toBe(false);
    expect(taskRepo.updateTask).not.toHaveBeenCalled();
  });

  it('lets the drain run itself (system lineage, raw or laddered) re-arm it', async () => {
    expect((await run({ originator: { systemRole: 'system' } }).result).success).toBe(true);
    expect((await run({ originator: { systemRole: 'agent', ladderedFrom: 'system' } }).result).success).toBe(true);
  });

  it('a plain status change needs no lookup', async () => {
    const { taskRepo, result } = run(undefined, { task_id: VALID_UUID, status: 'in_progress' });
    expect((await result).success).toBe(true);
    expect(taskRepo.getTask).not.toHaveBeenCalled();
  });
});
