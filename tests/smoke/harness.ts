// tests/smoke/harness.ts
//
// Headless bus stack harness for smoke tests. Boots the production agent stack in
// test mode (src/startup/test-mode-stack.ts) — the same agent assembly src/index.ts
// uses, so the coordinator sees the production system prompt — and adds a
// Dispatcher. No HTTP or CLI channel and no transport clients: nothing leaves the
// process. sendMessage() publishes an inbound.message and reads the coordinator's
// turn off the bus (tests/shared/turn-capture.ts): its tool calls and its reply.

import { randomUUID } from 'node:crypto';
import { Dispatcher } from '../../src/dispatch/dispatcher.js';
import { createInboundMessage } from '../../src/bus/events.js';
import type { EventBus } from '../../src/bus/bus.js';
import type { Logger } from '../../src/logger.js';
import {
  createTestModeStack,
  type ExecutionLayerWrapper,
  type TestModeStack,
} from '../../src/startup/test-mode-stack.js';
import {
  cleanupConversation,
  createTurnCapture,
  sweepConversations,
  withoutRecentHistory,
  type ObservedToolCall,
} from '../shared/turn-capture.js';
import type { SmokeSender } from './types.js';

// How long each sendMessage() call waits for the coordinator's response.
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

/** How long shutdown waits for turns that outlived their timeout. */
const LATE_TURN_GRACE_MS = 60_000;

/**
 * Conversation-id prefixes smoke uses. Its rows are found by them: deleted after each
 * case, and swept at start-up in case an interrupted run left some.
 */
export const SMOKE_CONVERSATION_PREFIXES = ['smoke-', 'email:smoke-'] as const;

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
  /** Wrap the ExecutionLayer before agents get it — tool stubs (#1956). */
  wrapExecutionLayer?: ExecutionLayerWrapper;
}

export interface TurnResponse {
  content: string;
  durationMs: number;
  toolCalls: ObservedToolCall[];
}

export interface CuriaHarness {
  bus: EventBus;
  logger: Logger;
  /** The underlying test-mode stack (services, assembled agents, prompt render). */
  stack: TestModeStack;
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
  /** Delete a finished case's conversation rows (working memory, checkpoints, entities). */
  cleanup(conversationId: string): Promise<void>;
  /** Delete conversation rows an interrupted run left behind. Returns rows removed per table. */
  sweep(): Promise<Record<string, number>>;
  shutdown(): Promise<void>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<CuriaHarness> {
  // Agents, services and the no-send outbound gateway — the production assembly
  // path in test mode. Throws with the provider name if the chosen model's API key
  // is missing.
  const stack = await createTestModeStack({
    model: options.model,
    wrapExecutionLayer: options.wrapExecutionLayer,
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

  /**
   * Turns still running after sendMessage gave up on them. EventBus.publish awaits every
   * subscriber, so a publish resolves only when the whole coordinator turn has finished;
   * sendMessage therefore races the capture's timeout instead of awaiting it. When a late
   * turn finally ends it has written rows after its case's cleanup, so they are deleted
   * again, and shutdown waits for these before closing the pool.
   */
  const lateTurns = new Set<Promise<void>>();

  function trackDelivery(delivery: Promise<void>, conversationId: string): void {
    const settled = delivery
      .catch((err: unknown) => {
        // sendMessage has its outcome already (capture.fail or the timeout).
        logger.error({ err, conversationId }, 'smoke harness: a coordinator turn failed');
      })
      .then(() => cleanupConversation(stack.pool, conversationId))
      .catch((err: unknown) => {
        logger.error({ err, conversationId }, 'smoke harness: late conversation cleanup failed');
        process.stderr.write(`  [WARN] late cleanup failed for ${conversationId}: ${err instanceof Error ? err.message : String(err)}\n`);
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
    const waiter = capture.waitFor(options.conversationId, RESPONSE_TIMEOUT_MS);
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
      capture.fail(options.conversationId, err);
      delivery = Promise.resolve();
    }
    // A publish that fails outright must end the turn now, not after the timeout.
    delivery.catch((err: unknown) => capture.fail(options.conversationId, err));
    trackDelivery(delivery, options.conversationId);

    const outcome = await waiter;
    if (outcome.error) throw new Error(outcome.error);
    return {
      content: outcome.reply ?? '',
      durationMs: Date.now() - start,
      toolCalls: outcome.calls,
    };
  }

  async function warmUp(): Promise<void> {
    // Send a throwaway message to absorb cold-start latency: DB connection pool
    // warm-up, first LLM API round-trip, skill registry init, etc.
    // A failure is reported but not fatal — if the stack is broken, real test cases
    // will surface it with clearer context.
    const conversationId = `smoke-warmup-${randomUUID()}`;
    try {
      await sendMessage({ conversationId, content: 'hello' });
    } catch (err) {
      process.stderr.write(`  [WARN] warm-up turn failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    await cleanupConversation(stack.pool, conversationId);
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
    sendMessage,
    warmUp,
    cleanup: (conversationId) => cleanupConversation(stack.pool, conversationId),
    sweep: () => sweepConversations(stack.pool, SMOKE_CONVERSATION_PREFIXES),
    shutdown,
  };
}
