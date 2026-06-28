import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RESUMABLE_CONTINUATION_CREATED_BY,
  isContinuationEligible,
  resolveContinuationAgent,
  scheduleResumableContinuation,
} from '../../../src/agents/resumable-continuation.js';
import type { TaskRow } from '../../../src/db/queries/tasks.js';
import * as tasksQueries from '../../../src/db/queries/tasks.js';

function mockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() };
}

function sampleTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'task-1',
    agentId: 'social-media',
    intentAnchor: 'Audit follows',
    status: 'in_progress',
    progress: {
      resumable: {
        cursor: 'page:3',
        done: 25,
        total: 1300,
        accumulator: [],
        lastSliceUnits: 25,
        next: 'Review page 4',
      },
    },
    errorBudget: { resumable: true },
    conversationId: null,
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    title: 'Audit',
    description: null,
    owner: 'curia',
    waitingOnContactId: null,
    waitingOnText: null,
    parentTaskId: null,
    blockedByTaskId: null,
    priority: 0,
    dueAt: null,
    source: 'coordinator',
    sourceAgentId: 'social-media',
    createdBy: 'coordinator',
    tags: ['resumable'],
    originator: null,
    ...overrides,
  };
}

describe('resolveContinuationAgent', () => {
  const eligible = new Set(['coordinator', 'social-media']);

  it('routes to source_agent_id when eligible', () => {
    expect(resolveContinuationAgent(sampleTask(), eligible)).toBe('social-media');
  });

  it('falls back to coordinator when source_agent_id is null', () => {
    expect(resolveContinuationAgent(sampleTask({ sourceAgentId: null }), eligible)).toBe('coordinator');
  });

  it('falls back when source_agent_id is not heartbeat-eligible', () => {
    expect(resolveContinuationAgent(sampleTask({ sourceAgentId: 'essay-editor' }), eligible)).toBe('coordinator');
  });
});

describe('isContinuationEligible', () => {
  it('requires resumable marker and checkpoint', () => {
    expect(isContinuationEligible(sampleTask())).toBe(true);
    expect(isContinuationEligible(sampleTask({ progress: {}, errorBudget: {}, tags: [] }))).toBe(false);
    expect(isContinuationEligible(sampleTask({ progress: {}, errorBudget: { resumable: true }, tags: ['resumable'] }))).toBe(false);
  });
});

describe('scheduleResumableContinuation', () => {
  const eligibleAgents = new Set(['coordinator', 'social-media']);
  let enqueueTaskWake: ReturnType<typeof vi.fn>;
  let schedulerService: { enqueueTaskWake: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.restoreAllMocks();
    enqueueTaskWake = vi.fn().mockResolvedValue({ jobId: 'job-cont' });
    schedulerService = { enqueueTaskWake };
  });

  it('enqueues exactly one near-term wake routed to source_agent_id', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ pending: false }] }),
    };
    vi.spyOn(tasksQueries, 'getTaskById').mockResolvedValue(sampleTask());

    const before = Date.now();
    const result = await scheduleResumableContinuation({
      pool: pool as never,
      schedulerService: schedulerService as never,
      logger: mockLogger() as never,
      taskId: 'task-1',
      delaySeconds: 30,
      eligibleAgents,
    });

    expect(result).toMatchObject({ scheduled: true, jobId: 'job-cont', agentId: 'social-media' });
    if (!('scheduled' in result) || !result.scheduled) return;
    expect(result.runAt.getTime()).toBeGreaterThanOrEqual(before + 29_000);
    expect(result.runAt.getTime()).toBeLessThanOrEqual(before + 31_000);

    expect(enqueueTaskWake).toHaveBeenCalledTimes(1);
    expect(enqueueTaskWake).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      agentId: 'social-media',
      createdBy: RESUMABLE_CONTINUATION_CREATED_BY,
      derived: false,
    }));
  });

  it('threads derived=true for agent-spawned child tasks', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ pending: false }] }),
    };
    vi.spyOn(tasksQueries, 'getTaskById').mockResolvedValue(sampleTask({ source: 'agent', parentTaskId: 'parent-1' }));

    await scheduleResumableContinuation({
      pool: pool as never,
      schedulerService: schedulerService as never,
      logger: mockLogger() as never,
      taskId: 'task-1',
      delaySeconds: 30,
      eligibleAgents,
    });

    expect(enqueueTaskWake).toHaveBeenCalledWith(expect.objectContaining({ derived: true }));
  });

  it('skips when a pending wake already exists', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ pending: true }] }),
    };
    vi.spyOn(tasksQueries, 'getTaskById').mockResolvedValue(sampleTask());

    const result = await scheduleResumableContinuation({
      pool: pool as never,
      schedulerService: schedulerService as never,
      logger: mockLogger() as never,
      taskId: 'task-1',
      delaySeconds: 30,
      eligibleAgents,
    });

    expect(result).toEqual({ scheduled: false, reason: 'pending_wake_exists' });
    expect(enqueueTaskWake).not.toHaveBeenCalled();
  });

  it('skips when task has no checkpoint', async () => {
    vi.spyOn(tasksQueries, 'getTaskById').mockResolvedValue(sampleTask({ progress: {} }));

    const result = await scheduleResumableContinuation({
      pool: { query: vi.fn() } as never,
      schedulerService: schedulerService as never,
      logger: mockLogger() as never,
      taskId: 'task-1',
      delaySeconds: 30,
      eligibleAgents,
    });

    expect(result).toEqual({ scheduled: false, reason: 'no_checkpoint' });
    expect(enqueueTaskWake).not.toHaveBeenCalled();
  });

  it('treats a unique-index race on enqueue as pending_wake_exists', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ pending: false }] }),
    };
    vi.spyOn(tasksQueries, 'getTaskById').mockResolvedValue(sampleTask());
    enqueueTaskWake.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));

    const result = await scheduleResumableContinuation({
      pool: pool as never,
      schedulerService: schedulerService as never,
      logger: mockLogger() as never,
      taskId: 'task-1',
      delaySeconds: 30,
      eligibleAgents,
    });

    expect(result).toEqual({ scheduled: false, reason: 'pending_wake_exists' });
  });
});
