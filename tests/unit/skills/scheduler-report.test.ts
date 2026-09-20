import { describe, it, expect, vi } from 'vitest';
import {
  SchedulerReportHandler,
  resolveSchedulerReportJobId,
} from '../../../skills/scheduler/tools/scheduler-report/handler.js';
import type { ToolContext } from '../../../src/skills/types.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

const JOB_A = '123e4567-e89b-12d3-a456-426614174000';
const JOB_B = '223e4567-e89b-12d3-a456-426614174001';
const RUN_CONV = `scheduler:${JOB_A}:run-001`;

function makeCtx(
  input: Record<string, unknown>,
  overrides?: Partial<ToolContext>,
): ToolContext {
  return {
    toolName: 'scheduler-report',
    toolVersion: '1.2.0',
    input,
    secret: () => { throw new Error('no secrets'); },
    log: logger,
    ...overrides,
  };
}

describe('resolveSchedulerReportJobId (#1828)', () => {
  it('derives job_id from a scheduler run conversation when input is omitted', () => {
    const resolved = resolveSchedulerReportJobId(undefined, RUN_CONV);
    expect(resolved).toEqual({ ok: true, jobId: JOB_A });
  });

  it('accepts an explicit job_id that matches the run context', () => {
    const resolved = resolveSchedulerReportJobId(JOB_A, RUN_CONV);
    expect(resolved).toEqual({ ok: true, jobId: JOB_A });
  });

  it('rejects an explicit job_id that disagrees with the run context', () => {
    const resolved = resolveSchedulerReportJobId(JOB_B, RUN_CONV);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error).toContain(JOB_B);
      expect(resolved.error).toContain(JOB_A);
      expect(resolved.error).toMatch(/does not match/i);
    }
  });

  it('falls back to an explicit job_id outside a scheduler conversation', () => {
    const resolved = resolveSchedulerReportJobId(JOB_A, 'delegate-sub-run-xyz');
    expect(resolved).toEqual({ ok: true, jobId: JOB_A });
  });

  it('fails when neither input nor a derivable conversation id is present', () => {
    const resolved = resolveSchedulerReportJobId(undefined, 'signal:+15551234567');
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toMatch(/Missing job_id/);
  });
});

describe('SchedulerReportHandler', () => {
  const handler = new SchedulerReportHandler();

  it('returns failure when schedulerService is not available', async () => {
    const result = await handler.execute(makeCtx({ job_id: 'job-1', summary: 'done' }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('schedulerService');
  });

  it('derives job_id from conversationId when omitted (#1828)', async () => {
    const schedulerService = { reportJobRun: vi.fn().mockResolvedValue(undefined) };
    const result = await handler.execute(makeCtx(
      { summary: 'holds-sweep: expired 2' },
      {
        schedulerService: schedulerService as never,
        conversationId: RUN_CONV,
      },
    ));
    expect(result.success).toBe(true);
    expect(schedulerService.reportJobRun).toHaveBeenCalledWith(
      JOB_A,
      'holds-sweep: expired 2',
      undefined,
    );
  });

  it('rejects a mismatched job_id and writes nothing (#1828)', async () => {
    const schedulerService = { reportJobRun: vi.fn().mockResolvedValue(undefined) };
    const result = await handler.execute(makeCtx(
      { job_id: JOB_B, summary: 'should not write' },
      {
        schedulerService: schedulerService as never,
        conversationId: RUN_CONV,
      },
    ));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/does not match/);
    expect(schedulerService.reportJobRun).not.toHaveBeenCalled();
  });

  it('accepts an explicit job_id outside a scheduler conversation (#1828)', async () => {
    const schedulerService = { reportJobRun: vi.fn().mockResolvedValue(undefined) };
    const result = await handler.execute(makeCtx(
      { job_id: JOB_A, summary: 'late wake report' },
      {
        schedulerService: schedulerService as never,
        conversationId: 'delegate-wake-abc',
      },
    ));
    expect(result.success).toBe(true);
    expect(schedulerService.reportJobRun).toHaveBeenCalledWith(
      JOB_A,
      'late wake report',
      undefined,
    );
  });

  it('returns failure when job_id cannot be derived or supplied', async () => {
    const schedulerService = { reportJobRun: vi.fn() };
    const result = await handler.execute(makeCtx(
      { summary: 'done' },
      { schedulerService: schedulerService as never },
    ));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('job_id');
    expect(schedulerService.reportJobRun).not.toHaveBeenCalled();
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
