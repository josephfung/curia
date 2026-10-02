// tests/smoke/harness.ts
//
// Headless bus stack harness for smoke tests. Boots the production agent stack in
// test mode (src/startup/test-mode-stack.ts) — the same agent assembly src/index.ts
// uses, so the coordinator sees the production system prompt — and adds a
// Dispatcher. No HTTP or CLI channel and no transport clients: no message can be sent.
// (Read-only tools still reach the outside world: web-fetch and web-search make real
// requests, and model and embedding calls go to their providers.) sendMessage()
// publishes an inbound.message and reads the coordinator's
// turn off the bus (tests/shared/turn-capture.ts): its tool calls and its reply.
//
// The CLI points DATABASE_URL at a throwaway copy of the database (clone-db.ts) before
// booting, so whatever the agents write is dropped with it. Tool stubs (stub-layer.ts)
// answer calls test mode cannot serve.

import { randomUUID } from 'node:crypto';
import { Dispatcher } from '../../src/dispatch/dispatcher.js';
import { createInboundMessage, type ModelFallbackEngagedEvent } from '../../src/bus/events.js';
import type { EventBus } from '../../src/bus/bus.js';
import type { Logger } from '../../src/logger.js';
import { createTestModeStack, type TestModeStack } from '../../src/startup/test-mode-stack.js';
import { createTurnCapture, withoutRecentHistory, type ObservedToolCall } from '../shared/turn-capture.js';
import { createSmokeStubs, type SmokeStubs } from './stub-layer.js';
import type { SmokeSender } from './types.js';

// How long each sendMessage() call waits for the coordinator's response.
// Agentic flows that delegate and then work through the fixture office (read the
// day, create three events, re-read to verify) legitimately take 90-150s on the
// production model. Default is 180s, the scenario suite's; tunable via
// SMOKE_TIMEOUT_MS without code changes.
//
// Defensive parse: Number('') === 0 and Number('30s') === NaN, both of which
// would cause setTimeout to fire immediately. Validate and fall back to the
// default so a misconfigured env var fails loudly at parse time rather than
// silently making every test time out.
const _rawTimeout = parseInt(process.env.SMOKE_TIMEOUT_MS ?? '', 10);
export const RESPONSE_TIMEOUT_MS = Number.isFinite(_rawTimeout) && _rawTimeout > 0
  ? _rawTimeout
  : 180_000;

/** How long shutdown waits for turns that outlived their timeout. */
const LATE_TURN_GRACE_MS = 60_000;

/**
 * After a publish resolves (the whole turn is over), how long to wait for the coordinator's
 * response before calling the turn finished without one — e.g. the Dispatcher rejected
 * the inbound. Without this the case would sit out the full timeout and report it as one.
 */
const NO_RESPONSE_GRACE_MS = 1_000;

/**
 * The `unknown` sender: an address with no contact record. `example.test` is reserved
 * (RFC 2606), so it can never be a real person's address. Nothing creates a contact for
 * it — the Dispatcher only publishes contact.unknown and routes in low-trust mode.
 */
export const UNKNOWN_SENDER_EMAIL = 'unknown-sender@example.test';

/** A fresh conversation id for one case, shaped like the sender's channel. */
export function conversationIdFor(sender: SmokeSender): string {
  return sender === 'unknown' ? `email:smoke-${randomUUID()}` : `smoke-${randomUUID()}`;
}

export interface HarnessOptions {
  /**
   * Route every agent to this model id (Anthropic or OpenRouter — the provider
   * follows from the model registry). Default: the configured model_routing.
   */
  model?: string;
}

export interface TurnResponse {
  content: string;
  durationMs: number;
  toolCalls: ObservedToolCall[];
  /** Set when the Dispatcher suppressed delivery: the reply never reached the sender. */
  noReplyReason?: string;
}

