import { describe, it, expect, vi } from 'vitest';
import { SchedulerListHandler } from '../../../skills/scheduler/tools/scheduler-list/handler.js';
import type { ToolContext } from '../../../src/skills/types.js';

import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(
  input: Record<string, unknown>,
  overrides?: Partial<ToolContext>,
): ToolContext {
  return {
    toolName: 'scheduler-list',
    toolVersion: '1.2.0',
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    ...overrides,
  };
}

/** Build a job row with the heavy JSONB fields populated so tests can assert they
 *  are excluded from the trimmed listing. */
function makeJob(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    agentId: 'coordinator',
    status: 'pending',
    cronExpr: '0 8 * * *',
    runAt: null,
    nextRunAt: '2026-07-22T08:00:00.000Z',
    lastRunAt: null,
    lastRunOutcome: null,
    consecutiveFailures: 0,
    lastError: null,
    timezone: 'America/Toronto',
    taskTitle: 'Daily briefing',
    intentAnchor: 'send daily briefing',
    taskTags: ['briefing'],
    agentTaskId: 'task-1',
    createdBy: 'coordinator',
    createdAt: '2026-07-01T00:00:00.000Z',
    // Heavy JSONB fields that must NOT appear in the trimmed summary:
    taskPayload: { blob: 'x'.repeat(1000) },
    progress: { step: 3, notes: 'y'.repeat(1000) },
    lastRunContext: { ctx: 'z'.repeat(1000) },
    lastRunSummary: 'w'.repeat(1000),
    taskErrorBudget: { spent: 2 },
    originator: { systemRole: 'system' },
    ...extra,
  };
}

