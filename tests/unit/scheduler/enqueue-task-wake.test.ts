import { describe, it, expect, vi } from 'vitest';
import { SchedulerService } from '../../../src/scheduler/scheduler-service.js';

function mockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() };
}

describe('SchedulerService.enqueueTaskWake', () => {
  it('revives the task\'s existing terminal wake row when one exists (#1410)', async () => {
    // First query (the revive UPDATE) returns a row → short-circuit, no INSERT.
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
    expect(pool.query).toHaveBeenCalledTimes(1); // reuse short-circuits before the insert
    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE scheduled_jobs/i); // revives the row, not a fresh insert
    expect(sql).toMatch(/task_id/);
    expect(params).toContain('task-7');
    expect(params).toContain('ceo-inbox');
    expect(params).toContain(runAt);
  });

  it('inserts a one-shot pending row when there is no terminal wake to reuse (#1410)', async () => {
    // Revive returns no row → fall through to the INSERT path.
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })              // revive: nothing to reuse
        .mockResolvedValueOnce({ rows: [{ id: 'job-new' }] }), // insert
    };
    const bus = { publish: vi.fn(), subscribe: vi.fn() };
    const svc = new SchedulerService(
      pool as unknown as import('pg').Pool,
      bus as never,
      mockLogger() as never,
      'America/Toronto',
    );

    const runAt = new Date('2026-06-04T12:00:00Z');
    const result = await svc.enqueueTaskWake({ taskId: 'task-7', agentId: 'ceo-inbox', runAt });

    expect(result.jobId).toBe('job-new');
    expect(pool.query).toHaveBeenCalledTimes(2);
    const [insertSql, params] = pool.query.mock.calls[1] as [string, unknown[]];
    expect(insertSql).toMatch(/INSERT INTO scheduled_jobs/i);
    expect(insertSql).toMatch(/task_id/);
    // status pending, one-shot (cron NULL), task_id = the EXISTING task
    expect(params).toContain('task-7');
    expect(params).toContain('ceo-inbox');
    expect(params).toContain(runAt);
  });

  it('persists the lineage originator and the derived flag onto the wake (#1125)', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'job-1' }] }) };
    const bus = { publish: vi.fn(), subscribe: vi.fn() };
    const svc = new SchedulerService(
      pool as unknown as import('pg').Pool,
      bus as never,
      mockLogger() as never,
      'America/Toronto',
    );

    const originator = {
      contactId: 'ceo', systemRole: 'principal' as const, channel: 'email',
      initiatedAt: '2026-06-23T00:00:00.000Z', tier: 'principal' as const,
    };
    await svc.enqueueTaskWake({
      taskId: 'task-7', agentId: 'coordinator', runAt: new Date('2026-06-04T12:00:00Z'),
      originator, derived: true,
    });

    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    // originator column is written...
    expect(sql).toMatch(/originator/);
    expect(params).toContain(JSON.stringify(originator));
    // ...and the derived flag rides in the task_payload.standing envelope.
    const payload = params.find(
      (p): p is string => typeof p === 'string' && p.includes('task-wake'),
    );
    expect(payload).toBeDefined();
    expect(JSON.parse(payload!)).toMatchObject({ type: 'task-wake', task_id: 'task-7', standing: { derived: true } });
  });

  it('defaults to null originator and derived=false when not supplied (conservative)', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'job-2' }] }) };
    const bus = { publish: vi.fn(), subscribe: vi.fn() };
    const svc = new SchedulerService(
      pool as unknown as import('pg').Pool,
      bus as never,
      mockLogger() as never,
      'America/Toronto',
    );

    await svc.enqueueTaskWake({ taskId: 'task-7', agentId: 'coordinator', runAt: new Date('2026-06-04T12:00:00Z') });

    const [, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(params).toContain(null); // originator param is null
    const payload = params.find(
      (p): p is string => typeof p === 'string' && p.includes('task-wake'),
    );
    expect(JSON.parse(payload!)).toMatchObject({ standing: { derived: false } });
  });
});
