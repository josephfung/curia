import { describe, it, expect, vi } from 'vitest';
import { SchedulerUpdateHandler } from '../../../skills/scheduler-update/handler.js';
import type { SkillContext } from '../../../src/skills/types.js';

import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeCtx(
  input: Record<string, unknown>,
  overrides?: Partial<SkillContext>,
): SkillContext {
  return {
    skillName: 'scheduler-update',
    skillVersion: '0.1.0',
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    ...overrides,
  };
}

function mockSchedulerService() {
  return {
    createJob: vi.fn(),
    listJobs: vi.fn(),
    cancelJob: vi.fn(),
    unsuspendJob: vi.fn().mockResolvedValue(undefined),
    pauseJob: vi.fn().mockResolvedValue(undefined),
    updateJob: vi.fn().mockResolvedValue(undefined),
  };
}

describe('SchedulerUpdateHandler', () => {
  const handler = new SchedulerUpdateHandler();

  it('returns failure when schedulerService is not available', async () => {
    const result = await handler.execute(makeCtx({ job_id: 'job-1', action: 'resume' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('schedulerService');
    }
  });

  it('returns failure when job_id is missing', async () => {
    const svc = mockSchedulerService();
    const result = await handler.execute(makeCtx(
      { action: 'resume' },
      { schedulerService: svc as never },
    ));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('job_id');
    }
  });

  it('returns failure when action is missing or invalid', async () => {
    const svc = mockSchedulerService();

    const missing = await handler.execute(makeCtx(
      { job_id: 'job-1' },
      { schedulerService: svc as never },
    ));
    expect(missing.success).toBe(false);
    if (!missing.success) {
      expect(missing.error).toContain('action');
    }

    const invalid = await handler.execute(makeCtx(
      { job_id: 'job-1', action: 'destroy' },
      { schedulerService: svc as never },
    ));
    expect(invalid.success).toBe(false);

    // Neither invalid call should have mutated anything.
    expect(svc.unsuspendJob).not.toHaveBeenCalled();
    expect(svc.pauseJob).not.toHaveBeenCalled();
    expect(svc.updateJob).not.toHaveBeenCalled();
  });

  it('resumes a job via unsuspendJob', async () => {
    const svc = mockSchedulerService();
    const result = await handler.execute(makeCtx(
      { job_id: 'job-1', action: 'resume' },
      { schedulerService: svc as never },
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { jobId: string; action: string };
      expect(data.jobId).toBe('job-1');
      expect(data.action).toBe('resume');
    }
    expect(svc.unsuspendJob).toHaveBeenCalledWith('job-1');
    expect(svc.pauseJob).not.toHaveBeenCalled();
    expect(svc.updateJob).not.toHaveBeenCalled();
  });

  it('pauses a job via pauseJob', async () => {
    const svc = mockSchedulerService();
    const result = await handler.execute(makeCtx(
      { job_id: 'job-2', action: 'pause' },
      { schedulerService: svc as never },
    ));

    expect(result.success).toBe(true);
    expect(svc.pauseJob).toHaveBeenCalledWith('job-2');
    expect(svc.unsuspendJob).not.toHaveBeenCalled();
  });

  it('edits cron_expr via updateJob', async () => {
    const svc = mockSchedulerService();
    const result = await handler.execute(makeCtx(
      { job_id: 'job-3', action: 'edit', cron_expr: '*/10 * * * *' },
      { schedulerService: svc as never },
    ));

    expect(result.success).toBe(true);
    expect(svc.updateJob).toHaveBeenCalledWith('job-3', {
      cronExpr: '*/10 * * * *',
      runAt: undefined,
      taskPayload: undefined,
    });
  });

  it('edits run_at, converting the ISO string to a Date', async () => {
    const svc = mockSchedulerService();
    const runAt = '2026-08-01T09:00:00.000Z';
    const result = await handler.execute(makeCtx(
      { job_id: 'job-4', action: 'edit', run_at: runAt },
      { schedulerService: svc as never },
    ));

    expect(result.success).toBe(true);
    const call = svc.updateJob.mock.calls[0] as [string, { runAt?: Date }];
    expect(call[0]).toBe('job-4');
    expect(call[1].runAt).toBeInstanceOf(Date);
    expect(call[1].runAt!.toISOString()).toBe(runAt);
  });

  it('rejects action=edit with a malformed run_at before hitting the service', async () => {
    const svc = mockSchedulerService();
    const result = await handler.execute(makeCtx(
      { job_id: 'job-bad', action: 'edit', run_at: 'not-a-date' },
      { schedulerService: svc as never },
    ));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('valid ISO 8601 timestamp');
    }
    // Must not reach the DB with an Invalid Date.
    expect(svc.updateJob).not.toHaveBeenCalled();
  });

  it('rejects action=edit with no editable field supplied', async () => {
    const svc = mockSchedulerService();
    const result = await handler.execute(makeCtx(
      { job_id: 'job-5', action: 'edit' },
      { schedulerService: svc as never },
    ));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('cron_expr');
    }
    expect(svc.updateJob).not.toHaveBeenCalled();
  });

  it('treats whitespace-only schedule strings as absent', async () => {
    const svc = mockSchedulerService();
    const result = await handler.execute(makeCtx(
      { job_id: 'job-6', action: 'edit', cron_expr: '   ', run_at: '  ' },
      { schedulerService: svc as never },
    ));

    // No real edit field remains after trimming → reject rather than call updateJob.
    expect(result.success).toBe(false);
    expect(svc.updateJob).not.toHaveBeenCalled();
  });

  it('returns failure when the service throws', async () => {
    const svc = mockSchedulerService();
    svc.unsuspendJob.mockRejectedValue(new Error('Job x not found or not suspended'));

    const result = await handler.execute(makeCtx(
      { job_id: 'nonexistent', action: 'resume' },
      { schedulerService: svc as never },
    ));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('not found or not suspended');
    }
  });

  it('surfaces a pause failure (e.g. missing/terminal job) as success:false', async () => {
    const svc = mockSchedulerService();
    svc.pauseJob.mockRejectedValue(new Error('Job gone not found or already cancelled/completed'));

    const result = await handler.execute(makeCtx(
      { job_id: 'gone', action: 'pause' },
      { schedulerService: svc as never },
    ));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('not found or already cancelled/completed');
    }
  });

  it('surfaces an edit failure on a missing job as success:false', async () => {
    const svc = mockSchedulerService();
    svc.updateJob.mockRejectedValue(new Error('Job gone not found'));

    const result = await handler.execute(makeCtx(
      { job_id: 'gone', action: 'edit', cron_expr: '*/10 * * * *' },
      { schedulerService: svc as never },
    ));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('not found');
    }
  });
});
