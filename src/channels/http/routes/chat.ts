// chat.ts — console chat messages, SSE stream, and history.
//
// Moved off /api/kg/chat/* (#872). Channel `web`, so contact-resolver attributes
// the sender to the principal. Auth: session cookie or x-web-bootstrap-secret
// via assertSecret. The bearer /api/messages routes were removed (ADR-057).

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { EventBus } from '../../../bus/bus.js';
import { createInboundMessage } from '../../../bus/events.js';
import type { Logger } from '../../../logger.js';
import type { EventRouter } from '../event-router.js';
import { assertSecret, CONSOLE_RATE, type SessionStore } from '../session-auth.js';
import { writeSseHead } from '../console-sessions.js';
import { markdownToHtml } from '../../../format/markdown-to-html.js';
import { fetchChatHistoryPage } from '../chat-history-page.js';
import { getOrCreateWebThread, readClientMessageId } from '../web-thread.js';

export interface ChatRouteOptions {
  pool: Pool;
  logger: Logger;
  webAppBootstrapSecret: string | undefined;
  sessions: SessionStore;
  bus: EventBus;
  eventRouter: EventRouter;
}

// Channel identifier used when the console dispatches messages to the agent layer.
// The 'web' channel is special-cased in contact-resolver.ts to auto-resolve to the principal —
// the bootstrap secret is principal-only, so any authenticated web request is implicitly the principal.
// See config/channel-trust.yaml for the channel policy.
const WEB_CHANNEL_ID = 'web';
// Sentinel sender ID for the web channel. The value is cosmetic — contact-resolver.ts
// short-circuits to the principal contact for this channel regardless of the sender string.
const WEB_SENDER_ID = 'ceo-web-user';

/**
 * Stream and history follow the shared thread. A missing id, and an id from a
 * tab opened before this deploy, both land on that thread. A differing id is
 * logged so the old call is visible.
 */
async function resolveStreamConversation(
  pool: Pool,
  logger: Logger,
  requested: string | undefined,
): Promise<string> {
  const conversationId = await getOrCreateWebThread(pool);
  const supplied = requested?.trim() ?? '';
  if (supplied && supplied !== conversationId) {
    logger.warn(
      { suppliedId: supplied, conversationId },
      'client conversationId does not match the shared web thread; using the shared thread',
    );
  }
  return conversationId;
}

