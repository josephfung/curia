// tests/smoke/harness.ts
//
// Headless bus stack harness for smoke tests. Boots the production agent stack in
// test mode (src/startup/test-mode-stack.ts) — the same agent assembly src/index.ts
// uses, so the coordinator sees the production system prompt — and adds a
// Dispatcher. No HTTP or CLI channel and no transport clients: nothing leaves the
// process. sendMessage() publishes inbound.message events and waits for the
// outbound.message response on the in-process bus.

import { Dispatcher } from '../../src/dispatch/dispatcher.js';
import { createInboundMessage, type OutboundMessageEvent } from '../../src/bus/events.js';
import type { EventBus } from '../../src/bus/bus.js';
import type { Logger } from '../../src/logger.js';
import {
  createTestModeStack,
  type ExecutionLayerWrapper,
  type TestModeStack,
} from '../../src/startup/test-mode-stack.js';

// How long each sendMessage() call waits for an outbound.message response.
// Agentic flows that invoke multiple skills (contact lookup → KG search →
// calendar check) can legitimately take 60-90s. Default is 120s, tunable
// via SMOKE_TIMEOUT_MS without code changes.
//
// Defensive parse: Number('') === 0 and Number('30s') === NaN, both of which
// would cause setTimeout to fire immediately. Validate and fall back to the
// default so a misconfigured env var fails loudly at parse time rather than
// silently making every test time out.
const _rawTimeout = parseInt(process.env.SMOKE_TIMEOUT_MS ?? '', 10);
export const RESPONSE_TIMEOUT_MS = Number.isFinite(_rawTimeout) && _rawTimeout > 0
  ? _rawTimeout
  : 120_000;

export interface HarnessOptions {
  /**
   * Route every agent to this model id (Anthropic or OpenRouter — the provider
   * follows from the model registry). Default: the configured model_routing.
   */
  model?: string;
  /** Wrap the ExecutionLayer before agents get it — tool stubs (#1956). */
  wrapExecutionLayer?: ExecutionLayerWrapper;
}

export interface CuriaHarness {
  bus: EventBus;
  logger: Logger;
  /** The underlying test-mode stack (services, assembled agents, prompt render). */
  stack: TestModeStack;
  /**
   * Send a single user message and wait for the outbound response.
   * Rejects if no response arrives within RESPONSE_TIMEOUT_MS.
   */
  sendMessage(options: {
    conversationId: string;
    content: string;
    senderId?: string;
    channelId?: string;
  }): Promise<{ content: string; durationMs: number }>;
  /**
   * Send a no-op warm-up message to absorb cold-start latency (DB pool
   * warm-up, first LLM API round-trip) before real test cases run.
   * The response is discarded — we only care that the stack is primed.
   */
  warmUp(): Promise<void>;
  shutdown(): Promise<void>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<CuriaHarness> {
  // Agents, services and the no-send outbound gateway — the production assembly
  // path in test mode. Throws with the provider name if the chosen model's API key
  // is missing.
  const stack = await createTestModeStack({
    model: options.model,
    wrapExecutionLayer: options.wrapExecutionLayer,
  });
  const { bus, logger, contactResolver } = stack;

  // Dispatcher — subscribes to inbound.message + agent.response.
  // Registered after agents so agent.task already has handlers.
  const dispatcher = new Dispatcher({ bus, logger, contactResolver, channelPolicies: undefined });
  dispatcher.register();

  // -- No HTTP adapter, no CLI adapter, no SIGTERM handler --
  // This harness is headless: the only way to inject messages is sendMessage().

  // Single persistent listener for outbound messages. Uses a Map to dispatch
  // responses to the correct sendMessage() caller by conversationId.
  // This avoids accumulating dead handlers (bus.subscribe returns void —
  // there is no unsubscribe mechanism).
  const pendingResponses = new Map<string, {
    resolve: (value: { content: string; durationMs: number }) => void;
    reject: (reason: Error) => void;
    start: number;
    timeout: ReturnType<typeof setTimeout>;
  }>();

  bus.subscribe('outbound.message', 'channel', (event) => {
    const outbound = event as OutboundMessageEvent;
    const pending = pendingResponses.get(outbound.payload.conversationId);
    if (pending) {
      pendingResponses.delete(outbound.payload.conversationId);
      clearTimeout(pending.timeout);
      pending.resolve({
        content: outbound.payload.content,
        durationMs: Date.now() - pending.start,
      });
    }
  });

  async function sendMessage(options: {
    conversationId: string;
    content: string;
    senderId?: string;
    channelId?: string;
  }): Promise<{ content: string; durationMs: number }> {
    return new Promise((resolve, reject) => {
      const start = Date.now();

      const timeoutSec = Math.round(RESPONSE_TIMEOUT_MS / 1000);
      const timeout = setTimeout(() => {
        if (pendingResponses.has(options.conversationId)) {
          pendingResponses.delete(options.conversationId);
          reject(new Error(`Timeout waiting for response (${timeoutSec}s)`));
        }
      }, RESPONSE_TIMEOUT_MS);

      pendingResponses.set(options.conversationId, { resolve, reject, start, timeout });

      // Publish the inbound message
      try {
        const inbound = createInboundMessage({
          conversationId: options.conversationId,
          channelId: options.channelId ?? 'smoke-test',
          senderId: options.senderId ?? 'smoke-test-user',
          content: options.content,
        });
        bus.publish('channel', inbound).catch((err) => {
          if (pendingResponses.has(options.conversationId)) {
            pendingResponses.delete(options.conversationId);
            clearTimeout(timeout);
            reject(err);
          }
        });
      } catch (err) {
        if (pendingResponses.has(options.conversationId)) {
          pendingResponses.delete(options.conversationId);
          clearTimeout(timeout);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  }

  async function warmUp(): Promise<void> {
    // Send a throwaway message to absorb cold-start latency: DB connection pool
    // warm-up, first LLM API round-trip, skill registry init, etc.
    // Failures are swallowed — if the stack is broken, real test cases will
    // surface it with clearer context.
    try {
      await sendMessage({
        conversationId: `smoke-warmup-${Date.now()}`,
        content: 'hello',
      });
    } catch {
      // intentionally ignored — warm-up is best-effort
    }
  }

  async function shutdown(): Promise<void> {
    await stack.shutdown();
  }

  return { bus, logger, stack, sendMessage, warmUp, shutdown };
}
