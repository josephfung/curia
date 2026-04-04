// messages.ts — message endpoints for the HTTP API channel.
//
// POST /api/messages — send a message and get the response.
// GET /api/messages/stream — SSE endpoint for real-time events.
//
// Both use the shared EventRouter to avoid subscriber leaks on the bus.
// The EventRouter registers ONE subscriber per event type at startup;
// individual requests register/deregister handlers via Maps and Sets.

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { EventBus } from '../../../bus/bus.js';
import { createInboundMessage } from '../../../bus/events.js';
import type { Logger } from '../../../logger.js';
import type { EventRouter } from '../event-router.js';
import { MessageRejectedError } from '../event-router.js';

export interface MessageRouteOptions {
  bus: EventBus;
  logger: Logger;
  eventRouter: EventRouter;
}

// How long to wait for an agent response before timing out the POST request
const RESPONSE_TIMEOUT_MS = 120000;

export async function messageRoutes(
  app: FastifyInstance,
  options: MessageRouteOptions,
): Promise<void> {
  const { bus, logger, eventRouter } = options;

  /**
   * POST /api/messages — send a message, wait for response.
   *
   * Body: { content: string, conversation_id?: string, sender_id?: string }
   * Response: { conversation_id, content, agent_id }
   */
  app.post('/api/messages', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      content?: string;
      conversation_id?: string;
      sender_id?: string;
    };

    if (!body?.content || typeof body.content !== 'string' || body.content.trim().length === 0) {
      return reply.status(400).send({ error: 'Missing required field: content (non-empty string)' });
    }

    const conversationId = body.conversation_id ?? `http-${randomUUID()}`;
    const senderId = body.sender_id ?? 'http-user';

    // Register the pending response BEFORE publishing so we don't miss a fast reply
    const responsePromise = eventRouter.waitForResponse(conversationId, RESPONSE_TIMEOUT_MS);

    const inboundEvent = createInboundMessage({
      conversationId,
      channelId: 'http',
      senderId,
      content: body.content,
    });

    try {
      await bus.publish('channel', inboundEvent);
      const content = await responsePromise;

      // TODO: agent_id is hardcoded — OutboundMessagePayload doesn't carry agentId.
      // Once we add agentId to the outbound event, extract it here for accuracy
      // in multi-agent delegation scenarios.
      return reply.send({
        conversation_id: conversationId,
        content,
        agent_id: 'coordinator',
      });
    } catch (err) {
      // Safety net: cancel the pending entry if the bus.publish() threw before
      // the rejection event could clean it up. On the normal rejection path the
      // EventRouter has already removed the entry, so this is a no-op there.
      eventRouter.cancelPending(conversationId);
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, conversationId }, 'HTTP message handling failed');

      // Distinguish rejection (403), timeout (504), and internal failures (500).
      // Use instanceof rather than string matching so a wording change can't
      // silently break the status code.
      const isRejected = err instanceof MessageRejectedError;
      const isTimeout = message.includes('timeout') || message.includes('Timeout');
      const status = isRejected ? 403 : isTimeout ? 504 : 500;
      return reply.status(status).send({ error: message });
    }
  });

  /**
   * GET /api/messages/stream — SSE endpoint.
   *
   * Streams outbound.message, skill.invoke, and skill.result events.
   * Optionally filter by ?conversation_id=xxx
   */
  app.get('/api/messages/stream', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { conversation_id?: string };

    // Tell Fastify we're taking over the response — prevents it from
    // sending a default reply after the async handler returns.
    reply.hijack();

    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering if behind a proxy
    });

    // Send initial keepalive comment
    reply.raw.write(':connected\n\n');

    // Register with the event router — returns a cleanup function
    const cleanup = eventRouter.addSseClient({
      res: reply.raw,
      conversationId: query.conversation_id,
    });

    // Periodic heartbeat to prevent proxies (nginx, ALB, Cloudflare) from
    // closing idle connections — most have a 60-120s idle timeout.
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(':ping\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 30000);

    // Clean up when client disconnects
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      cleanup();
    });
  });
}