export interface CuriaHarness {
  bus: EventBus;
  logger: Logger;
  /** The underlying test-mode stack (services, assembled agents, prompt render). */
  stack: TestModeStack;
  /** Per-case tool stubs and the record of every agent's calls. */
  stubs: SmokeStubs;
  /**
   * Send a single message and wait for the coordinator's turn to end. Rejects if it
   * errors or does not end within RESPONSE_TIMEOUT_MS.
   */
  sendMessage(options: {
    conversationId: string;
    content: string;
    sender?: SmokeSender;
  }): Promise<TurnResponse>;
  /**
   * Send a no-op warm-up message to absorb cold-start latency (DB pool
   * warm-up, first LLM API round-trip) before real test cases run.
   * The response is discarded — we only care that the stack is primed.
   */
  warmUp(): Promise<void>;
  /**
   * Wait (up to `maxMs`) for turns that outlived their timeout. A late turn keeps calling
   * tools, and the stub layer would answer and record them as the next case's. Returns
   * false if some are still running.
   */
  settle(maxMs: number): Promise<boolean>;
  /** Model fallbacks (any agent, specialists included) since the last call, and clear them. */
  takeFallbacks(): string[];
  shutdown(): Promise<void>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<CuriaHarness> {
  // Agents, services and the no-send outbound gateway — the production assembly
  // path in test mode. Throws with the provider name if the chosen model's API key
  // is missing.
  const stubs = createSmokeStubs();
  const stack = await createTestModeStack({
    model: options.model,
    wrapExecutionLayer: (layer) => stubs.wrap(layer),
    // No contact recent history: a case must not inherit another case's turns, or the
    // real principal's, through cross-conversation recall.
    wrapWorkingMemory: withoutRecentHistory,
  });
  const { bus, logger, contactResolver } = stack;

  // Dispatcher — subscribes to inbound.message + agent.response.
  // Registered after agents so agent.task already has handlers.
  const dispatcher = new Dispatcher({ bus, logger, contactResolver, channelPolicies: undefined });
  dispatcher.register();

  // -- No HTTP adapter, no CLI adapter, no SIGTERM handler --
  // This harness is headless: the only way to inject messages is sendMessage().

  const capture = createTurnCapture(bus);

  // A fallback means some agent ran on a different model than the one the run is labelled
  // with. The shared capture only sees the coordinator's; specialists work in their own
  // conversations, so collect every agent's here and let the runner charge the case.
  let fallbacks: string[] = [];
  bus.subscribe('model.fallback', 'system', async (event) => {
    const { payload } = event as ModelFallbackEngagedEvent;
    fallbacks.push(`${payload.agentId}: ${payload.failedModel} → ${payload.fallbackModel} (${payload.reason})`);
  });

  /**
   * Turns still running after sendMessage gave up on them. EventBus.publish awaits every
   * subscriber, so a publish resolves only when the whole coordinator turn has finished;
   * sendMessage therefore races the capture's timeout instead of awaiting it. Shutdown
   * waits (bounded) for these before closing the pool.
   */
  const lateTurns = new Set<Promise<void>>();

  function trackDelivery(delivery: Promise<void>, conversationId: string): void {
    const settled = delivery
      .catch((err: unknown) => {
        // sendMessage has its outcome already (capture.fail or the timeout).
        logger.error({ err, conversationId }, 'smoke harness: a coordinator turn failed');
      })
      .finally(() => { lateTurns.delete(settled); });
    lateTurns.add(settled);
  }

  async function sendMessage(options: {
    conversationId: string;
    content: string;
    sender?: SmokeSender;
  }): Promise<TurnResponse> {
    const start = Date.now();
    const sender = options.sender ?? 'principal';
    // capture.fail() is keyed by conversation, and later turns of a case reuse this
    // conversation id. Once this turn has its outcome, its own late handlers below must
    // not fail whichever turn is pending by then.
    let turnEnded = false;
    const waiter = capture.waitFor(options.conversationId, RESPONSE_TIMEOUT_MS)
      .then((outcome) => { turnEnded = true; return outcome; });
    const failThisTurn = (err: unknown): void => {
      if (!turnEnded) capture.fail(options.conversationId, err);
    };
    const inbound = sender === 'unknown'
      ? createInboundMessage({
          conversationId: options.conversationId,
          channelId: 'email',
          senderId: UNKNOWN_SENDER_EMAIL,
          content: options.content,
          // What the email adapter attaches, minus anything a test cannot know.
          metadata: {
            participants: [{ email: UNKNOWN_SENDER_EMAIL, role: 'from' }],
            nylasMessageId: `smoke-msg-${randomUUID()}`,
            isAutoGenerated: false,
            autoGeneratedSignals: [],
          },
        })
      : createInboundMessage({
          conversationId: options.conversationId,
          // The contact resolver treats smoke-test as a local console session: the principal.
          channelId: 'smoke-test',
          senderId: 'smoke-test-user',
          content: options.content,
        });

    let delivery: Promise<void>;
    try {
      delivery = bus.publish('channel', inbound);
    } catch (err) {
      failThisTurn(err);
      delivery = Promise.resolve();
    }
    // A publish that fails outright must end the turn now, not after the timeout. One that
    // completes without a coordinator response ends it shortly after, instead of waiting
    // out the timeout. Both are no-ops once this turn has its outcome.
    delivery.then(
      () => {
        // unref: the grace timer alone must not keep the process alive at shutdown.
        setTimeout(() => failThisTurn(new Error('the turn ended without a coordinator response')), NO_RESPONSE_GRACE_MS).unref();
      },
      (err: unknown) => failThisTurn(err),
    );
    trackDelivery(delivery, options.conversationId);

    const outcome = await waiter;
    if (outcome.error) throw new Error(outcome.error);
    return {
      content: outcome.reply ?? '',
      durationMs: Date.now() - start,
      toolCalls: outcome.calls,
      ...(outcome.noReplyReason ? { noReplyReason: outcome.noReplyReason } : {}),
    };
  }

  async function settle(maxMs: number): Promise<boolean> {
    if (lateTurns.size === 0) return true;
    await Promise.race([
      Promise.allSettled([...lateTurns]),
      new Promise(resolve => setTimeout(resolve, maxMs)),
    ]);
    return lateTurns.size === 0;
  }

  async function warmUp(): Promise<void> {
    // Send a throwaway message to absorb cold-start latency: DB connection pool
    // warm-up, first LLM API round-trip, skill registry init, etc.
    // A failure is reported but not fatal — if the stack is broken, real test cases
    // will surface it with clearer context.
    try {
      await sendMessage({ conversationId: `smoke-warmup-${randomUUID()}`, content: 'hello' });
    } catch (err) {
      process.stderr.write(`  [WARN] warm-up turn failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    // The warm-up's calls and fallbacks are not any case's.
    stubs.clear();
    fallbacks = [];
  }

  async function shutdown(): Promise<void> {
    // Late turns still hold the pool; wait (bounded) so their writes and cleanup land.
    if (lateTurns.size > 0) {
      process.stderr.write(`  waiting up to ${LATE_TURN_GRACE_MS / 1000}s for ${lateTurns.size} timed-out turn(s) to finish...\n`);
      await Promise.race([
        Promise.allSettled([...lateTurns]),
        new Promise(resolve => setTimeout(resolve, LATE_TURN_GRACE_MS)),
      ]);
    }
    await stack.shutdown();
  }

  return {
    bus,
    logger,
    stack,
    stubs,
    sendMessage,
    warmUp,
    settle,
    takeFallbacks: () => {
      const taken = fallbacks;
      fallbacks = [];
      return taken;
    },
    shutdown,
  };
}
