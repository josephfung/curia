import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import { jobRoutes } from '../../../../src/channels/http/routes/jobs.js';
import type { SchedulerService } from '../../../../src/scheduler/scheduler-service.js';
import type { JobRow } from '../../../../src/scheduler/scheduler-service.js';

/** Build a mock SchedulerService with vi.fn() stubs for every method the routes call. */
function mockSchedulerService(): SchedulerService {
  return {
    listJobs: vi.fn().mockResolvedValue([]),
    getJob: vi.fn().mockResolvedValue(null),
    createJob: vi.fn().mockResolvedValue({ jobId: 'job-1', agentTaskId: undefined }),
    cancelJob: vi.fn().mockResolvedValue(undefined),
    unsuspendJob: vi.fn().mockResolvedValue(undefined),
    updateJob: vi.fn().mockResolvedValue(undefined),
  } as unknown as SchedulerService;
}

describe('Job routes', () => {
  const scheduler = mockSchedulerService();
  const app = Fastify();

  beforeAll(async () => {
    await app.register(jobRoutes, { schedulerService: scheduler });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // -- GET /api/jobs --

  it('GET /api/jobs returns empty list', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/jobs' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual({ jobs: [] });
    expect(scheduler.listJobs).toHaveBeenCalled();
  });

  it('GET /api/jobs passes query filters to service', async () => {
    await app.inject({ method: 'GET', url: '/api/jobs?status=pending&agent_id=agent-a' });
    expect(scheduler.listJobs).toHaveBeenCalledWith({
      status: 'pending',
      agentId: 'agent-a',
    });
  });

  // -- GET /api/jobs/:id --

  it('GET /api/jobs/:id returns 404 for unknown job', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/jobs/unknown-id' });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body).toEqual({ error: 'Job not found' });
  });

  it('GET /api/jobs/:id returns the job when found', async () => {
    const fakeJob: JobRow = {
      id: 'job-42',
      agentId: 'agent-a',
      cronExpr: '0 9 * * *',
      runAt: null,
      taskPayload: { task: 'test' },
      status: 'pending',
      lastRunAt: null,
      nextRunAt: '2026-04-01T09:00:00Z',
      lastError: null,
      consecutiveFailures: 0,
      createdBy: 'api',
      createdAt: '2026-03-29T00:00:00Z',
      agentTaskId: null,
      intentAnchor: null,
      progress: null,
    };
    vi.mocked(scheduler.getJob).mockResolvedValueOnce(fakeJob);

    const response = await app.inject({ method: 'GET', url: '/api/jobs/job-42' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.job.id).toBe('job-42');
  });

  // -- POST /api/jobs --

  it('POST /api/jobs creates a job (201)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: {
        agent_id: 'agent-a',
        cron_expr: '0 9 * * *',
        task_payload: { task: 'daily-report' },
      },
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('jobId');
    expect(scheduler.createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-a',
        cronExpr: '0 9 * * *',
        createdBy: 'api',
      }),
    );
  });

  it('POST /api/jobs returns 400 when agent_id is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: {
        cron_expr: '0 9 * * *',
        task_payload: { task: 'test' },
      },
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/agent_id/);
  });

  it('POST /api/jobs returns 400 when task_payload is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: {
        agent_id: 'agent-a',
        cron_expr: '0 9 * * *',
      },
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/task_payload/);
  });

  it('POST /api/jobs returns 400 when neither cron_expr nor run_at provided', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      payload: {
        agent_id: 'agent-a',
        task_payload: { task: 'test' },
      },
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/cron_expr|run_at/);
  });

  // -- DELETE /api/jobs/:id --

  it('DELETE /api/jobs/:id cancels a job', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/api/jobs/job-99' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual({ cancelled: true, jobId: 'job-99' });
    expect(scheduler.cancelJob).toHaveBeenCalledWith('job-99');
  });

  // -- PATCH /api/jobs/:id --

  it('PATCH /api/jobs/:id unsuspends a suspended job', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/jobs/job-50',
      payload: { status: 'pending' },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual({ updated: true, jobId: 'job-50' });
    expect(scheduler.unsuspendJob).toHaveBeenCalledWith('job-50');
  });

  it('PATCH /api/jobs/:id calls updateJob for non-status changes', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/jobs/job-50',
      payload: { cron_expr: '0 12 * * *' },
    });
    expect(response.statusCode).toBe(200);
    expect(scheduler.updateJob).toHaveBeenCalledWith('job-50', {
      cronExpr: '0 12 * * *',
      runAt: undefined,
      taskPayload: undefined,
    });
  });

  it('PATCH /api/jobs/:id returns 400 on service error', async () => {
    vi.mocked(scheduler.unsuspendJob).mockRejectedValueOnce(new Error('Job job-50 not found or not suspended'));

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/jobs/job-50',
      payload: { status: 'pending' },
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/not found or not suspended/);
  });
});
