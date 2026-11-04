// dashboard.ts — principal home (#2340).
//
// One route per card, each with its own error, plus the actions Waiting on you
// commits after the undo window: task done/cancel (through TaskRepo) and
// approval approve/deny.

import type { FastifyInstance } from 'fastify';
import type { Logger } from '../../../logger.js';
import { isUuid } from '../../../util/uuid.js';
import { assertSecret, CONSOLE_RATE, type SessionStore } from '../session-auth.js';
import type { BriefingService } from '../../../dashboard/briefing-service.js';

export interface DashboardRouteOptions {
  briefing: BriefingService;
  webAppBootstrapSecret: string | undefined;
  sessions: SessionStore;
  logger: Logger;
}

function shownFlag(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { shown?: unknown }).shown === true;
}

function parseApprovalId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

export async function dashboardRoutes(app: FastifyInstance, options: DashboardRouteOptions): Promise<void> {
  const { briefing, webAppBootstrapSecret, sessions, logger } = options;

  app.get('/api/dashboard/waiting', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    try {
      return reply.send(await briefing.waiting());
    } catch (err) {
      logger.error({ err }, 'dashboard: waiting query failed');
      return reply.status(500).send({ error: 'Failed to load what is waiting on you' });
    }
  });

  app.get('/api/dashboard/stats', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    try {
      return reply.send(await briefing.stats());
    } catch (err) {
      logger.error({ err }, 'dashboard: stats query failed');
      return reply.status(500).send({ error: 'Failed to load dashboard stats' });
    }
  });

  app.get('/api/dashboard/histogram', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    try {
      return reply.send(await briefing.histogram());
    } catch (err) {
      logger.error({ err }, 'dashboard: histogram query failed');
      return reply.status(500).send({ error: 'Failed to load the work histogram' });
    }
  });

  // The jobs behind the Hiccups tile; ?day=YYYY-MM-DD narrows to one histogram day (#2350).
  app.get('/api/dashboard/hiccups', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const { day } = request.query as { day?: string };
    if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return reply.status(400).send({ error: 'Invalid day.' });
    }
    try {
      return reply.send(await briefing.hiccups(new Date(), day));
    } catch (err) {
      logger.error({ err, day }, 'dashboard: hiccup list failed');
      return reply.status(500).send({ error: 'Failed to load the hiccups' });
    }
  });

  app.get('/api/dashboard/bullpen', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    try {
      return reply.send(await briefing.bullpen());
    } catch (err) {
      logger.error({ err }, 'dashboard: bullpen query failed');
      return reply.status(500).send({ error: 'Failed to load the bullpen' });
    }
  });

  app.post('/api/dashboard/tasks/:id/done', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    return taskStatus(request, reply, 'done');
  });

  app.post('/api/dashboard/tasks/:id/cancel', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    return taskStatus(request, reply, 'cancelled');
  });

  app.get('/api/dashboard/approvals/:id/preview', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const { id: raw } = request.params as { id: string };
    const id = parseApprovalId(raw);
    if (id === null) return reply.status(400).send({ error: 'Invalid approval id.' });
    try {
      const result = await briefing.preview(id);
      if (!result.ok) return reply.status(result.status).send({ error: result.error });
      return reply.send({
        summary: result.summary,
        canApprove: result.canApprove,
        blockReason: result.blockReason,
      });
    } catch (err) {
      logger.error({ err, approvalId: id }, 'dashboard: approval preview failed');
      return reply.status(500).send({ error: 'Failed to load the approval.' });
    }
  });

  app.post('/api/dashboard/approvals/:id/approve', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    return approval(request, reply, 'approve');
  });

  app.post('/api/dashboard/approvals/:id/deny', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    return approval(request, reply, 'deny');
  });

  async function taskStatus(
    request: { params: unknown },
    reply: { status: (code: number) => { send: (body: unknown) => unknown }; send: (body: unknown) => unknown },
    status: 'done' | 'cancelled',
  ) {
    const { id } = request.params as { id: string };
    if (!isUuid(id)) return reply.status(400).send({ error: 'Invalid task id.' });
    try {
      const result = await briefing.setTaskStatus(id, status);
      if (!result.ok) return reply.status(result.status).send({ error: result.error });
      return reply.send({ ok: true });
    } catch (err) {
      logger.error({ err, taskId: id, status }, 'dashboard: task status failed');
      return reply.status(500).send({ error: 'Failed to update task.' });
    }
  }

  async function approval(
    request: { params: unknown; body?: unknown },
    reply: { status: (code: number) => { send: (body: unknown) => unknown }; send: (body: unknown) => unknown },
    action: 'approve' | 'deny',
  ) {
    const { id: raw } = request.params as { id: string };
    const id = parseApprovalId(raw);
    if (id === null) return reply.status(400).send({ error: 'Invalid approval id.' });
    const shown = action === 'approve' && shownFlag(request.body);
    try {
      const result = action === 'approve' ? await briefing.approve(id, shown) : await briefing.deny(id);
      if (!result.ok) return reply.status(result.status).send({ error: result.error });
      return reply.send({ ok: true, sent: result.sent });
    } catch (err) {
      logger.error({ err, approvalId: id, action }, 'dashboard: approval action failed');
      return reply.status(500).send({ error: 'Failed to update the approval.' });
    }
  }
}
