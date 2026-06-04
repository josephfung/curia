import { describe, it, expect, vi } from 'vitest';
import { SchedulerService } from '../../../src/scheduler/scheduler-service.js';

function mockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() };
}

describe('SchedulerService.enqueueTaskWake', () => {
  it('inserts a one-shot pending scheduled_jobs row carrying the existing task_id', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'job-9' }] }) };
    const bus = { publish: vi.fn(), subscribe: vi.fn() };
    const svc = new SchedulerService(
      pool as unknown as import('pg').Pool,
      bus as never,
      mockLogger() as never,
      'America/Toronto',
    );

    const runAt = new Date('2026-06-04T12:00:00Z');
    const result = await svc.enqueueTaskWake({ taskId: 'task-7', agentId: 'ceo-inbox', runAt });

    expect(result.jobId).toBe('job-9');
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO scheduled_jobs/i);
    expect(sql).toMatch(/task_id/);
    // status pending, one-shot (cron NULL), task_id = the EXISTING task
    expect(params).toContain('task-7');
    expect(params).toContain('ceo-inbox');
    expect(params).toContain(runAt);
  });
});
