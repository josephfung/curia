import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler } from '../../../src/scheduler/scheduler.js';
import { RESUMABLE_CONTINUATION_CREATED_BY } from '../../../src/agents/resumable-continuation.js';
import {
  isUndisposedWake,
  progressNotesSnapshot,
  WAKE_DISPOSITION_INSTRUCTION,
} from '../../../src/scheduler/wake-disposition.js';

function mockPool() {
  return { query: vi.fn() };
}

function mockBus() {
  return { publish: vi.fn(), subscribe: vi.fn() };
}

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

const CLAIMED_AT = '2026-10-01 00:00:08.000000+00';

function claimed() {
  return { rowCount: 1, rows: [{ run_started_at: CLAIMED_AT }] };
}

function wakeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    agent_id: 'meeting-debrief',
    cron_expr: null,
    run_at: new Date().toISOString(),
    task_payload: { type: 'task-wake', task_id: 'task-abc', standing: { derived: false } },
    status: 'pending',
    last_run_at: null,
    next_run_at: new Date().toISOString(),
    last_error: null,
    consecutive_failures: 0,
    created_by: 'heartbeat',
    created_at: new Date().toISOString(),
    timezone: 'America/Toronto',
    agent_task_id: 'task-abc',
    intent_anchor: 'Remind the principal',
    progress: { notes: [] },
    task_error_budget: null,
    task_tags: [],
    task_title: 'Preply lesson',
    run_started_at: null,
    expected_duration_seconds: null,
    last_run_outcome: null,
    last_run_summary: null,
    last_run_context: null,
    ...overrides,
  };
}

function dispositionRow(overrides: Record<string, unknown> = {}) {
  return {
    status: 'open',
    progress: { notes: [] },
    title: 'Preply lesson',
    deferred_wake: false,
    other_active_wake: false,
    ...overrides,
  };
}

interface PublishedTask {
  id: string;
  type: string;
  payload: {
    agentId: string;
    conversationId: string;
    content: string;
    toolAllowlist?: string[];
    syntheticTurn?: boolean;
  };
}

function agentTasks(bus: ReturnType<typeof mockBus>): PublishedTask[] {
  return bus.publish.mock.calls
    .map((call) => call[1] as PublishedTask)
    .filter((event) => event?.type === 'agent.task');
}

describe('isUndisposedWake', () => {
  const base = {
    status: 'open',
    progress: { notes: [] },
    notesAtStart: '[]',
    deferredWake: false,
    otherActiveWake: false,
  };

  it('is undisposed when the task is still open and nothing was recorded', () => {
    expect(isUndisposedWake(base)).toBe(true);
    expect(isUndisposedWake({ ...base, status: 'in_progress' })).toBe(true);
  });

  it('treats done, cancelled, and parked statuses as dispositions', () => {
    for (const status of ['done', 'cancelled', 'waiting', 'blocked']) {
      expect(isUndisposedWake({ ...base, status })).toBe(false);
    }
  });

  it('treats a new progress note or a new wake as a disposition', () => {
    const withNote = { notes: [{ at: '2026-10-01T00:00:00Z', note: 'sent' }] };
    expect(isUndisposedWake({ ...base, progress: withNote })).toBe(false);
    expect(isUndisposedWake({ ...base, deferredWake: true })).toBe(false);
    expect(isUndisposedWake({ ...base, otherActiveWake: true })).toBe(false);
  });

  it('ignores non-note progress blocks when comparing', () => {
    expect(progressNotesSnapshot({ notes: [], activeSkills: { names: ['signal'] } })).toBe('[]');
    expect(isUndisposedWake({
      ...base,
      progress: { notes: [], activeSkills: { names: ['signal'] } },
    })).toBe(true);
  });
});

