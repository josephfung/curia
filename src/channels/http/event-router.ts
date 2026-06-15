// event-router.ts — shared subscriber pattern for the HTTP API.
//
// The EventBus has no unsubscribe mechanism. If we subscribed per-request,
// every POST and SSE connection would leak a permanent subscriber. Instead,
// the EventRouter registers ONE subscriber per event type at startup and
// dispatches to registered handlers via Maps and Sets.
//
// POST /api/messages registers a pending resolver keyed by conversationId.
// SSE connections register a writer function in a Set.
// Both are cleaned up when the request completes or the client disconnects.

import type { EventBus } from '../../bus/bus.js';
import type { BusEvent } from '../../bus/events.js';
import type { Logger } from '../../logger.js';
import type { ServerResponse } from 'node:http';
import { markdownToHtml } from '../../utils/markdown-to-html.js';

/**
 * Thrown by the event router when the dispatcher rejects a message. Typed
 * separately from Error so the route handler can detect the rejection case and
 * return 403/413/429 without brittle string matching on the error message.
 *
 * reason values:
 *   unknown_sender / provisional_sender / blocked_sender — policy-gate rejections (403)
 *   message_too_large — inbound content exceeded the configured size limit (413, spec §06)
 *   global_rate_limited / sender_rate_limited — rate limit rejections (429, spec §06)
 */
export class MessageRejectedError extends Error {
  readonly reason: 'unknown_sender' | 'provisional_sender' | 'blocked_sender' | 'message_too_large' | 'global_rate_limited' | 'sender_rate_limited';
  /** HTTP status code for this rejection — use this instead of hardcoding per reason. */
  readonly statusCode: 403 | 429;

  constructor(reason: 'unknown_sender' | 'provisional_sender' | 'blocked_sender' | 'message_too_large' | 'global_rate_limited' | 'sender_rate_limited') {
    const isRateLimited = reason === 'global_rate_limited' || reason === 'sender_rate_limited';
    super(
      reason === 'message_too_large'
        ? 'Message too large — inbound content exceeds the configured size limit'
        : isRateLimited
          ? `Message rejected — rate limit exceeded (${reason})`
          : `Message rejected — sender not authorized (${reason})`,
    );
    this.name = 'MessageRejectedError';
    this.reason = reason;
    this.statusCode = isRateLimited ? 429 : 403;
  }
}

/**
 * Discriminated result of a publish/wait cycle. `waitForResponse` ALWAYS resolves
 * with one of these — it never rejects.
 *
 * Why never reject: the timeout and supersede outcomes are fired by a timer / a
 * later request, potentially long after the route handler stopped awaiting (the
 * client disconnected, or a newer POST replaced the pending entry). A rejection
 * with no attached handler becomes an `unhandledRejection` and, under Node's
 * default policy, crashes the entire multi-agent process — taking every channel
 * and agent down with it. A *resolved* promise can never be an unhandled
 * rejection, so resolving with a discriminated result makes that crash
 * structurally impossible regardless of who is (or isn't) awaiting. See #983.
 */
export type WaitResult =
  | { ok: true; content: string }
  | { ok: false; kind: 'timeout' }
  | { ok: false; kind: 'superseded' }
  | { ok: false; kind: 'rejected'; error: MessageRejectedError };

/**
 * Canonical client-facing messages for the non-error WaitResult outcomes.
 * Defined here (next to WaitResult) so both the /api/messages and /api/kg/chat
 * handlers map a given `kind` to identical wording — they used to be free-floating
 * strings on the Error objects and risked drifting apart once moved to the routes.
 */
export const WAIT_TIMEOUT_MESSAGE = 'Response timeout — the agent did not respond in time';
export const WAIT_SUPERSEDED_MESSAGE = 'Superseded by a newer request for the same conversation_id';

/**
 * Map a non-ok {@link WaitResult} to its HTTP status code and client-facing
 * message. Shared by the /api/messages and /api/kg/chat/messages handlers so the
 * status contract can't drift between them — it already did once (rate-limit
 * rejections returned 403 instead of 429 on the KG route). The `never` guard
 * forces any new WaitResult variant to be handled here at compile time.
 *
 * Mapping: too-large → 413, rate-limited → 429, other policy rejection → 403,
 * timeout → 504, supersede → 500.
 */
