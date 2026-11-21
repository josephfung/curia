// onboarding.ts — HTTP routes for starting onboarding (#2360).
//
// Endpoints (all session cookie or x-web-bootstrap-secret):
//   GET    /api/onboarding/status       — whether onboarding has started, and the dashboard alert
//   POST   /api/onboarding/start        — start onboarding; 409 with a code when it cannot
//   DELETE /api/onboarding/triage-hold  — release the triage hold (Email triage switched on)

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '../../../logger.js';
import type { EventBus } from '../../../bus/bus.js';
import { createConfigChange, createOperatorSession } from '../../../bus/events.js';
import { assertSecret, CONSOLE_RATE, type SessionStore } from '../session-auth.js';
import { actorFromRequest } from './sessions.js';
import type { OnboardingService } from '../../../onboarding/onboarding-service.js';

export interface OnboardingRouteOptions {
  webAppBootstrapSecret: string;
  sessions: SessionStore;
  bus: EventBus;
  logger: Logger;
  onboarding: Pick<OnboardingService, 'status' | 'start' | 'releaseTriageHold' | 'stopInvitation'>;
}

// Start mints a 48-hour credential and creates tasks: the auth-sensitive limit setupRoutes uses.
const START_RATE = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

/**
 * The audit record of a console onboarding change: config.change, as office identity and the
 * executive profile record theirs. `version` is 1 for "on" (started, held) and 0 for "off".
 */
function onboardingChange(configType: 'onboarding' | 'onboarding_triage_hold', on: boolean, summary: string, actorSessionId?: string) {
  return createConfigChange({
    config_type: configType,
    version: on ? 1 : 0,
    previous_version: on ? 0 : 1,
    changed_by: 'api',
    ...(actorSessionId ? { note: `console session ${actorSessionId}` } : { note: 'console access key' }),
    diff_summary: summary,
  });
}

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
    // Start can mint a 48-hour invitation, which is minted only from a signed-in console session,
    // never from the access-key header alone, so the audit names a session (ADR-055).
    const actor = actorFromRequest(request, sessions);
    if (actor.initiatedBy !== 'session' || !actor.actorSessionId) {
      return reply.status(401).send({ error: 'Sign in to the console to create an invitation link.' });
    }
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
    // Onboarding started: recorded on every route. It happened, so a miss is logged, not an error.
    try {
      await bus.publish('system', onboardingChange('onboarding', true, `Onboarding started from the console (task ${result.taskId})`, actor.actorSessionId));
    } catch (err) {
      logger.error({ err, taskId: result.taskId }, 'onboarding: start audit write failed — onboarding did start');
    }
    if (result.invitation) {
      // The same audit record the console's own invitation mint writes.
      try {
        await bus.publish('system', createOperatorSession({
          action: 'invite',
          stage: 'completed',
          initiatedBy: 'session',
          actorSessionId: actor.actorSessionId,
        }));
      } catch (err) {
        // An unaudited invitation must not stay live: stop it, as the pairing route does.
        const pairingInvitationId = result.invitation.id;
        logger.error({ err, taskId: result.taskId, pairingInvitationId }, 'onboarding: invitation audit failed — link stopped');
        try {
          await onboarding.stopInvitation(pairingInvitationId);
        } catch (stopErr) {
          logger.error({ err: stopErr, pairingInvitationId }, 'onboarding: failed to stop an unaudited invitation link');
        }
        // A distinct code: onboarding did start (and may be restarting Curia), only the link is gone.
        return reply.status(500).send({
          code: 'started_invitation_unaudited',
          error:
            'Onboarding started, but the invitation could not be recorded, so the link was stopped. ' +
            'Create a new invitation link from Devices.',
          taskId: result.taskId,
          restartScheduled: result.restartScheduled,
        });
      }
    }
    return reply.send(result);
  });

  app.delete('/api/onboarding/triage-hold', START_RATE, async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    // Recorded before the change: an unrecordable release is refused, so no release goes unaudited.
    const actor = actorFromRequest(request, sessions);
    try {
      await bus.publish('system', onboardingChange('onboarding_triage_hold', false, 'Email triage hold released from the console', actor.actorSessionId));
    } catch (err) {
      logger.error({ err }, 'onboarding: triage hold release audit write failed — hold kept');
      return reply.status(500).send({ error: 'Nothing was changed: the release could not be audited, so it was not made. Check the server logs.' });
    }
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
