// executive.ts — HTTP routes for the Executive Profile API.
//
// All routes require session cookie or x-web-bootstrap-secret authentication
// (same pattern as the identity routes).
//
// Endpoints:
//   GET  /api/executive         — return the current active executive profile
//   PUT  /api/executive         — save a new version and trigger hot reload
//   GET  /api/executive/history — return all versions, newest first
//   POST /api/executive/reload  — force a reload from DB

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ExecutiveProfileService } from '../../../executive/service.js';
import type { ExecutiveProfile } from '../../../executive/types.js';
import { assertSecret, type SessionStore } from '../session-auth.js';

export interface ExecutiveRouteOptions {
  executiveProfileService: ExecutiveProfileService;
  webAppBootstrapSecret: string;
  sessions: SessionStore;
}

export async function executiveRoutes(
  app: FastifyInstance,
  options: ExecutiveRouteOptions,
): Promise<void> {
  const { executiveProfileService, webAppBootstrapSecret, sessions } = options;

  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    return assertSecret(request, reply, webAppBootstrapSecret, sessions);
  }

  // -- GET /api/executive — return current executive profile --

  app.get('/api/executive', async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    try {
      const profile = executiveProfileService.get();
      return reply.send({ profile });
    } catch (err) {
      request.log.error({ err }, 'GET /api/executive: failed to get executive profile');
      return reply.status(500).send({ error: 'Failed to get executive profile. Check server logs.' });
    }
  });

  // -- PUT /api/executive — save a new version and trigger hot reload --

  app.put('/api/executive', async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    const body = request.body as {
      profile?: ExecutiveProfile;
      changedBy?: string;
      note?: string;
    };

    if (!body?.profile) {
      return reply.status(400).send({ error: 'Request body must include a "profile" object' });
    }

    try {
      const VALID_CHANGED_BY = ['api', 'wizard'] as const;
      type ChangedBy = typeof VALID_CHANGED_BY[number];
      const changedBy: ChangedBy = VALID_CHANGED_BY.includes(body.changedBy as ChangedBy)
        ? (body.changedBy as ChangedBy)
        : 'api';
      await executiveProfileService.update(body.profile, changedBy, body.note);
      const updated = executiveProfileService.get();
      return reply.send({ profile: updated, updated: true });
    } catch (err) {
      request.log.error({ err }, 'PUT /api/executive: update failed');
      const pgCode = (err as { code?: string }).code;
      if (pgCode !== undefined) {
        return reply.status(500).send({ error: 'Failed to save executive profile due to a server error. Check server logs.' });
      }
      const message = err instanceof Error ? err.message : 'Failed to update executive profile';
      return reply.status(400).send({ error: message });
    }
  });

  // -- GET /api/executive/history — return all versions, newest first --

  app.get('/api/executive/history', async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    try {
      const history = await executiveProfileService.history();
      return reply.send({ history });
    } catch (err) {
      request.log.error({ err }, 'GET /api/executive/history: failed to retrieve history');
      return reply.status(500).send({ error: 'Failed to get executive profile history. Check server logs.' });
    }
  });

  // -- POST /api/executive/reload — force a reload from DB --

  app.post('/api/executive/reload', async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    try {
      await executiveProfileService.reload();
      const profile = executiveProfileService.get();
      return reply.send({ profile, reloaded: true });
    } catch (err) {
      // Do not forward the error message — reload failures surface DB internals (table names,
      // migration identifiers) that should not reach API callers.
      // The error is already logged by reload() before rethrowing.
      request.log.error({ err }, 'POST /api/executive/reload: reload failed');
      return reply.status(500).send({ error: 'Failed to reload executive profile due to a server error. Check server logs.' });
    }
  });
}