export function mapWaitFailureToHttp(result: Extract<WaitResult, { ok: false }>): { status: number; message: string } {
  switch (result.kind) {
    case 'rejected':
      return {
        status: result.error.reason === 'message_too_large' ? 413 : result.error.statusCode,
        message: result.error.message,
      };
    case 'timeout':
      return { status: 504, message: WAIT_TIMEOUT_MESSAGE };
    case 'superseded':
      return { status: 500, message: WAIT_SUPERSEDED_MESSAGE };
    default: {
      const _exhaustive: never = result;
      throw new Error(`Unhandled WaitResult: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export interface PendingResponse {
  /** Settle the waiter's promise. Resolving (never rejecting) is what keeps a
   *  late timeout/supersede from leaking as an unhandledRejection — see WaitResult. */
  settle: (result: WaitResult) => void;
  timeout: NodeJS.Timeout;
}

export interface SseClient {
  res: ServerResponse;
  conversationId?: string; // Optional filter
}

/**
 * EventRouter registers shared bus subscribers and dispatches to HTTP clients.
 * Call setupSubscriptions() once at startup, then use the add/remove methods
 * per-request.
 */
export class EventRouter {
  private logger: Logger;
  /** Pending POST /api/messages responses, keyed by conversationId */
  private pendingResponses = new Map<string, PendingResponse>();
  /** Active SSE connections */
  private sseClients = new Set<SseClient>();

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Register shared subscribers on the bus. Called once at startup.
   * Uses 'channel' layer for outbound.message (proper permission model)
   * and 'system' layer for observability events (skill.invoke, skill.result).
   */
  setupSubscriptions(bus: EventBus): void {
    // outbound.message — dispatches to pending POST resolvers and SSE clients
    bus.subscribe('outbound.message', 'channel', (event: BusEvent) => {
      if (event.type !== 'outbound.message') return;
      // Handle messages for channels that use synchronous POST/wait (http and web).
      // Other channels (email, telegram) process replies asynchronously and have no
      // pending promise waiting here.
      if (event.payload.channelId !== 'http' && event.payload.channelId !== 'web') return;
      // @TODO: The sseClients Set is shared across all SSE endpoints. A client connected
      // to /api/messages/stream with no conversationId filter will receive web-channel
      // events after this change. Both endpoints require the same bootstrap-secret auth
      // (contained for now), but the clean fix is to tag SseClient with channelId and
      // filter in broadcastToSseClients. Track as a follow-up improvement.

      const convId = event.payload.conversationId;

      // Resolve pending POST request if one is waiting for this conversation
      const pending = this.pendingResponses.get(convId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingResponses.delete(convId);
        pending.settle({ ok: true, content: event.payload.content });
      }

      // Stream to all SSE clients (filtered by conversationId if set).
      // Wrap writes in try/catch so a dead client doesn't abort delivery
      // to the remaining clients in this dispatch cycle.
      //
      // Render markdown→HTML server-side so the SSE consumer (the web console)
      // gets the same pre-rendered HTML the POST path used to return. Wrapped in
      // try/catch: a render failure must degrade to html: null, never drop the
      // message event. (#985)
      let html: string | null = null;
      try {
        html = markdownToHtml(event.payload.content);
      } catch (renderErr) {
        this.logger.warn({ err: renderErr, conversationId: convId }, 'markdownToHtml failed for SSE message; sending html: null');
      }
      const sseData = JSON.stringify({
        type: 'message',
        conversation_id: convId,
        content: event.payload.content,
        html,
        timestamp: event.timestamp,
      });
      this.broadcastToSseClients(sseData, convId);
    });

    // skill.invoke — observability stream for SSE clients
    bus.subscribe('skill.invoke', 'system', (event: BusEvent) => {
      if (event.type !== 'skill.invoke') return;
      const sseData = JSON.stringify({
        type: 'skill.invoke',
        agent: event.payload.agentId,
        skill: event.payload.skillName,
        conversation_id: event.payload.conversationId,
        timestamp: event.timestamp,
      });
      this.broadcastToSseClients(sseData, event.payload.conversationId);
    });

    // skill.result — observability stream for SSE clients
    bus.subscribe('skill.result', 'system', (event: BusEvent) => {
      if (event.type !== 'skill.result') return;
      const sseData = JSON.stringify({
        type: 'skill.result',
        agent: event.payload.agentId,
        skill: event.payload.skillName,
        success: event.payload.result.success,
        duration_ms: event.payload.durationMs,
        conversation_id: event.payload.conversationId,
        timestamp: event.timestamp,
      });
      this.broadcastToSseClients(sseData, event.payload.conversationId);
    });

    // message.held — broadcast to all SSE clients so dashboards and API consumers
    // are notified when an unknown sender's message is held for CEO review.
    // Previously this notification only reached the CLI adapter; with the CLI
    // skipped in non-TTY (production) environments, the EventRouter must carry it.
    bus.subscribe('message.held', 'channel', (event: BusEvent) => {
      if (event.type !== 'message.held') return;
      const sseData = JSON.stringify({
        type: 'message.held',
        held_message_id: event.payload.heldMessageId,
        channel: event.payload.channel,
        sender_id: event.payload.senderId,
        subject: event.payload.subject,
        timestamp: event.timestamp,
      });
      // Not filtered by conversationId — held-message notifications are system-wide
      this.broadcastToSseClients(sseData);
    });

    // message.rejected — immediately reject the pending POST promise so the caller
    // gets a 403 instead of hanging until the 120-second timeout. This is the signal
    // path between the dispatch layer (where reject policy fires) and the HTTP adapter
    // (which has no other way to know the message was dropped).
    bus.subscribe('message.rejected', 'channel', (event: BusEvent) => {
      if (event.type !== 'message.rejected') return;

      const convId = event.payload.conversationId;

      // HTTP and web channel requests both have synchronous POST promises to reject.
      // Other channels (email, telegram, etc.) produce rejection events for audit
      // and SSE but have no synchronous caller waiting on a promise.
      if (event.payload.channelId === 'http' || event.payload.channelId === 'web') {
        const pending = this.pendingResponses.get(convId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingResponses.delete(convId);
          pending.settle({ ok: false, kind: 'rejected', error: new MessageRejectedError(event.payload.reason) });
        }
      }

      // Broadcast to SSE clients for all channels so dashboards have full visibility
      // into rejection events regardless of which channel the message arrived on.
      const sseData = JSON.stringify({
        type: 'message.rejected',
        conversation_id: convId,
        channel_id: event.payload.channelId,
        sender_id: event.payload.senderId,
        reason: event.payload.reason,
        timestamp: event.timestamp,
      });
      this.broadcastToSseClients(sseData, convId);
    });

    // agent.discuss — broadcast Bullpen activity to all SSE clients for dashboard observability.
    // Uses 'system' layer (same privilege as skill.invoke/skill.result) so the HTTP channel
    // can observe agent-layer events without publishing them.
    bus.subscribe('agent.discuss', 'system', (event: BusEvent) => {
      if (event.type !== 'agent.discuss') return;
      const sseData = JSON.stringify({
        type: 'agent.discuss',
        thread_id: event.payload.threadId,
        topic: event.payload.topic,
        sender_agent_id: event.payload.senderAgentId,
        mentioned_agent_ids: event.payload.mentionedAgentIds,
        participants: event.payload.participants,
        timestamp: event.timestamp,
      });
      // System-wide broadcast — not filtered by conversationId
      this.broadcastToSseClients(sseData);
    });


    this.logger.info('HTTP event router subscriptions registered');
  }

  /**
   * Register a pending POST response. Returns a promise that ALWAYS resolves with
   * a discriminated {@link WaitResult} — it never rejects (see WaitResult for why).
   *
   * If a request is already pending for this conversationId, it is settled with
   * `{ ok: false, kind: 'superseded' }` first to avoid orphaned promises and
   * leaked timeouts. This can happen if two POSTs race with the same ID.
   */
  waitForResponse(conversationId: string, timeoutMs: number): Promise<WaitResult> {
    // Supersede any existing pending request for this conversationId. Settling
    // (not rejecting) means the old route handler — which may no longer be
    // awaiting — gets a clean result rather than a floating rejection.
    const existing = this.pendingResponses.get(conversationId);
    if (existing) {
      clearTimeout(existing.timeout);
      this.pendingResponses.delete(conversationId);
      existing.settle({ ok: false, kind: 'superseded' });
    }

    return new Promise<WaitResult>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(conversationId);
        // resolve, never reject: the awaiter may be gone (client disconnected) and
        // an unhandled rejection here would crash the whole process. See #983.
        resolve({ ok: false, kind: 'timeout' });
      }, timeoutMs);

      // `resolve` is the promise's resolve — settling delivers the WaitResult.
      this.pendingResponses.set(conversationId, { settle: resolve, timeout });
    });
  }

  /** Cancel a pending response (e.g., if publish fails). */
  cancelPending(conversationId: string): void {
    const pending = this.pendingResponses.get(conversationId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingResponses.delete(conversationId);
    }
  }

  /**
   * Send an SSE payload to matching clients. Wraps each write in try/catch
   * so a dead client (TCP reset between close event and write) doesn't abort
   * delivery to remaining clients in this dispatch cycle.
   *
   * When `conversationId` is provided, only clients with no filter OR whose
   * filter matches are written to. When omitted, ALL clients receive the event
   * (system-wide notifications like message.held).
   */
  private broadcastToSseClients(sseData: string, conversationId?: string): void {
    for (const client of this.sseClients) {
      // Skip filtered clients unless the filter matches OR this is a system-wide broadcast
      const shouldSend = conversationId === undefined
        || !client.conversationId
        || client.conversationId === conversationId;
      if (!shouldSend) continue;
      try {
        client.res.write(`data: ${sseData}\n\n`);
      } catch (err) {
        // Client connection is dead — remove it. The 'close' event handler
        // will also fire eventually, but cleaning up here prevents repeated
        // failed writes for subsequent events in this tick.
        this.sseClients.delete(client);
        this.logger.debug({ err, conversationId: client.conversationId }, 'Removed dead SSE client');
      }
    }
  }

  /** Register an SSE client. Returns a cleanup function. */
  addSseClient(client: SseClient): () => void {
    this.sseClients.add(client);
    this.logger.debug({ conversationId: client.conversationId }, 'SSE client connected');
    return () => {
      this.sseClients.delete(client);
      this.logger.debug({ conversationId: client.conversationId }, 'SSE client disconnected');
    };
  }
}
