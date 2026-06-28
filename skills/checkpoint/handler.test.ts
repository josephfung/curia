import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { CheckpointHandler } from './handler.js';
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
    agentId: 'social-media',
    timezone: 'America/Toronto',
    ...overrides,
  } as unknown as SkillContext;
}

function makeTaskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: VALID_UUID,
    agentId: 'social-media',
    intentAnchor: 'Audit follows',
    title: 'Audit follows',
    description: null,
    status: 'in_progress',
    progress: { notes: [] },
    errorBudget: { resumable: true },
    conversationId: null,
    createdAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z',
    owner: 'curia',
    waitingOnContactId: null,
    waitingOnText: null,
    parentTaskId: null,
    blockedByTaskId: null,
    priority: 50,
    dueAt: null,
    source: 'agent',
    sourceAgentId: 'coordinator',
    createdBy: 'coordinator',
    tags: [],
    originator: null,
    ...overrides,
  };
}

describe('CheckpointHandler', () => {
  it('rejects non-resumable tasks', async () => {
    const taskRepo = {
      getTask: vi.fn().mockResolvedValue(makeTaskRow({ errorBudget: {} })),
    } as unknown as TaskRepo;

    const handler = new CheckpointHandler();
    const result = await handler.execute(makeCtx({
      input: {
        task_id: VALID_UUID,
        done: 1,
        total: 10,
        last_slice_units: 1,
        next: 'Continue',
      },
      taskRepo,
    }));

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/not resumable/i);
  });

  it('writes checkpoint via taskRepo.setResumableBlock', async () => {
    const block = {
      cursor: 'page-2',
      done: 12,
      total: 100,
      accumulator: [],
      lastSliceUnits: 12,
      next: 'Keep paging',
      checkpointedAt: '2026-06-28T12:00:00.000Z',
    };
    const taskRepo = {
      getTask: vi.fn().mockResolvedValue(makeTaskRow()),
      setResumableBlock: vi.fn().mockResolvedValue({ task: makeTaskRow(), block }),
    } as unknown as TaskRepo;

    const handler = new CheckpointHandler();
    const result = await handler.execute(makeCtx({
      input: {
        done: 12,
        total: 100,
        last_slice_units: 12,
        next: 'Keep paging',
        cursor: 'page-2',
      },
      taskMetadata: {
        boundTask: { taskId: VALID_UUID, errorBudget: { resumable: true }, progress: {} },
      },
      taskRepo,
    }));

    expect(result.success).toBe(true);
    expect(taskRepo.setResumableBlock).toHaveBeenCalledWith(
      VALID_UUID,
      expect.objectContaining({ done: 12, total: 100, next: 'Keep paging' }),
      'social-media',
    );
  });

  it('surfaces inline accumulator overflow', async () => {
    const taskRepo = {
      getTask: vi.fn().mockResolvedValue(makeTaskRow()),
      setResumableBlock: vi.fn().mockResolvedValue({
        ok: false,
        code: 'inline_accumulator_overflow',
        bytes: 5000,
        maxBytes: 4096,
      }),
    } as unknown as TaskRepo;

    const handler = new CheckpointHandler();
    const result = await handler.execute(makeCtx({
      input: {
        task_id: VALID_UUID,
        done: 1,
        total: 10,
        last_slice_units: 1,
        next: 'Continue',
        accumulator: { huge: 'x'.repeat(5000) },
      },
      taskRepo,
    }));

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/inline cap/i);
  });
});
