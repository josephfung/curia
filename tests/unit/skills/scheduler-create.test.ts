import { describe, it, expect, vi } from 'vitest';
import { SchedulerCreateHandler } from '../../../skills/scheduler-create/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';

import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(
  input: Record<string, unknown>,
  overrides?: Partial<SkillContext>,
): SkillContext {
  return {
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    ...overrides,
  };
}

describe('SchedulerCreateHandler', () => {
  const handler = new SchedulerCreateHandler();

  it('returns failure when schedulerService is not available', async () => {
    const result = await handler.execute(makeCtx({ task: 'do something', cron_expr: '0 9 * * *' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('schedulerService');
    }
  });

  it('returns failure when task is missing', async () => {
    const schedulerService = { createJob: vi.fn(), listJobs: vi.fn(), cancelJob: vi.fn() };
    const result = await handler.execute(makeCtx(
      { cron_expr: '0 9 * * *' },
      { schedulerService: schedulerService as never },
    ));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('task');
    }
  });

  it('returns failure when neither cron_expr nor run_at is provided', async () => {
    const schedulerService = { createJob: vi.fn(), listJobs: vi.fn(), cancelJob: vi.fn() };
    const result = await handler.execute(makeCtx(
      { task: 'do something' },
      { schedulerService: schedulerService as never },
    ));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('cron_expr');
    }
  });

  it('creates a cron job successfully', async () => {
    const createResult = { jobId: 'job-1' };
    const schedulerService = {
      createJob: vi.fn().mockResolvedValue(createResult),
      listJobs: vi.fn(),
      cancelJob: vi.fn(),
    };

    const result = await handler.execute(makeCtx(
      { task: 'daily standup reminder', cron_expr: '0 9 * * *' },
      { schedulerService: schedulerService as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(createResult);
    }

    expect(schedulerService.createJob).toHaveBeenCalledWith({
      agentId: 'coordinator',
      cronExpr: '0 9 * * *',
      runAt: undefined,
      taskPayload: { task: 'daily standup reminder' },
      createdBy: 'coordinator',
      intentAnchor: undefined,
      errorBudget: undefined,
    });
  });

  it('creates a one-shot job with run_at', async () => {
    const createResult = { jobId: 'job-2' };
    const schedulerService = {
      createJob: vi.fn().mockResolvedValue(createResult),
      listJobs: vi.fn(),
      cancelJob: vi.fn(),
    };

    const runAt = '2026-04-01T09:00:00Z';
    const result = await handler.execute(makeCtx(
      { task: 'send report', run_at: runAt, agent_id: 'research-analyst' },
      { schedulerService: schedulerService as never },
    ));

    expect(result.success).toBe(true);
    expect(schedulerService.createJob).toHaveBeenCalledWith({
      agentId: 'research-analyst',
      cronExpr: undefined,
      runAt: new Date(runAt),
      taskPayload: { task: 'send report' },
      createdBy: 'research-analyst',
      intentAnchor: undefined,
      errorBudget: undefined,
    });
  });

  it('creates a persistent task with intent_anchor', async () => {
    const createResult = { jobId: 'job-3', agentTaskId: 'at-1' };
    const schedulerService = {
      createJob: vi.fn().mockResolvedValue(createResult),
      listJobs: vi.fn(),
      cancelJob: vi.fn(),
    };

    const result = await handler.execute(makeCtx(
      {
        task: 'weekly report',
        cron_expr: '0 9 * * 1',
        intent_anchor: 'weekly-report-v1',
        error_budget: { maxRetries: 3 },
      },
      { schedulerService: schedulerService as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { jobId: string; agentTaskId?: string };
      expect(data.agentTaskId).toBe('at-1');
    }

    expect(schedulerService.createJob).toHaveBeenCalledWith({
      agentId: 'coordinator',
      cronExpr: '0 9 * * 1',
      runAt: undefined,
      taskPayload: { task: 'weekly report' },
      createdBy: 'coordinator',
      intentAnchor: 'weekly-report-v1',
      errorBudget: { maxRetries: 3 },
    });
  });

  it('returns failure when createJob throws', async () => {
    const schedulerService = {
      createJob: vi.fn().mockRejectedValue(new Error('DB connection lost')),
      listJobs: vi.fn(),
      cancelJob: vi.fn(),
    };

    const result = await handler.execute(makeCtx(
      { task: 'do something', cron_expr: '0 9 * * *' },
      { schedulerService: schedulerService as never },
    ));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('DB connection lost');
    }
  });
});
