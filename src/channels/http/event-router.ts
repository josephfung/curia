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

export interface PendingResponse {
  resolve: (content: string) => void;
  reject: (error: Error) => void;
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
      // Only handle messages for the HTTP channel
      if (event.payload.channelId !== 'http') return;

      const convId = event.payload.conversationId;

      // Resolve pending POST request if one is waiting for this conversation
      const pending = this.pendingResponses.get(convId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingResponses.delete(convId);
        pending.resolve(event.payload.content);
      }

      // Stream to all SSE clients (filtered by conversationId if set).
      // Wrap writes in try/catch so a dead client doesn't abort delivery
      // to the remaining clients in this dispatch cycle.
      const sseData = JSON.stringify({
        type: 'message',
        conversation_id: convId,
        content: event.payload.content,
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

    this.logger.info('HTTP event router subscriptions registered');
  }

  /**
   * Register a pending POST response. Returns a promise that resolves with the response content.
   * If a request is already pending for this conversationId, rejects it first to avoid
   * orphaned promises and leaked timeouts.
   */
  waitForResponse(conversationId: string, timeoutMs: number): Promise<string> {
    // Reject any existing pending request for this conversationId to prevent
    // orphaned promises. This can happen if two POSTs race with the same ID.
    const existing = this.pendingResponses.get(conversationId);
    if (existing) {
      clearTimeout(existing.timeout);
      this.pendingResponses.delete(conversationId);
      existing.reject(new Error('Superseded by a newer request for the same conversation_id'));
    }

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(conversationId);
        reject(new Error('Response timeout — the agent did not respond in time'));
      }, timeoutMs);

      this.pendingResponses.set(conversationId, { resolve, reject, timeout });
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
   * Send an SSE payload to all matching clients. Wraps each write in try/catch
   * so a dead client (TCP reset between close event and write) doesn't abort
   * delivery to remaining clients in this dispatch cycle.
   */
  private broadcastToSseClients(sseData: string, conversationId?: string): void {
    for (const client of this.sseClients) {
      if (!client.conversationId || client.conversationId === conversationId) {
        try {
          client.res.write(`data: ${sseData}\n\n`);
        } catch {
          // Client connection is dead — remove it. The 'close' event handler
          // will also fire eventually, but cleaning up here prevents repeated
          // failed writes for subsequent events in this tick.
          this.sseClients.delete(client);
          this.logger.debug({ conversationId: client.conversationId }, 'Removed dead SSE client');
        }
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
