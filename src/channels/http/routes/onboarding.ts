// onboarding.ts — HTTP routes for starting onboarding (#2360).
//
// Endpoints (all session cookie or x-web-bootstrap-secret):
//   GET    /api/onboarding/status       — whether onboarding has started, and the dashboard alert
//   POST   /api/onboarding/start        — start onboarding; 409 with a code when it cannot
//   DELETE /api/onboarding/triage-hold  — release the triage hold (Email triage switched on)

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '../../../logger.js';
import type { EventBus } from '../../../bus/bus.js';
import { createOperatorSession } from '../../../bus/events.js';
import { assertSecret, CONSOLE_RATE, type SessionStore } from '../session-auth.js';
import { actorFromRequest } from './sessions.js';
import type { OnboardingService } from '../../../onboarding/onboarding-service.js';

export interface OnboardingRouteOptions {
  webAppBootstrapSecret: string;
  sessions: SessionStore;
  bus: EventBus;
  logger: Logger;
  onboarding: Pick<OnboardingService, 'status' | 'start' | 'releaseTriageHold'>;
}

// Start mints a 48-hour credential and creates tasks: the auth-sensitive limit setupRoutes uses.
const START_RATE = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

export async function onboardingRoutes(app: FastifyInstance, options: OnboardingRouteOptions): Promise<void> {
  const { webAppBootstrapSecret, sessions, bus, logger, onboarding } = options;

  function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
    return assertSecret(request, reply, webAppBootstrapSecret, sessions);
  }

  app.get('/api/onboarding/status', CONSOLE_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    try {
      return reply.send(await onboarding.status());
    } catch (err) {
      logger.error({ err }, 'GET /api/onboarding/status failed');
      return reply.status(500).send({ error: 'Failed to read the onboarding status. Check server logs.' });
    }
  });

  app.post<{ Body: unknown }>('/api/onboarding/start', START_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const body = request.body;
    const confirm =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>).confirmWorkingPrincipal : undefined;
    if (confirm !== undefined && typeof confirm !== 'boolean') {
      return reply.status(400).send({ error: 'confirmWorkingPrincipal must be a boolean.' });
    }
    let result: Awaited<ReturnType<OnboardingService['start']>>;
    try {
      result = await onboarding.start({ actor: 'operator', confirmWorkingPrincipal: confirm === true });
    } catch (err) {
      logger.error({ err }, 'POST /api/onboarding/start failed');
      return reply.status(500).send({ error: 'Failed to start onboarding. Check server logs.' });
    }
    if (!result.ok) return reply.status(409).send(result);
    if (result.invitation) {
      // The same audit record the console's own invitation mint writes.
      try {
        await bus.publish('system', createOperatorSession({
          action: 'invite',
          stage: 'completed',
          ...actorFromRequest(request, sessions),
        }));
      } catch (err) {
        // Onboarding has started and the link is live; the audit row is what is missing.
        logger.error({ err, taskId: result.taskId }, 'onboarding: invitation minted but the audit could not be recorded');
      }
    }
    return reply.send(result);
  });

  app.delete('/api/onboarding/triage-hold', START_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    try {
      await onboarding.releaseTriageHold();
      logger.info('onboarding: triage hold released from the console');
      return reply.send({ held: false });
    } catch (err) {
      logger.error({ err }, 'DELETE /api/onboarding/triage-hold failed');
      return reply.status(500).send({ error: 'Failed to release the triage hold. Check server logs.' });
    }
  });
}
