import { describe, it, expect, vi } from 'vitest';
import { SchedulerReportHandler } from '../../../skills/scheduler-report/handler.js';
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

describe('SchedulerReportHandler', () => {
  const handler = new SchedulerReportHandler();

  it('returns failure when schedulerService is not available', async () => {
    const result = await handler.execute(makeCtx({ job_id: 'job-1', summary: 'done' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('schedulerService');
  });

  it('returns failure when job_id is missing', async () => {
    const schedulerService = { reportJobRun: vi.fn() };
    const result = await handler.execute(makeCtx(
      { summary: 'done' },
      { schedulerService: schedulerService as never },
    ));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('job_id');
  });

  it('returns failure when summary is missing', async () => {
    const schedulerService = { reportJobRun: vi.fn() };
    const result = await handler.execute(makeCtx(
      { job_id: 'job-1' },
      { schedulerService: schedulerService as never },
    ));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('summary');
  });

  it('calls reportJobRun with summary and no context when context is omitted', async () => {
    const schedulerService = { reportJobRun: vi.fn().mockResolvedValue(undefined) };
    const result = await handler.execute(makeCtx(
      { job_id: 'job-1', summary: 'Sent 6 events' },
      { schedulerService: schedulerService as never },
    ));
    expect(result.success).toBe(true);
    expect(schedulerService.reportJobRun).toHaveBeenCalledWith('job-1', 'Sent 6 events', undefined);
  });

  it('calls reportJobRun with summary and context', async () => {
    const schedulerService = { reportJobRun: vi.fn().mockResolvedValue(undefined) };
    const ctx = { events_sent: 6 };
    const result = await handler.execute(makeCtx(
      { job_id: 'job-1', summary: 'Sent 6 events', context: ctx },
      { schedulerService: schedulerService as never },
    ));
    expect(result.success).toBe(true);
    expect(schedulerService.reportJobRun).toHaveBeenCalledWith('job-1', 'Sent 6 events', ctx);
  });

  it('returns failure when reportJobRun throws', async () => {
    const schedulerService = {
      reportJobRun: vi.fn().mockRejectedValue(new Error('job not found')),
    };
    const result = await handler.execute(makeCtx(
      { job_id: 'job-1', summary: 'Sent 6 events' },
      { schedulerService: schedulerService as never },
    ));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('job not found');
  });
});
