import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchedulerService } from '../../../src/scheduler/scheduler-service.js';
import type { CreateJobParams } from '../../../src/scheduler/scheduler-service.js';

// -- Mock helpers --

function mockPool() {
  return { query: vi.fn() };
}

function mockBus() {
  return { publish: vi.fn() };
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

describe('SchedulerService', () => {
  let pool: ReturnType<typeof mockPool>;
  let bus: ReturnType<typeof mockBus>;
  let logger: ReturnType<typeof mockLogger>;
  let svc: SchedulerService;

  beforeEach(() => {
    pool = mockPool();
    bus = mockBus();
    logger = mockLogger();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    svc = new SchedulerService(pool as any, bus as any, logger as any);
  });

  // -- nextRunFromCron --

  describe('nextRunFromCron', () => {
    it('returns a future Date for a valid cron expression', () => {
      const result = svc.nextRunFromCron('*/5 * * * *');
      expect(result).toBeInstanceOf(Date);
      expect(result.getTime()).toBeGreaterThan(Date.now());
    });

    it('throws for an invalid cron expression', () => {
      expect(() => svc.nextRunFromCron('not-a-cron')).toThrow();
    });
  });

  // -- createJob --

  describe('createJob', () => {
    it('creates a cron job and publishes schedule.created', async () => {
      const jobId = 'job-111';
      pool.query.mockResolvedValueOnce({ rows: [{ id: jobId }] });

      const params: CreateJobParams = {
        agentId: 'agent-1',
        cronExpr: '0 9 * * *',
        taskPayload: { skill: 'morning-brief' },
        createdBy: 'ceo',
      };
      const result = await svc.createJob(params);

      expect(result.jobId).toBe(jobId);
      expect(result.agentTaskId).toBeUndefined();

      // Verify the INSERT used parameterized query
      const [sql, sqlParams] = pool.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('INSERT INTO scheduled_jobs');
      expect(sqlParams).toContain('agent-1');

      // Verify bus event was published
      expect(bus.publish).toHaveBeenCalledOnce();
      const [layer, event] = bus.publish.mock.calls[0] as [string, { type: string }];
      expect(layer).toBe('system');
      expect(event.type).toBe('schedule.created');
    });

    it('creates a one-shot job with runAt', async () => {
      const jobId = 'job-222';
      pool.query.mockResolvedValueOnce({ rows: [{ id: jobId }] });

      const runAt = new Date('2030-01-01T00:00:00Z');
      const params: CreateJobParams = {
        agentId: 'agent-2',
        runAt,
        taskPayload: { action: 'one-time' },
        createdBy: 'admin',
      };
      const result = await svc.createJob(params);

      expect(result.jobId).toBe(jobId);
      // runAt should appear in the query params
      const sqlParams = pool.query.mock.calls[0]?.[1] as unknown[];
      expect(sqlParams).toContain(runAt);
    });

    it('creates a persistent task when intentAnchor is provided', async () => {
      const jobId = 'job-333';
      const taskId = 'task-aaa';
      // First call: INSERT into scheduled_jobs
      pool.query.mockResolvedValueOnce({ rows: [{ id: jobId }] });
      // Second call: INSERT into agent_tasks
      pool.query.mockResolvedValueOnce({ rows: [{ id: taskId }] });

      const params: CreateJobParams = {
        agentId: 'agent-3',
        cronExpr: '0 */6 * * *',
        taskPayload: { skill: 'report' },
        createdBy: 'system',
        intentAnchor: 'weekly-report',
        errorBudget: { maxRetries: 5 },
      };
      const result = await svc.createJob(params);

      expect(result.jobId).toBe(jobId);
      expect(result.agentTaskId).toBe(taskId);

      // Two queries: job insert + task insert
      expect(pool.query).toHaveBeenCalledTimes(2);
      const taskSql = pool.query.mock.calls[1]?.[0] as string;
      expect(taskSql).toContain('INSERT INTO agent_tasks');
    });

    it('rejects when neither cronExpr nor runAt is provided', async () => {
      const params: CreateJobParams = {
        agentId: 'agent-4',
        taskPayload: { foo: 'bar' },
        createdBy: 'user',
      };
      await expect(svc.createJob(params)).rejects.toThrow(
        /cronExpr or runAt/,
      );
    });
  });

  // -- cancelJob --

  describe('cancelJob', () => {
    it('updates the job status to cancelled', async () => {
      pool.query.mockResolvedValue({ rows: [] });

      await svc.cancelJob('job-cancel');

      const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('status');
      expect(params).toContain('cancelled');
      expect(params).toContain('job-cancel');
    });

    it('also cancels the linked agent_task', async () => {
      pool.query.mockResolvedValue({ rows: [] });

      await svc.cancelJob('job-cancel');

      // Second query should update agent_tasks
      expect(pool.query).toHaveBeenCalledTimes(2);
      const [sql2] = pool.query.mock.calls[1] as [string, unknown[]];
      expect(sql2).toContain('agent_tasks');
      expect(sql2).toContain('cancelled');
    });
  });

  // -- unsuspendJob --

  describe('unsuspendJob', () => {
    it('fetches the job, recalculates next_run_at, and resets status', async () => {
      // First query: fetch the suspended job
      pool.query.mockResolvedValueOnce({
        rows: [{ cron_expr: '0 9 * * 1', run_at: null }],
      });
      // Second query: the UPDATE
      pool.query.mockResolvedValueOnce({ rows: [] });

      await svc.unsuspendJob('job-unsuspend');

      expect(pool.query).toHaveBeenCalledTimes(2);
      // First call fetches the job
      const [sql1] = pool.query.mock.calls[0] as [string, unknown[]];
      expect(sql1).toContain('suspended');
      // Second call updates with recalculated next_run_at
      const [sql2, params2] = pool.query.mock.calls[1] as [string, unknown[]];
      expect(sql2).toContain('next_run_at');
      expect(sql2).toContain('pending');
      expect(params2[0]).toBe('job-unsuspend');
      // params2[1] should be a Date (the recalculated next_run_at)
      expect(params2[1]).toBeInstanceOf(Date);
    });

    it('throws when job is not found or not suspended', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await expect(svc.unsuspendJob('nonexistent')).rejects.toThrow('not found or not suspended');
    });
  });

  // -- listJobs --

  describe('listJobs', () => {
    it('lists all jobs when no filters are provided', async () => {
      const fakeRows = [
        {
          id: 'job-1',
          agent_id: 'a1',
          cron_expr: '* * * * *',
          run_at: null,
          task_payload: { x: 1 },
          status: 'pending',
          last_run_at: null,
          next_run_at: new Date().toISOString(),
          last_error: null,
          consecutive_failures: 0,
          created_by: 'system',
          created_at: new Date().toISOString(),
          agent_task_id: null,
          intent_anchor: null,
          progress: null,
        },
      ];
      pool.query.mockResolvedValueOnce({ rows: fakeRows });

      const jobs = await svc.listJobs();

      expect(jobs).toHaveLength(1);
      // Verify camelCase mapping
      expect(jobs[0]?.agentId).toBe('a1');
      expect(jobs[0]?.cronExpr).toBe('* * * * *');
      expect(jobs[0]?.taskPayload).toEqual({ x: 1 });
    });

    it('filters by status when provided', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await svc.listJobs({ status: 'suspended' });

      const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('status');
      expect(params).toContain('suspended');
    });

    it('filters by agentId when provided', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await svc.listJobs({ agentId: 'agent-x' });

      const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('agent_id');
      expect(params).toContain('agent-x');
    });
  });

  // -- getJob --

  describe('getJob', () => {
    it('returns null when the job does not exist', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await svc.getJob('nonexistent');

      expect(result).toBeNull();
    });

    it('returns the mapped job row when found', async () => {
      const row = {
        id: 'job-found',
        agent_id: 'a1',
        cron_expr: null,
        run_at: '2030-01-01T00:00:00Z',
        task_payload: {},
        status: 'pending',
        last_run_at: null,
        next_run_at: '2030-01-01T00:00:00Z',
        last_error: null,
        consecutive_failures: 0,
        created_by: 'admin',
        created_at: '2025-01-01T00:00:00Z',
        agent_task_id: 'task-1',
        intent_anchor: 'anchor',
        progress: { step: 2 },
      };
      pool.query.mockResolvedValueOnce({ rows: [row] });

      const result = await svc.getJob('job-found');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('job-found');
      expect(result?.agentTaskId).toBe('task-1');
      expect(result?.intentAnchor).toBe('anchor');
      expect(result?.progress).toEqual({ step: 2 });
    });
  });

  // -- completeJobRun --

  describe('completeJobRun', () => {
    it('marks one-shot job as completed on success', async () => {
      // First query: fetch the job to determine type
      pool.query.mockResolvedValueOnce({
        rows: [{ id: 'job-os', cron_expr: null, status: 'pending', consecutive_failures: 0 }],
      });
      // Second query: update status to completed
      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await svc.completeJobRun('job-os', true);

      expect(result.suspended).toBe(false);
      const [, params] = pool.query.mock.calls[1] as [string, unknown[]];
      expect(params).toContain('completed');
    });

    it('updates next_run_at for recurring job on success', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ id: 'job-rec', cron_expr: '0 9 * * *', status: 'pending', consecutive_failures: 0 }],
      });
      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await svc.completeJobRun('job-rec', true);

      expect(result.suspended).toBe(false);
      const [sql] = pool.query.mock.calls[1] as [string];
      expect(sql).toContain('next_run_at');
    });

    it('increments failures on error and auto-suspends at 3', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ id: 'job-fail', cron_expr: '0 9 * * *', status: 'pending', consecutive_failures: 2 }],
      });
      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await svc.completeJobRun('job-fail', false, 'boom');

      expect(result.suspended).toBe(true);
      const [, params] = pool.query.mock.calls[1] as [string, unknown[]];
      expect(params).toContain('suspended');
    });

    it('increments failures without suspending when under threshold', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ id: 'job-f1', cron_expr: '0 9 * * *', status: 'pending', consecutive_failures: 0 }],
      });
      pool.query.mockResolvedValueOnce({ rows: [] });

      const result = await svc.completeJobRun('job-f1', false, 'oops');

      expect(result.suspended).toBe(false);
    });

    it('clears run_started_at on success for a recurring job', async () => {
      pool.query
        .mockResolvedValueOnce({
          rows: [{ id: 'job-1', cron_expr: '0 9 * * *', status: 'running', consecutive_failures: 0, timezone: 'UTC' }],
        })
        .mockResolvedValueOnce({ rows: [] }); // UPDATE

      await svc.completeJobRun('job-1', true);

      const [updateSql] = pool.query.mock.calls[1] as [string, unknown[]];
      expect(updateSql).toContain('run_started_at = NULL');
    });

    it('clears run_started_at on failure', async () => {
      pool.query
        .mockResolvedValueOnce({
          rows: [{ id: 'job-1', cron_expr: '0 9 * * *', status: 'running', consecutive_failures: 0, timezone: 'UTC' }],
        })
        .mockResolvedValueOnce({ rows: [] }); // UPDATE

      await svc.completeJobRun('job-1', false, 'some error');

      const [updateSql] = pool.query.mock.calls[1] as [string, unknown[]];
      expect(updateSql).toContain('run_started_at = NULL');
    });
  });

  // -- upsertDeclarativeJob --

  describe('upsertDeclarativeJob', () => {
    it('upserts using ON CONFLICT and returns the job id', async () => {
      pool.query.mockResolvedValueOnce({ rows: [{ id: 'job-decl' }] });

      const id = await svc.upsertDeclarativeJob('agent-1', {
        cron: '0 8 * * 1',
        task: 'weekly-standup',
      });

      expect(id).toBe('job-decl');
      const [sql] = pool.query.mock.calls[0] as [string];
      expect(sql).toContain('ON CONFLICT');
      expect(sql).toContain('scheduled_jobs_declarative_uq');
    });
  });

  // -- updateJob --

  describe('updateJob', () => {
    it('updates cronExpr and recalculates next_run_at', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await svc.updateJob('job-up', { cronExpr: '*/10 * * * *' });

      const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('cron_expr');
      expect(sql).toContain('next_run_at');
      expect(params).toContain('job-up');
    });

    it('updates taskPayload only', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await svc.updateJob('job-up2', { taskPayload: { a: 1 } });

      const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('task_payload');
      expect(params).toContain('job-up2');
    });
  });
});