describe('Scheduler task-wake disposition (#1951)', () => {
  let pool: ReturnType<typeof mockPool>;
  let bus: ReturnType<typeof mockBus>;
  let logger: ReturnType<typeof mockLogger>;
  let schedulerService: { completeJobRun: ReturnType<typeof vi.fn> };
  let taskRepo: { createTask: ReturnType<typeof vi.fn> };
  let scheduler: Scheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    pool = mockPool();
    bus = mockBus();
    logger = mockLogger();
    schedulerService = { completeJobRun: vi.fn().mockResolvedValue({ suspended: false }) };
    taskRepo = { createTask: vi.fn().mockResolvedValue({ id: 'review-1' }) };
    scheduler = new Scheduler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pool: pool as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bus: bus as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: logger as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      schedulerService: schedulerService as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      taskRepo: taskRepo as any,
      ownsAgent: () => true,
    });
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  async function fire(overrides: Record<string, unknown> = {}): Promise<PublishedTask> {
    pool.query.mockResolvedValueOnce({ rows: [wakeRow(overrides)] });
    pool.query.mockResolvedValueOnce(claimed());
    await scheduler.pollDueJobs();
    const task = agentTasks(bus)[0];
    if (!task) throw new Error('fire: no agent.task published');
    return task;
  }

  function responseHandler(): (event: unknown) => void {
    scheduler.start();
    const handler = bus.subscribe.mock.calls[0]?.[2] as ((event: unknown) => void) | undefined;
    if (!handler) throw new Error('response handler was not registered');
    return handler;
  }

  function respond(handler: (event: unknown) => void, parentEventId: string, content: string, isError = false): void {
    handler({
      id: `resp-${parentEventId}`,
      type: 'agent.response',
      sourceLayer: 'agent',
      parentEventId,
      timestamp: new Date(),
      payload: {
        agentId: 'meeting-debrief',
        conversationId: 'ignored',
        content,
        ...(isError && { isError: true }),
      },
    });
  }

  it('frames ordinary task-wake content with the disposition instruction', async () => {
    const task = await fire();
    const content = JSON.parse(task.payload.content) as { instruction?: string; task_id?: string };
    expect(content.task_id).toBe('task-abc');
    expect(content.instruction).toBe(WAKE_DISPOSITION_INSTRUCTION);
    expect(content.instruction).toContain('task-complete');
    expect(content.instruction).toContain('does not close the task');
  });

  it('omits the instruction on a task-bound job that is not a task wake', async () => {
    const task = await fire({
      task_payload: { skill: 'morning-brief' },
    });
    const content = JSON.parse(task.payload.content) as { instruction?: string };
    expect(content.instruction).toBeUndefined();
  });

  it('injects prior-run context when a revived wake still has last_run_outcome completed', async () => {
    const task = await fire({
      last_run_outcome: 'completed',
      last_run_summary: 'signal sent',
      last_run_context: { signal_sent: true },
      last_run_at: new Date('2026-09-30T20:00:08Z'),
    });
    expect(task.payload.content).toContain('[Prior run context');
    expect(task.payload.content).toContain('Outcome: completed');
    expect(task.payload.content).toContain('signal sent');
    expect(task.payload.content).toContain('signal_sent');
  });

  it('asks once, on the same conversation, and leaves the job running so the heartbeat cannot revive it', async () => {
    const task = await fire();
    pool.query.mockResolvedValueOnce({ rows: [dispositionRow()] });
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const handler = responseHandler();
    respond(handler, task.id, 'Sent the Signal reminder');

    await vi.waitFor(() => {
      expect(agentTasks(bus)).toHaveLength(2);
    });

    // The claim left the row running. completeJobRun is what marks it completed.
    // Until it runs, selectHeartbeatCandidates excludes the task (pending/running wake).
    expect(schedulerService.completeJobRun).not.toHaveBeenCalled();
    const touch = pool.query.mock.calls.map((call) => String(call[0])).find((sql) => sql.includes('updated_at = now()'));
    expect(touch).toBeDefined();

    const followUp = agentTasks(bus)[1]!;
    expect(followUp.payload.agentId).toBe('meeting-debrief');
    expect(followUp.payload.conversationId).toBe(task.payload.conversationId);
    expect(followUp.payload.conversationId).toMatch(/^scheduler:job-1:/);
    expect(followUp.payload.toolAllowlist).toEqual(['task-complete', 'task-update']);
    expect(followUp.payload.syntheticTurn).toBe(true);
    expect(followUp.payload.content).toContain('still open');
    expect(followUp.payload.content).toContain('Do not repeat');
  });

  it('does not ask when the run already completed, cancelled, or parked the task', async () => {
    const handler = responseHandler();
    for (const status of ['done', 'cancelled', 'waiting', 'blocked']) {
      bus.publish.mockClear();
      pool.query.mockReset();
      schedulerService.completeJobRun.mockClear();
      const task = await fire();
      pool.query.mockResolvedValueOnce({
        rows: [dispositionRow({
          status,
          progress: status === 'waiting' || status === 'blocked'
            ? { notes: [{ at: '2026-10-01T00:01:00Z', note: 'parked' }] }
            : { notes: [] },
        })],
      });
      respond(handler, task.id, 'Handled it');
      await vi.waitFor(() => {
        expect(schedulerService.completeJobRun).toHaveBeenCalledWith(
          'job-1', true, undefined, 'Handled it', undefined, undefined,
        );
      });
      expect(agentTasks(bus)).toHaveLength(1);
    }
  });

  it('does not ask when the run added a note or scheduled a wake while staying open', async () => {
    const task = await fire();
    pool.query.mockResolvedValueOnce({
      rows: [dispositionRow({
        progress: { notes: [{ at: '2026-10-01T00:01:00Z', note: 'sent the reminder' }] },
      })],
    });
    const handler = responseHandler();
    respond(handler, task.id, 'Noted');
    await vi.waitFor(() => {
      expect(schedulerService.completeJobRun).toHaveBeenCalled();
    });
    expect(agentTasks(bus)).toHaveLength(1);

    bus.publish.mockClear();
    pool.query.mockReset();
    schedulerService.completeJobRun.mockClear();
    const again = await fire();
    pool.query.mockResolvedValueOnce({ rows: [dispositionRow({ deferred_wake: true })] });
    respond(handler, again.id, 'Parked until tomorrow');
    await vi.waitFor(() => {
      expect(schedulerService.completeJobRun).toHaveBeenCalled();
    });
    expect(agentTasks(bus)).toHaveLength(1);
  });

  it('does not ask a resumable continuation slice to close the task', async () => {
    const task = await fire({ created_by: RESUMABLE_CONTINUATION_CREATED_BY });
    const content = JSON.parse(task.payload.content) as { instruction?: string };
    expect(content.instruction).toBe(WAKE_DISPOSITION_INSTRUCTION);
    const handler = responseHandler();
    respond(handler, task.id, 'Slice advanced.');
    await vi.waitFor(() => {
      expect(schedulerService.completeJobRun).toHaveBeenCalledWith(
        'job-1', true, undefined, 'Slice advanced.', undefined, undefined,
      );
    });
    expect(agentTasks(bus)).toHaveLength(1);
    expect(taskRepo.createTask).not.toHaveBeenCalled();
  });

  it('does not ask after a failed run', async () => {
    const task = await fire();
    const handler = responseHandler();
    respond(handler, task.id, 'boom', true);
    await vi.waitFor(() => {
      expect(schedulerService.completeJobRun).toHaveBeenCalledWith(
        'job-1', false, 'boom', undefined, undefined, undefined,
      );
    });
    expect(agentTasks(bus)).toHaveLength(1);
    expect(taskRepo.createTask).not.toHaveBeenCalled();
  });

  it('flags, excludes via the review surface, and does not ask again when the follow-up also leaves it open', async () => {
    const task = await fire();
    pool.query.mockResolvedValueOnce({ rows: [dispositionRow()] });
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const handler = responseHandler();
    respond(handler, task.id, 'Sent the Signal reminder');
    await vi.waitFor(() => {
      expect(agentTasks(bus)).toHaveLength(2);
    });
    const followUp = agentTasks(bus)[1]!;

    pool.query.mockResolvedValueOnce({ rows: [dispositionRow()] });
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'task-abc' }] });
    respond(handler, followUp.id, 'I am not sure what to do');

    await vi.waitFor(() => {
      expect(schedulerService.completeJobRun).toHaveBeenCalledTimes(1);
    });
    expect(schedulerService.completeJobRun).toHaveBeenCalledWith(
      'job-1', true, undefined, 'Sent the Signal reminder', undefined, undefined,
    );

    const toAgent = agentTasks(bus).filter((event) => event.payload.agentId === 'meeting-debrief');
    expect(toAgent).toHaveLength(2);

    const review = agentTasks(bus).find((event) => event.payload.conversationId === 'scheduler-disposition:task-abc');
    expect(review?.payload.agentId).toBe('coordinator');
    expect(review?.payload.content).toContain('review notice only');
    expect(review?.payload.toolAllowlist).toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-abc', jobId: 'job-1' }),
      expect.stringContaining('excluded from heartbeat revival'),
    );
    const tagCall = pool.query.mock.calls.find((call) => {
      const params = call[1] as unknown[] | undefined;
      return Array.isArray(params) && params.includes('needs-disposition');
    });
    expect(tagCall).toBeDefined();
    expect(String(tagCall?.[0])).toContain('array_append');

    expect(taskRepo.createTask).toHaveBeenCalledWith(expect.objectContaining({
      owner: 'ceo',
      tags: expect.arrayContaining(['needs-attention', 'needs-disposition']),
    }));

    // The review notice is not a chained disposition turn. Its response is ignored.
    const callsBefore = schedulerService.completeJobRun.mock.calls.length;
    respond(handler, review!.id, 'I will tell them');
    await Promise.resolve();
    expect(schedulerService.completeJobRun).toHaveBeenCalledTimes(callsBefore);
    expect(agentTasks(bus).filter((event) => event.payload.agentId === 'meeting-debrief')).toHaveLength(2);
  });

  it('completes without flagging when the follow-up disposes the task', async () => {
    const task = await fire();
    pool.query.mockResolvedValueOnce({ rows: [dispositionRow()] });
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const handler = responseHandler();
    respond(handler, task.id, 'Sent the Signal reminder');
    await vi.waitFor(() => {
      expect(agentTasks(bus)).toHaveLength(2);
    });
    const followUp = agentTasks(bus)[1]!;

    pool.query.mockResolvedValueOnce({ rows: [dispositionRow({ status: 'done' })] });
    respond(handler, followUp.id, 'Marked done');
    await vi.waitFor(() => {
      expect(schedulerService.completeJobRun).toHaveBeenCalledTimes(1);
    });
    expect(taskRepo.createTask).not.toHaveBeenCalled();
    expect(agentTasks(bus).filter((event) => event.payload.agentId === 'coordinator')).toHaveLength(0);
  });
});
