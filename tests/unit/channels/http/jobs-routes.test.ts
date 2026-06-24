import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { jobRoutes } from '../../../../src/channels/http/routes/jobs.js';
import type { SchedulerService } from '../../../../src/scheduler/scheduler-service.js';
import type { JobRow } from '../../../../src/scheduler/scheduler-service.js';
import type { SessionStore } from '../../../../src/channels/http/session-auth.js';
import type { ContactService } from '../../../../src/contacts/contact-service.js';
import type { Logger } from '../../../../src/logger.js';

// Shared bootstrap secret used across all tests.
const TEST_SECRET = 'test-bootstrap-secret';
// Auth header included in every inject call so assertSecret passes.
const AUTH = { 'x-web-bootstrap-secret': TEST_SECRET };
// The principal contact resolveConsoleOriginator() looks up to stamp lineage (#1127).
const PRINCIPAL_CONTACT_ID = 'contact-principal';

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

/** Minimal ContactService stub: resolves the principal so jobs get principal lineage. */
function mockContactService(): ContactService {
  return {
    findContactBySystemRole: vi.fn().mockResolvedValue({ id: PRINCIPAL_CONTACT_ID }),
  } as unknown as ContactService;
}

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

describe('Job routes', () => {
  const scheduler = mockSchedulerService();
  const contactService = mockContactService();
  const sessions: SessionStore = new Map();
  const app = Fastify();

  beforeAll(async () => {
    // cookie plugin required by assertSecret's session-cookie path
    await app.register(cookie);
    await app.register(jobRoutes, {
      schedulerService: scheduler,
      webAppBootstrapSecret: TEST_SECRET,
      sessions,
      contactService,
      logger: mockLogger,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // -- GET /api/jobs --

  it('GET /api/jobs returns empty list', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/jobs', headers: AUTH });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual({ jobs: [] });
    expect(scheduler.listJobs).toHaveBeenCalled();
  });

  it('GET /api/jobs passes query filters to service', async () => {
    await app.inject({ method: 'GET', url: '/api/jobs?status=pending&agent_id=agent-a', headers: AUTH });
    expect(scheduler.listJobs).toHaveBeenCalledWith({
      status: 'pending',
      agentId: 'agent-a',
    });
  });

  it('GET /api/jobs returns 401 without auth', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/jobs' });
    expect(response.statusCode).toBe(401);
  });

  // -- GET /api/jobs/:id --

  it('GET /api/jobs/:id returns 404 for unknown job', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/jobs/unknown-id', headers: AUTH });
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
      timezone: 'UTC',
      agentTaskId: null,
      intentAnchor: null,
      progress: null,
      taskTitle: null,
      runStartedAt: null,
      expectedDurationSeconds: null,
      lastRunOutcome: null,
      lastRunSummary: null,
      lastRunContext: null,
      originator: null,
    };
    vi.mocked(scheduler.getJob).mockResolvedValueOnce(fakeJob);

    const response = await app.inject({ method: 'GET', url: '/api/jobs/job-42', headers: AUTH });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.job.id).toBe('job-42');
  });

  // -- POST /api/jobs --

  it('POST /api/jobs creates a job (201)', async () => {
    // Route calls getJob() after createJob() to return the full job row.
    const createdJob: JobRow = {
      id: 'job-1',
      agentId: 'agent-a',
      cronExpr: '0 9 * * *',
      runAt: null,
      taskPayload: { task: 'daily-report' },
      status: 'pending',
      lastRunAt: null,
      nextRunAt: '2026-04-01T09:00:00Z',
      lastError: null,
      consecutiveFailures: 0,
      createdBy: 'api',
      createdAt: '2026-03-29T00:00:00Z',
      timezone: 'UTC',
      agentTaskId: null,
      intentAnchor: null,
      progress: null,
      taskTitle: null,
      runStartedAt: null,
      expectedDurationSeconds: null,
      lastRunOutcome: null,
      lastRunSummary: null,
      lastRunContext: null,
      originator: null,
    };
    vi.mocked(scheduler.getJob).mockResolvedValueOnce(createdJob);

    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: AUTH,
      payload: {
        agent_id: 'agent-a',
        cron_expr: '0 9 * * *',
        task_payload: { task: 'daily-report' },
      },
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('job');
    expect(body.job.id).toBe('job-1');
    expect(scheduler.createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-a',
        cronExpr: '0 9 * * *',
        createdBy: 'api',
      }),
    );
  });

  it('POST /api/jobs stamps a principal TaskOriginator (#1127)', async () => {
    // Stub createJob to return the SAME id the read-back resolves, so the test can't pass with a
    // mismatched row id (CodeRabbit) — the route must read back / log the id createJob returned.
    vi.mocked(scheduler.createJob).mockResolvedValueOnce({ jobId: 'job-2', agentTaskId: undefined });
    const createdJob = {
      id: 'job-2',
      agentId: 'agent-a',
      originator: null,
    } as unknown as JobRow;
    vi.mocked(scheduler.getJob).mockResolvedValueOnce(createdJob);

    await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: AUTH,
      payload: {
        agent_id: 'agent-a',
        cron_expr: '0 9 * * *',
        task_payload: { task: 'daily-report' },
      },
    });

    // The console is a CEO-only surface, so the job must carry principal lineage.
    expect(contactService.findContactBySystemRole).toHaveBeenCalledWith('principal');
    expect(scheduler.createJob).toHaveBeenLastCalledWith(
      expect.objectContaining({
        originator: expect.objectContaining({
          contactId: PRINCIPAL_CONTACT_ID,
          systemRole: 'principal',
          channel: 'console',
          tier: 'principal',
        }),
      }),
    );
    expect(scheduler.getJob).toHaveBeenCalledWith('job-2');
  });

  it('POST /api/jobs falls back to no originator when no principal exists (#1127)', async () => {
    // Fresh-install case: no principal contact yet → conservative null lineage, no failure.
    vi.mocked(contactService.findContactBySystemRole).mockResolvedValueOnce(null);
    // createJob and getJob share the same id so the correlation assertion is meaningful.
    vi.mocked(scheduler.createJob).mockResolvedValueOnce({ jobId: 'job-3', agentTaskId: undefined });
    const createdJob = { id: 'job-3', agentId: 'agent-a', originator: null } as unknown as JobRow;
    vi.mocked(scheduler.getJob).mockResolvedValueOnce(createdJob);

    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: AUTH,
      payload: {
        agent_id: 'agent-a',
        cron_expr: '0 9 * * *',
        task_payload: { task: 'daily-report' },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(scheduler.createJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ originator: undefined }),
    );
    // The dropped lineage must be observable with the job id createJob returned, so the later
    // propose-only consequence is correlatable back to creation (#1127 observability).
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-3', channel: 'console' }),
      expect.stringContaining('WITHOUT principal lineage'),
    );
    expect(scheduler.getJob).toHaveBeenCalledWith('job-3');
  });

  it('POST /api/jobs returns 400 when agent_id is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: AUTH,
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
      headers: AUTH,
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
      headers: AUTH,
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
    const response = await app.inject({ method: 'DELETE', url: '/api/jobs/job-99', headers: AUTH });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual({ cancelled: true, jobId: 'job-99' });
    expect(scheduler.cancelJob).toHaveBeenCalledWith('job-99');
  });

  // -- PATCH /api/jobs/:id --

  // Reusable job stub for PATCH tests — routes now call getJob() for existence
  // checks and post-mutation read-backs, so we need a non-null mock return.
  const patchJob: JobRow = {
    id: 'job-50',
    agentId: 'agent-b',
    cronExpr: '0 9 * * *',
    runAt: null,
    taskPayload: { task: 'test' },
    status: 'suspended',
    lastRunAt: null,
    nextRunAt: null,
    lastError: null,
    consecutiveFailures: 0,
    createdBy: 'api',
    createdAt: '2026-03-29T00:00:00Z',
    timezone: 'UTC',
    agentTaskId: null,
    intentAnchor: null,
    progress: null,
    taskTitle: null,
    runStartedAt: null,
    expectedDurationSeconds: null,
    lastRunOutcome: null,
    lastRunSummary: null,
    lastRunContext: null,
    originator: null,
  };

  it('PATCH /api/jobs/:id unsuspends a suspended job', async () => {
    // getJob called twice: existence check + post-mutation read-back.
    vi.mocked(scheduler.getJob).mockResolvedValueOnce(patchJob).mockResolvedValueOnce({ ...patchJob, status: 'pending' });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/jobs/job-50',
      headers: AUTH,
      payload: { status: 'pending' },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty('job');
    expect(body.job.id).toBe('job-50');
    expect(scheduler.unsuspendJob).toHaveBeenCalledWith('job-50');
  });

  it('PATCH /api/jobs/:id calls updateJob for non-status changes', async () => {
    // getJob called twice: existence check + post-mutation read-back.
    vi.mocked(scheduler.getJob).mockResolvedValueOnce(patchJob).mockResolvedValueOnce(patchJob);

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/jobs/job-50',
      headers: AUTH,
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
    // getJob returns the job (existence check passes), then unsuspendJob throws.
    vi.mocked(scheduler.getJob).mockResolvedValueOnce(patchJob);
    vi.mocked(scheduler.unsuspendJob).mockRejectedValueOnce(new Error('Job job-50 not found or not suspended'));

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/jobs/job-50',
      headers: AUTH,
      payload: { status: 'pending' },
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/not found or not suspended/);
  });
});