describe('SchedulerListHandler', () => {
  const handler = new SchedulerListHandler();

  it('returns failure when schedulerService is not available', async () => {
    const result = await handler.execute(makeCtx({}));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('schedulerService');
    }
  });

  it('returns a bounded, trimmed listing and requests one extra row to detect truncation', async () => {
    const schedulerService = {
      createJob: vi.fn(),
      listJobs: vi.fn().mockResolvedValue([makeJob('job-1'), makeJob('job-2')]),
      cancelJob: vi.fn(),
    };

    const result = await handler.execute(makeCtx(
      {},
      { schedulerService: schedulerService as never },
    ));

    // Default limit is 50; the handler fetches limit + 1 to know if more exist.
    expect(schedulerService.listJobs).toHaveBeenCalledWith({
      status: undefined,
      agentId: undefined,
      limit: 51,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as {
        jobs: Array<Record<string, unknown>>;
        count: number;
        truncated: boolean;
        limit: number;
        displayTimezone: string;
      };
      expect(data.count).toBe(2);
      expect(data.truncated).toBe(false);
      expect(data.limit).toBe(50);
      // With no ctx.timezone the handler falls back to UTC and leaves Z-suffix strings.
      expect(data.displayTimezone).toBe('UTC');

      // Heavy JSONB fields are stripped from the list view.
      const job = data.jobs[0]!;
      expect(job['id']).toBe('job-1');
      expect(job['taskTitle']).toBe('Daily briefing');
      expect(job).not.toHaveProperty('taskPayload');
      expect(job).not.toHaveProperty('progress');
      expect(job).not.toHaveProperty('lastRunContext');
      expect(job).not.toHaveProperty('lastRunSummary');
      expect(job).not.toHaveProperty('taskErrorBudget');
      expect(job).not.toHaveProperty('originator');
    }
  });

  it('converts timestamps to the user timezone and reports displayTimezone (#1487)', async () => {
    const schedulerService = {
      createJob: vi.fn(),
      listJobs: vi.fn().mockResolvedValue([makeJob('job-1')]),
      cancelJob: vi.fn(),
    };

    const result = await handler.execute(makeCtx(
      {},
      { schedulerService: schedulerService as never, timezone: 'America/Toronto' },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as {
        jobs: Array<Record<string, unknown>>;
        displayTimezone: string;
      };
      const job = data.jobs[0]!;
      // These are fixed July instants → always EDT (UTC-04:00), regardless of when the
      // test runs. Crucially, NOT a raw Z-suffix string the LLM would misread.
      expect(job['nextRunAt']).toBe('2026-07-22T04:00:00.000-04:00');
      expect(job['createdAt']).toBe('2026-06-30T20:00:00.000-04:00');
      expect(job['nextRunAt']).not.toMatch(/Z$/);
      // Null instants stay null.
      expect(job['runAt']).toBeNull();
      expect(job['lastRunAt']).toBeNull();
      // The job's own cron zone is preserved as metadata (not an instant).
      expect(job['timezone']).toBe('America/Toronto');
      // displayTimezone depends on the real "now" for DST, so match either EST/EDT.
      expect(data.displayTimezone).toMatch(/UTC-0[45]:00/);
    }
  });

  it('marks the listing truncated and trims the extra row when more jobs exist than the limit', async () => {
    // Caller asks for limit 2 → handler fetches 3 → 3 returned → truncated, sliced to 2.
    const schedulerService = {
      createJob: vi.fn(),
      listJobs: vi.fn().mockResolvedValue([makeJob('job-1'), makeJob('job-2'), makeJob('job-3')]),
      cancelJob: vi.fn(),
    };

    const result = await handler.execute(makeCtx(
      { limit: 2 },
      { schedulerService: schedulerService as never },
    ));

    expect(schedulerService.listJobs).toHaveBeenCalledWith({
      status: undefined,
      agentId: undefined,
      limit: 3,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { jobs: unknown[]; count: number; truncated: boolean; limit: number };
      expect(data.count).toBe(2);
      expect(data.truncated).toBe(true);
      expect(data.limit).toBe(2);
    }
  });

  it('clamps an over-large limit to the maximum', async () => {
    const schedulerService = {
      createJob: vi.fn(),
      listJobs: vi.fn().mockResolvedValue([]),
      cancelJob: vi.fn(),
    };

    await handler.execute(makeCtx(
      { limit: 100000 },
      { schedulerService: schedulerService as never },
    ));

    // Max limit is 200 → fetch 201.
    expect(schedulerService.listJobs).toHaveBeenCalledWith({
      status: undefined,
      agentId: undefined,
      limit: 201,
    });
  });

  it('treats a fractional limit in (0, 1) as 1, not an always-empty page', async () => {
    const schedulerService = {
      createJob: vi.fn(),
      listJobs: vi.fn().mockResolvedValue([makeJob('job-1'), makeJob('job-2')]),
      cancelJob: vi.fn(),
    };

    const result = await handler.execute(makeCtx(
      { limit: 0.5 },
      { schedulerService: schedulerService as never },
    ));

    // effectiveLimit clamps to 1 → fetch 2 (1 + 1) to detect truncation.
    expect(schedulerService.listJobs).toHaveBeenCalledWith({
      status: undefined,
      agentId: undefined,
      limit: 2,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { count: number; truncated: boolean; limit: number };
      expect(data.limit).toBe(1);
      expect(data.count).toBe(1);
      expect(data.truncated).toBe(true);
    }
  });

  it('falls back to the default limit for a non-positive or non-numeric limit', async () => {
    const schedulerService = {
      createJob: vi.fn(),
      listJobs: vi.fn().mockResolvedValue([]),
      cancelJob: vi.fn(),
    };

    await handler.execute(makeCtx(
      { limit: -5 },
      { schedulerService: schedulerService as never },
    ));

    expect(schedulerService.listJobs).toHaveBeenCalledWith({
      status: undefined,
      agentId: undefined,
      limit: 51,
    });
  });

  it('passes status and agent_id filters to service', async () => {
    const schedulerService = {
      createJob: vi.fn(),
      listJobs: vi.fn().mockResolvedValue([]),
      cancelJob: vi.fn(),
    };

    await handler.execute(makeCtx(
      { status: 'pending', agent_id: 'coordinator' },
      { schedulerService: schedulerService as never },
    ));

    expect(schedulerService.listJobs).toHaveBeenCalledWith({
      status: 'pending',
      agentId: 'coordinator',
      limit: 51,
    });
  });

  it('returns failure when listJobs throws', async () => {
    const schedulerService = {
      createJob: vi.fn(),
      listJobs: vi.fn().mockRejectedValue(new Error('query failed')),
      cancelJob: vi.fn(),
    };

    const result = await handler.execute(makeCtx(
      {},
      { schedulerService: schedulerService as never },
    ));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('query failed');
    }
  });
});
