import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from '../../logger.js';
import type { ContactService } from '../../contacts/contact-service.js';
import { assertSecret, type SessionStore } from '../http/session-auth.js';
import { resolveConsoleVoiceCaller } from './caller-context.js';
import type { VoiceSessionBridge } from './session-bridge.js';

export interface VoiceSessionRouteOptions {
  bridge: VoiceSessionBridge;
  logger: Logger;
  webAppBootstrapSecret: string | undefined;
  sessions: SessionStore;
  contactService: ContactService;
}

export async function voiceSessionRoutes(
  app: FastifyInstance,
  opts: VoiceSessionRouteOptions,
): Promise<void> {
  const { bridge, logger, webAppBootstrapSecret, sessions, contactService } = opts;
  const log = logger.child({ component: 'voice-session-routes' });

  app.get('/api/voice/status', async (_request, reply) => {
    const handler = bridge.getHandler();
    if (!handler) return reply.status(200).send({ enabled: false });
    try {
      const status = await handler.status();
      return reply.status(200).send({ enabled: status.enabled });
    } catch (err) {
      log.error({ err }, 'Voice status handler threw');
      return reply.status(200).send({ enabled: false });
    }
  });

  app.post('/api/voice/sessions', async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const handler = bridge.getHandler();
    if (!handler) return reply.status(503).send({ error: 'Voice channel not available' });

    try {
      // Console transport is principal-proven by the bootstrap secret (same as 'web').
      // Resolve the principal explicitly, then stamp originator/liveTurn via the shared
      // helper — do NOT route through ContactResolver.resolve('voice', …) so a future
      // real caller token still hits resolveByChannelIdentity (#1598 / #1602).
      const caller = await resolveConsoleVoiceCaller({ contactService, logger: log });
      const result = await handler.createSession({
        caller,
        metadata: parseMetadata(request.body),
      });
      return reply.status(result.status).send(result.body);
    } catch (err) {
      log.error({ err }, 'Voice session create handler threw');
      return reply.status(500).send({ error: 'Internal voice session error' });
    }
  });

  app.delete('/api/voice/sessions/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    const handler = bridge.getHandler();
    if (!handler) return reply.status(503).send({ error: 'Voice channel not available' });

    try {
      const result = await handler.endSession(request.params.id);
      return reply.status(result.status).send(result.body);
    } catch (err) {
      log.error({ err, sessionId: request.params.id }, 'Voice session end handler threw');
      return reply.status(500).send({ error: 'Internal voice session error' });
    }
  });
}

function parseMetadata(body: unknown): Record<string, unknown> | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const metadata = (body as Record<string, unknown>).metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  return metadata as Record<string, unknown>;
}