export async function chatRoutes(
  app: FastifyInstance,
  options: ChatRouteOptions,
): Promise<void> {
  const { pool, logger, webAppBootstrapSecret, sessions, bus, eventRouter } = options;

  // ── Chat endpoints ──────────────────────────────────────────────────────
  //
  // The chat endpoints let the web console send messages to the agent layer
  // and stream responses back. They use the 'web' channel so contact-resolver
  // auto-attributes the sender to the principal (the bootstrap secret is principal-only).
  //
  // Auth: the same assertSecret guard as other console routes — they accept
  // either a valid curia_session cookie (browser flow) or x-web-bootstrap-secret header
  // (programmatic flow, e.g. tests and scripts).

  /**
   * POST /api/chat/messages — publish a chat message and ack immediately.
   *
   * Body: { message: string, clientMessageId?: string }
   * Response: 202 { conversationId }
   *
   * The conversation id is the server-owned web thread. A client-supplied id
   * is ignored so a second browser cannot fork the history. The operator's
   * own message is echoed on the SSE stream so other open devices append it
   * without a reload. `clientMessageId` lets the sender ignore that echo.
   *
   * Ack-and-stream (#985): the handler publishes the inbound message and returns
   * 202 without waiting for the agent's reply. The final reply and intermediate
   * progress (tool.invoke / tool.result) arrive over GET /api/chat/stream,
   * which is the source of truth for the assistant turn. This removes the former
   * synchronous 120s wait that 504'd on long tasks (browser automation, delegation
   * chains, research).
   */
  app.post('/api/chat/messages', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;

    const body = request.body as { message?: unknown; clientMessageId?: unknown; conversationId?: unknown };
    if (typeof body?.message !== 'string' || body.message.trim().length === 0) {
      return reply.status(400).send({ error: 'Missing required field: message (non-empty string)' });
    }

    let conversationId: string;
    try {
      conversationId = await getOrCreateWebThread(pool);
    } catch (err) {
      logger.error({ err }, 'chat thread lookup failed');
      return reply.status(503).send({ error: 'Chat is temporarily unavailable. Please try again.' });
    }
    const suppliedId = typeof body.conversationId === 'string' ? body.conversationId.trim() : '';
    if (suppliedId && suppliedId !== conversationId) {
      logger.warn(
        { suppliedId, conversationId },
        'ignoring client conversationId; the shared web thread is used',
      );
    }
    const clientMessageId = readClientMessageId(body.clientMessageId);

    // stagePublish persists the inbound without waiting for the agent turn.
    // The echo goes out before deliver(), so other devices see the question
    // before the reply. deliver() is not awaited: spec 08 acks the POST now.
    let staged: { deliver: () => Promise<void> };
    try {
      staged = await bus.stagePublish('channel', createInboundMessage({
        conversationId,
        channelId: WEB_CHANNEL_ID,
        senderId: WEB_SENDER_ID,
        content: body.message,
        // Tag with structural channel trust level — session-cookie auth earns medium trust,
        // same as bearer token auth on the API channel. Required for messageTrustScore computation.
        metadata: { trustLevel: 'medium' },
      }));
    } catch (publishErr) {
      // Log the real error server-side (full context) but return a fixed,
      // client-safe message — don't echo internal bus/implementation detail back.
      logger.error({ err: publishErr, conversationId }, 'chat message publish failed');
      return reply.status(500).send({ error: 'Failed to publish chat message.' });
    }

    try {
      eventRouter.broadcastChatEvent(conversationId, {
        type: 'user.message',
        conversation_id: conversationId,
        content: body.message,
        client_message_id: clientMessageId,
      });
    } catch (err) {
      // The inbound is already staged. A missed echo shows up on the next
      // history load; failing the ack would make the client send it twice.
      logger.error({ err, conversationId }, 'chat user-message echo failed');
    }
    void staged.deliver();

    // Ack: the reply is delivered over the SSE stream, not this response.
    return reply.status(202).send({ conversationId });
  });

  /**
   * GET /api/chat/conversation — the principal's shared web thread.
   * Created on first read. Every device uses this id.
   */
  app.get('/api/chat/conversation', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;
    try {
      const conversationId = await getOrCreateWebThread(pool);
      return reply.send({ conversationId });
    } catch (err) {
      logger.error({ err }, 'GET /api/chat/conversation failed');
      return reply.status(503).send({ error: 'Chat is temporarily unavailable. Please try again.' });
    }
  });

  /**
   * GET /api/chat/stream — SSE stream of agent events for the web console.
   *
   * Streams outbound.message, tool.invoke, and tool.result events from the EventRouter,
   * optionally filtered by ?conversationId=xxx.
   */
  app.get('/api/chat/stream', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;

    const query = request.query as { conversationId?: string };
    let conversationId: string;
    try {
      conversationId = await resolveStreamConversation(pool, logger, query.conversationId);
    } catch (err) {
      logger.error({ err }, 'GET /api/chat/stream failed to resolve the thread');
      return reply.status(503).send({ error: 'Chat is temporarily unavailable. Please try again.' });
    }

    // Hand the raw socket over to us — Fastify won't send a default response after the
    // handler returns, which is what we want for a long-lived SSE stream.
    reply.hijack();
    writeSseHead(reply, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      // Nginx/ALB/Cloudflare buffer SSE by default — this header disables that.
      'X-Accel-Buffering': 'no',
    }, logger);
    reply.raw.write(':connected\n\n');

    const cleanup = eventRouter.addSseClient({
      res: reply.raw,
      conversationId,
    });

    // 30s data heartbeat. An SSE comment (`:ping`) never reaches the browser,
    // so a half-open phone socket would look healthy. The client reconnects
    // if this stops arriving.
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write('data: {"type":"ping"}\n\n');
      } catch (err) {
        // Write failed — client likely disconnected without a clean TCP close.
        // Clear the interval and explicitly remove the SSE client to prevent a leak
        // in the case where the 'close' event on request.raw doesn't fire.
        logger.debug({ err, conversationId }, 'chat SSE heartbeat write failed — removing client');
        clearInterval(heartbeat);
        cleanup();
      }
    }, 30_000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      cleanup();
    });
  });

  /**
   * GET /api/chat/history — fetch paginated chat history from working_memory.
   *
   * Query params:
   *   - conversationId: string (optional; a different id is ignored in favor of the shared thread)
   *   - before: string (optional ISO timestamp — returns messages older than this cursor;
   *     microseconds are preserved; do not round-trip through JS Date)
   *   - limit: number (optional, default 25, max 50)
   *
   * Returns messages in chronological order (oldest first) so the client can
   * prepend them to the thread. Pages fill to `limit` *display* messages;
   * `hasMore` reflects displayable turns, not raw rows (#1775).
   *
   * Only user/assistant turns are returned — system turns (synthetic summaries
   * inserted by the summarisation pass) are excluded since they are internal
   * artifacts not intended for display. Display filters (voice greeting cue,
   * LLM-failure rewrite, outbound-context preamble) live in
   * `chat-history-page.ts`.
   */
  app.get('/api/chat/history', CONSOLE_RATE, async (request, reply) => {
    if (!assertSecret(request, reply, webAppBootstrapSecret, sessions)) return;

    const query = request.query as {
      conversationId?: string;
      before?: string;
      limit?: string;
    };

    let conversationId: string;
    try {
      conversationId = await resolveStreamConversation(pool, logger, query.conversationId);
    } catch (err) {
      logger.error({ err }, 'GET /api/chat/history failed to resolve the thread');
      return reply.status(503).send({ error: 'Chat is temporarily unavailable. Please try again.' });
    }

    const rawLimit = parseInt(query.limit ?? '25', 10);
    const limit = isNaN(rawLimit) || rawLimit < 1 ? 25 : Math.min(rawLimit, 50);

    // Validate the before cursor: must be a parseable ISO date if provided.
    // Keep the original string for SQL — `new Date(...).toISOString()` drops
    // microseconds and would skip same-millisecond rows (#1775 review).
    let beforeCursor: { createdAtIso: string } | undefined;
    if (query.before !== undefined && query.before.trim().length > 0) {
      const beforeRaw = query.before.trim();
      if (isNaN(new Date(beforeRaw).getTime())) {
        return reply.status(400).send({ error: 'Invalid before param: must be an ISO timestamp' });
      }
      beforeCursor = { createdAtIso: beforeRaw };
    }

    try {
      // Keyset pagination over raw rows; fetchChatHistoryPage keeps scanning
      // until it has `limit` display messages (or the table is exhausted).
      // Composite (created_at, id) cursor + microsecond text so internal
      // batches do not skip rows that JS Date would collapse.
      const page = await fetchChatHistoryPage({
        before: beforeCursor,
        limit,
        load: async (cursor, fetchLimit) => {
          const result = await pool.query<{
            id: string;
            role: string;
            content: string;
            created_at: Date;
            created_at_iso: string;
          }>(
            `SELECT id, role, content, created_at,
                    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_iso
             FROM working_memory
             WHERE conversation_id = $1
               AND archived = false
               AND role IN ('user', 'assistant')
               AND ($2::timestamptz IS NULL
                    OR (created_at, id) < ($2::timestamptz, COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)))
             ORDER BY created_at DESC, id DESC
             LIMIT $4`,
            [conversationId, cursor?.createdAtIso ?? null, cursor?.id ?? null, fetchLimit],
          );
          return result.rows;
        },
        renderAssistantHtml: markdownToHtml,
        onMarkdownError: (err, messageId) => {
          logger.warn({ err, messageId }, 'markdownToHtml failed for history row; falling back to plain text');
        },
      });

      // JSON body (Fastify application/json), not HTML. Assistant `html` is
      // produced by markdownToHtml → sanitize-html. `resp.render()` does not
      // apply. Same send path as the other KG JSON routes; flagged because
      // this line moved.
      // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
      return reply.send(page);
    } catch (err) {
      logger.error({ err, conversationId }, 'chat history fetch failed');
      return reply.status(500).send({ error: 'Failed to fetch chat history' });
    }
  });
}
