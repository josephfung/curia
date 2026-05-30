// jobs.ts — CRUD routes for scheduler job management.
//
// Provides REST endpoints for listing, viewing, creating, updating,
// and cancelling scheduled jobs. All mutations are delegated to
// SchedulerService so business rules (cron parsing, auto-suspend,
// event publishing) stay in one place.
//
// Auth: these routes bypass the global Bearer token hook and instead
// use session-cookie / bootstrap-secret auth (same as KG and identity
// routes). This allows the dashboard web app to call them without a
// Bearer token — the browser sends the curia_session cookie automatically.

import type { FastifyInstance } from 'fastify';
import type { SchedulerService } from '../../../scheduler/scheduler-service.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

export interface JobRouteOptions {
  schedulerService: SchedulerService;
  // Session auth — same pattern as KG and identity routes.
  // Required so the dashboard (which authenticates via session cookie, not Bearer token)
  // can access job endpoints.
  webAppBootstrapSecret: string | undefined;
  sessions: SessionStore;
}

export async function jobRoutes(
  app: FastifyInstance,
  options: JobRouteOptions,
): Promise<void> {
  const { schedulerService, webAppBootstrapSecret, sessions } = options;

  // -- GET /api/jobs — list jobs with optional filters --

  app.get('/api/jobs', async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    try {
      const { status, agent_id } = request.query as { status?: string; agent_id?: string };
      const jobs = await schedulerService.listJobs({
        status: status || undefined,
        agentId: agent_id || undefined,
      });
      return reply.send({ jobs });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to list jobs';
      return reply.status(500).send({ error: message });
    }
  });

  // -- GET /api/jobs/:id — get a single job --

  app.get('/api/jobs/:id', async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    try {
      const { id } = request.params as { id: string };
      const job = await schedulerService.getJob(id);
      if (!job) {
        return reply.status(404).send({ error: 'Job not found' });
      }
      return reply.send({ job });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get job';
      return reply.status(500).send({ error: message });
    }
  });

  // -- POST /api/jobs — create a new job --

  app.post('/api/jobs', async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const body = request.body as {
      agent_id?: string;
      cron_expr?: string;
      run_at?: string;
      task_payload?: Record<string, unknown>;
      intent_anchor?: string;
      error_budget?: Record<string, unknown>;
    };

    // Normalize whitespace-only string fields to absent so required-field
    // checks below behave consistently regardless of how the client submits them.
    // typeof guards defend against non-string values (e.g. numbers) that bypass
    // the TypeScript cast above — trimming a non-string would throw before our
    // error handler runs.
    const agentId = typeof body.agent_id === 'string' ? body.agent_id.trim() || undefined : undefined;
    const cronExpr = typeof body.cron_expr === 'string' ? body.cron_expr.trim() || undefined : undefined;
    const runAt = typeof body.run_at === 'string' ? body.run_at.trim() || undefined : undefined;

    if (!agentId) {
      return reply.status(400).send({ error: 'agent_id is required' });
    }
    if (!body.task_payload) {
      return reply.status(400).send({ error: 'task_payload is required' });
    }
    if (!cronExpr && !runAt) {
      return reply.status(400).send({ error: 'Either cron_expr or run_at must be provided' });
    }

    try {
      const result = await schedulerService.createJob({
        agentId,
        cronExpr,
        runAt: runAt ? new Date(runAt) : undefined,
        taskPayload: body.task_payload,
        createdBy: 'api',
        intentAnchor: body.intent_anchor,
        errorBudget: body.error_budget,
      });

      // Fetch the full job row so the caller can render it immediately without
      // a separate GET request.
      const job = await schedulerService.getJob(result.jobId);
      if (!job) {
        // Extremely unlikely: job was created then immediately cancelled between
        // the insert and this read. Use 500 — the job exists in the DB, the
        // failure is on our side (read-back), not the client's request.
        return reply.status(500).send({
          error: 'Job was created but could not be retrieved — refresh to see it.',
          jobId: result.jobId,
        });
      }

      return reply.status(201).send({ job });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create job';
      return reply.status(400).send({ error: message });
    }
  });

  // -- PATCH /api/jobs/:id — update or unsuspend an existing job --

  app.patch('/api/jobs/:id', async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const { id } = request.params as { id: string };
    const body = request.body as {
      status?: string;
      cron_expr?: string;
      run_at?: string;
      task_payload?: Record<string, unknown>;
    };

    // Normalize whitespace-only string schedule fields to absent so they don't
    // pass the hasUpdateFields check while carrying no real value.
    // typeof guards defend against non-string values that would throw before the
    // try/catch below runs.
    const cronExpr = typeof body.cron_expr === 'string' ? body.cron_expr.trim() || undefined : undefined;
    const runAt = typeof body.run_at === 'string' ? body.run_at.trim() || undefined : undefined;

    const hasUpdateFields =
      cronExpr !== undefined ||
      runAt !== undefined ||
      body.task_payload !== undefined;

    try {
      // Existence check inside try so any DB error is caught and serialized
      // consistently with the rest of the route, rather than surfacing as an
      // unstructured Fastify 500.
      const existing = await schedulerService.getJob(id);
      if (!existing) {
        return reply.status(404).send({ error: 'Job not found' });
      }

      // Setting status to 'pending' is the unsuspend/unpause path.
      if (body.status === 'pending') {
        await schedulerService.unsuspendJob(id);
      } else if (!hasUpdateFields) {
        return reply.status(400).send({ error: 'At least one of cron_expr, run_at, or task_payload must be provided' });
      } else {
        await schedulerService.updateJob(id, {
          cronExpr,
          runAt: runAt ? new Date(runAt) : undefined,
          taskPayload: body.task_payload,
        });
      }

      // Read the updated row back so the caller can update its local state
      // without a separate GET. Return 404 if the job disappeared between the
      // mutation above and this read (e.g. concurrent cancel).
      const job = await schedulerService.getJob(id);
      if (!job) {
        return reply.status(404).send({ error: 'Job not found after update' });
      }

      return reply.status(200).send({ job });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update job';
      return reply.status(400).send({ error: message });
    }
  });

  // -- DELETE /api/jobs/:id — cancel (soft-delete) a job --

  app.delete('/api/jobs/:id', async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const { id } = request.params as { id: string };
    try {
      await schedulerService.cancelJob(id);
      return reply.send({ cancelled: true, jobId: id });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to cancel job';
      return reply.status(500).send({ error: message });
    }
  });
}
