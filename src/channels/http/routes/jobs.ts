// jobs.ts — CRUD routes for scheduler job management.
//
// Provides REST endpoints for listing, viewing, creating, updating,
// and cancelling scheduled jobs. All mutations are delegated to
// SchedulerService so business rules (cron parsing, auto-suspend,
// event publishing) stay in one place.

import type { FastifyInstance } from 'fastify';
import type { SchedulerService } from '../../../scheduler/scheduler-service.js';

export interface JobRouteOptions {
  schedulerService: SchedulerService;
}

export async function jobRoutes(
  app: FastifyInstance,
  options: JobRouteOptions,
): Promise<void> {
  const { schedulerService } = options;

  // -- GET /api/jobs — list jobs with optional filters --

  app.get('/api/jobs', async (request, reply) => {
    const { status, agent_id } = request.query as { status?: string; agent_id?: string };
    const jobs = await schedulerService.listJobs({
      status: status || undefined,
      agentId: agent_id || undefined,
    });
    return reply.send({ jobs });
  });

  // -- GET /api/jobs/:id — get a single job --

  app.get('/api/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await schedulerService.getJob(id);
    if (!job) {
      return reply.status(404).send({ error: 'Job not found' });
    }
    return reply.send({ job });
  });

  // -- POST /api/jobs — create a new job --

  app.post('/api/jobs', async (request, reply) => {
    const body = request.body as {
      agent_id?: string;
      cron_expr?: string;
      run_at?: string;
      task_payload?: Record<string, unknown>;
      intent_anchor?: string;
      error_budget?: Record<string, unknown>;
    };

    // Validate required fields
    if (!body.agent_id) {
      return reply.status(400).send({ error: 'agent_id is required' });
    }
    if (!body.task_payload) {
      return reply.status(400).send({ error: 'task_payload is required' });
    }
    if (!body.cron_expr && !body.run_at) {
      return reply.status(400).send({ error: 'Either cron_expr or run_at must be provided' });
    }

    try {
      const result = await schedulerService.createJob({
        agentId: body.agent_id,
        cronExpr: body.cron_expr,
        runAt: body.run_at ? new Date(body.run_at) : undefined,
        taskPayload: body.task_payload,
        createdBy: 'api',
        intentAnchor: body.intent_anchor,
        errorBudget: body.error_budget,
      });
      return reply.status(201).send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create job';
      return reply.status(400).send({ error: message });
    }
  });

  // -- PATCH /api/jobs/:id — update an existing job --

  app.patch('/api/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      status?: string;
      cron_expr?: string;
      run_at?: string;
      task_payload?: Record<string, unknown>;
    };

    try {
      // If the caller is setting status back to 'pending', treat it as an unsuspend.
      // The unsuspendJob method handles validation (must currently be suspended).
      if (body.status === 'pending') {
        await schedulerService.unsuspendJob(id);
      } else {
        await schedulerService.updateJob(id, {
          cronExpr: body.cron_expr,
          runAt: body.run_at ? new Date(body.run_at) : undefined,
          taskPayload: body.task_payload,
        });
      }
      return reply.status(200).send({ updated: true, jobId: id });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update job';
      return reply.status(400).send({ error: message });
    }
  });

  // -- DELETE /api/jobs/:id — cancel (soft-delete) a job --

  app.delete('/api/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await schedulerService.cancelJob(id);
    return reply.send({ cancelled: true, jobId: id });
  });
}
