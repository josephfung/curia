// antfarm.ts — Ant Farm replay timeline and live directive stream.
//
// GET /api/antfarm/timeline — historical ActivityScript for a time window.
// GET /api/antfarm/stream   — SSE of interpreted directives for live monitoring.
//
// Auth: session cookie or x-web-bootstrap-secret (same as jobs/KG routes).

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AuditLogRepo } from '../../../audit/audit-log-repo.js';
import type { Logger } from '../../../logger.js';
import { buildScript } from '../../../antfarm/interpreter.js';
import type { AuditEventRow } from '@curia/shared-types';
import { assertSecret, type SessionStore } from '../session-auth.js';
import type { EventRouter } from '../event-router.js';

export interface AntfarmRouteOptions {
  auditLogRepo: AuditLogRepo;
  eventRouter: EventRouter;
  webAppBootstrapSecret: string | undefined;
  sessions: SessionStore;
  logger: Logger;
}

const DEFAULT_TIMELINE_LIMIT = 500;
const MAX_TIMELINE_LIMIT = 2000;

function auditLogRowToEventRow(row: {
  id: string;
  timestamp: Date;
  eventType: string;
  sourceLayer: string;
  sourceId: string;
  conversationId: string | null;
  parentEventId: string | null;
  payload: Record<string, unknown>;
}): AuditEventRow {
  return {
    id: row.id,
    timestamp: row.timestamp,
    eventType: row.eventType,
    sourceLayer: row.sourceLayer,
    sourceId: row.sourceId,
    conversationId: row.conversationId,
    parentEventId: row.parentEventId,
    payload: row.payload,
  };
}

function parseOptionalDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed;
}

function parseAfterCursor(value: string | undefined): { timestamp: Date; id: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as { timestamp?: string; id?: string };
    if (typeof parsed.timestamp !== 'string' || typeof parsed.id !== 'string') {
      return undefined;
    }
    const timestamp = new Date(parsed.timestamp);
    if (Number.isNaN(timestamp.getTime())) {
      return undefined;
    }
    return { timestamp, id: parsed.id };
  } catch {
    return undefined;
  }
}

export async function antfarmRoutes(
  app: FastifyInstance,
  options: AntfarmRouteOptions,
): Promise<void> {
  const { auditLogRepo, eventRouter, webAppBootstrapSecret, sessions, logger } = options;

  app.get('/api/antfarm/timeline', async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;

    const query = request.query as {
      from?: string;
      to?: string;
      conversationId?: string;
      taskId?: string;
      limit?: string;
      after?: string;
    };

    const from = parseOptionalDate(query.from);
    const to = parseOptionalDate(query.to);
    if (query.from && !from) {
      return reply.status(400).send({ error: 'Invalid from timestamp' });
    }
    if (query.to && !to) {
      return reply.status(400).send({ error: 'Invalid to timestamp' });
    }

    const parsedLimit = query.limit ? Number.parseInt(query.limit, 10) : DEFAULT_TIMELINE_LIMIT;
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), MAX_TIMELINE_LIMIT)
      : DEFAULT_TIMELINE_LIMIT;

    const after = parseAfterCursor(query.after);
    if (query.after && !after) {
      return reply.status(400).send({ error: 'Invalid after cursor' });
    }

    try {
      const page = await auditLogRepo.findTimeline({
        from,
        to,
        conversationId: query.conversationId,
        taskId: query.taskId,
        limit,
        after,
      });
      const script = buildScript(page.rows.map(auditLogRowToEventRow));
      return reply.send({
        ...script,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      });
    } catch (err) {
      logger.error({ err }, 'antfarm timeline query failed');
      return reply.status(500).send({ error: 'Failed to load timeline' });
    }
  });

  app.get('/api/antfarm/stream', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(':connected\n\n');

    const cleanup = eventRouter.addAntfarmClient({ res: reply.raw });

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(':ping\n\n');
      } catch {
        clearInterval(heartbeat);
        cleanup();
      }
    }, 30000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      cleanup();
    });
  });
}
