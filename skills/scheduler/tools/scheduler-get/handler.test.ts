import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import {
  SchedulerGetHandler,
  MAX_DETAIL_JSON_CHARS,
  MAX_DETAIL_SUMMARY_CHARS,
  DETAIL_TRUNCATED_MARKER,
} from './handler.js';
import type { ToolContext } from '../../../../src/skills/types.js';

const logger = pino({ level: 'silent' });

const JOB_ID = '0f0f0f0f-0000-4000-8000-000000000001';

// Longer than scheduler-list's 160-character preview, with a phrase only after the cut.
const LONG_TASK =
  'Every Sunday evening, build the weekly agenda for the principal. ' +
  'Pull the coming week from the calendar, group meetings by day, and flag any conflicts. ' +
  'After that, add a week-ahead section that lists travel and deadlines — the PERIWINKLE CLAUSE.';

function makeCtx(input: Record<string, unknown>, overrides?: Partial<ToolContext>): ToolContext {
  return {
    toolName: 'scheduler-get',
    toolVersion: '0.1.0',
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    ...overrides,
  };
}

function makeJob(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: JOB_ID,
    agentId: 'coordinator',
    status: 'pending',
    cronExpr: '0 18 * * 0',
    runAt: null,
    nextRunAt: '2026-07-26T22:00:00.000Z',
    lastRunAt: '2026-07-19T22:00:00.000Z',
    lastRunOutcome: 'completed',
    consecutiveFailures: 0,
    lastError: null,
    timezone: 'America/Toronto',
    taskTitle: 'Weekly agenda',
    intentAnchor: 'Build the weekly agenda every Sunday',
    taskTags: ['agenda'],
    agentTaskId: 'task-1',
    createdBy: 'coordinator',
    createdAt: '2026-07-01T00:00:00.000Z',
    taskPayload: { task: LONG_TASK, channel: 'email' },
    progress: { step: 2 },
    lastRunContext: { cursor: 'abc' },
    lastRunSummary: 'Sent the agenda; no conflicts.',
    taskErrorBudget: null,
    originator: null,
    runStartedAt: null,
    expectedDurationSeconds: null,
    ...extra,
  };
}

function serviceReturning(job: Record<string, unknown> | null) {
  return { getJob: vi.fn().mockResolvedValue(job) };
}

type Detail = Record<string, unknown> & { taskPayload: Record<string, unknown> };
interface Data { job: Detail; truncatedFields: string[]; displayTimezone: string }

async function getData(job: Record<string, unknown>, overrides?: Partial<ToolContext>): Promise<Data> {
  const schedulerService = serviceReturning(job);
  const result = await new SchedulerGetHandler().execute(
    makeCtx({ job_id: JOB_ID }, { schedulerService: schedulerService as never, ...overrides }),
  );
  expect(result.success).toBe(true);
  if (!result.success) throw new Error(result.error);
  expect(schedulerService.getJob).toHaveBeenCalledWith(JOB_ID);
  return result.data as Data;
}

