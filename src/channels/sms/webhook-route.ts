// webhook-route.ts — Fastify plugin for POST /api/webhooks/telnyx/sms.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import type { Logger } from '../../logger.js';
import type { SmsWebhookBridge } from './webhook-bridge.js';

export interface SmsWebhookRouteOpts {
  bridge: SmsWebhookBridge;
  logger: Logger;
}

/**
 * Mount the Telnyx SMS webhook. Captures the raw body for Ed25519 verify.
 * Bearer auth is exempted in HttpAdapter.onRequest for this path.
 */
export async function smsWebhookRoutes(
  app: FastifyInstance,
  opts: SmsWebhookRouteOpts,
): Promise<void> {
  const { bridge, logger } = opts;
  const log = logger.child({ component: 'sms-webhook' });

  app.post(
    '/api/webhooks/telnyx/sms',
    {
      // Preserve exact bytes for signature verification, then re-emit for JSON parse.
      preParsing: async (request, _reply, payload) => {
        const chunks: Buffer[] = [];
        for await (const chunk of payload) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const raw = Buffer.concat(chunks);
        (request as FastifyRequest & { rawBody?: Buffer }).rawBody = raw;
        return Readable.from(raw);
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const handler = bridge.getHandler();
      if (!handler) {
        log.warn('Telnyx SMS webhook received but SMS channel is not started');
        return reply.status(503).send({ error: 'SMS channel not available' });
      }

      const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
      if (!rawBody) {
        log.error('Telnyx SMS webhook missing rawBody after preParsing');
        return reply.status(500).send({ error: 'Internal webhook error' });
      }

      const headers = {
        signature: headerValue(request.headers['telnyx-signature-ed25519']),
        timestamp: headerValue(request.headers['telnyx-timestamp']),
      };

      try {
        const result = await handler(rawBody, headers);
        return reply.status(result.status).send(result.body ?? { ok: true });
      } catch (err) {
        log.error({ err }, 'Telnyx SMS webhook handler threw');
        return reply.status(500).send({ error: 'Internal webhook error' });
      }
    },
  );
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
