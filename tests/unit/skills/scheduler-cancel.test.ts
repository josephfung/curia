import { describe, it, expect, vi } from 'vitest';
import { SchedulerCancelHandler } from '../../../skills/scheduler-cancel/handler.js';
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

describe('SchedulerCancelHandler', () => {
  const handler = new SchedulerCancelHandler();

  it('returns failure when schedulerService is not available', async () => {
    const result = await handler.execute(makeCtx({ job_id: 'job-1' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('schedulerService');
    }
  });

  it('returns failure when job_id is missing', async () => {
    const schedulerService = {
      createJob: vi.fn(),
      listJobs: vi.fn(),
      cancelJob: vi.fn(),
    };

    const result = await handler.execute(makeCtx(
      {},
      { schedulerService: schedulerService as never },
    ));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('job_id');
    }
  });

  it('cancels a job successfully', async () => {
    const schedulerService = {
      createJob: vi.fn(),
      listJobs: vi.fn(),
      cancelJob: vi.fn().mockResolvedValue(undefined),
    };

    const result = await handler.execute(makeCtx(
      { job_id: 'job-1' },
      { schedulerService: schedulerService as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { cancelled: boolean; jobId: string };
      expect(data.cancelled).toBe(true);
      expect(data.jobId).toBe('job-1');
    }

    expect(schedulerService.cancelJob).toHaveBeenCalledWith('job-1');
  });

  it('returns failure when cancelJob throws', async () => {
    const schedulerService = {
      createJob: vi.fn(),
      listJobs: vi.fn(),
      cancelJob: vi.fn().mockRejectedValue(new Error('job not found')),
    };

    const result = await handler.execute(makeCtx(
      { job_id: 'nonexistent' },
      { schedulerService: schedulerService as never },
    ));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('job not found');
    }
  });
});