describe('SchedulerGetHandler', () => {
  const handler = new SchedulerGetHandler();

  it('returns failure when schedulerService is not available', async () => {
    const result = await handler.execute(makeCtx({ job_id: JOB_ID }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('schedulerService');
  });

  it('requires a job_id', async () => {
    const schedulerService = serviceReturning(makeJob());
    const result = await handler.execute(makeCtx({}, { schedulerService: schedulerService as never }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('job_id');
    expect(schedulerService.getJob).not.toHaveBeenCalled();
  });

  it('returns the full task payload untouched, past the 160-character preview (#2399)', async () => {
    expect(LONG_TASK.length).toBeGreaterThan(160);
    const data = await getData(makeJob());

    expect(data.job.taskPayload).toEqual({ task: LONG_TASK, channel: 'email' });
    expect(String(data.job.taskPayload['task'])).toContain('PERIWINKLE CLAUSE');
    // One copy of the task: a long one must not count twice against the layer's cap.
    expect(data.job).not.toHaveProperty('task');
    // The list summary is still there, preview and all.
    expect(data.job['taskPreview']).toMatch(/…$/);
    expect(data.job['taskTitle']).toBe('Weekly agenda');
    expect(data.job['intentAnchor']).toBe('Build the weekly agenda every Sunday');
    expect(data.job['agentTaskId']).toBe('task-1');
    expect(data.job['lastRunSummary']).toBe('Sent the agenda; no conflicts.');
    expect(data.job['lastRunContext']).toEqual({ cursor: 'abc' });
    expect(data.job['progress']).toEqual({ step: 2 });
    expect(data.job['lastRunOutcome']).toBe('completed');
    expect(data.truncatedFields).toEqual([]);
    // Fields the agent has no use for stay out.
    expect(data.job).not.toHaveProperty('originator');
    expect(data.job).not.toHaveProperty('taskErrorBudget');
  });

  it('returns a payload with no string task as stored', async () => {
    const data = await getData(makeJob({ taskPayload: { steps: ['a', 'b'] } }));
    expect(data.job.taskPayload).toEqual({ steps: ['a', 'b'] });
  });

  it('returns a plain not-found error for an unknown id', async () => {
    const schedulerService = serviceReturning(null);
    const result = await handler.execute(makeCtx({ job_id: JOB_ID }, { schedulerService: schedulerService as never }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain(JOB_ID);
      expect(result.error).toContain('scheduler-list');
    }
  });

  it('answers a non-UUID id as not found without querying', async () => {
    const schedulerService = serviceReturning(makeJob());
    const result = await handler.execute(makeCtx({ job_id: 'weekly-agenda' }, { schedulerService: schedulerService as never }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('scheduler-list');
    expect(schedulerService.getJob).not.toHaveBeenCalled();
  });

  it('converts timestamps to the user timezone and reports displayTimezone', async () => {
    const data = await getData(makeJob(), { timezone: 'America/Toronto' });
    // Fixed July instants → EDT (UTC-04:00), never a raw Z string.
    expect(data.job['nextRunAt']).toBe('2026-07-26T18:00:00.000-04:00');
    expect(data.job['lastRunAt']).toBe('2026-07-19T18:00:00.000-04:00');
    expect(data.job['runAt']).toBeNull();
    expect(data.displayTimezone).toMatch(/UTC-0[45]:00/);
  });

  it('caps oversized run context and progress with flags, and keeps the task whole', async () => {
    const hugeTask = `${LONG_TASK} ${'Keep every word. '.repeat(1_000)}`;
    const data = await getData(makeJob({
      taskPayload: { task: hugeTask },
      lastRunContext: { notes: 'z'.repeat(MAX_DETAIL_JSON_CHARS * 3) },
      progress: { notes: 'p'.repeat(MAX_DETAIL_JSON_CHARS * 2) },
      lastRunSummary: 's'.repeat(MAX_DETAIL_SUMMARY_CHARS + 50),
    }));

    expect(data.truncatedFields).toEqual(expect.arrayContaining(['lastRunContext', 'progress', 'lastRunSummary']));
    const context = data.job['lastRunContext'] as string;
    expect(typeof context).toBe('string');
    expect(context).toHaveLength(MAX_DETAIL_JSON_CHARS);
    expect(context.endsWith(DETAIL_TRUNCATED_MARKER)).toBe(true);
    expect((data.job['progress'] as string).endsWith(DETAIL_TRUNCATED_MARKER)).toBe(true);
    expect(data.job['lastRunSummary']).toHaveLength(MAX_DETAIL_SUMMARY_CHARS);

    // The task is never cut.
    expect(data.job.taskPayload['task']).toBe(hugeTask);
    expect(data.truncatedFields).not.toContain('task');
  });

  it('returns failure when getJob throws', async () => {
    const schedulerService = { getJob: vi.fn().mockRejectedValue(new Error('query failed')) };
    const result = await handler.execute(makeCtx({ job_id: JOB_ID }, { schedulerService: schedulerService as never }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('query failed');
  });
});
