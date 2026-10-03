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
// A targeted case (#1977) addresses a specialist instead: sendMessage() posts the turn on
// the case's bullpen thread, mentioning the agent, and production's BullpenDispatcher
// turns it into that agent's task. The agent's turn is captured the same way.
//
// The CLI points DATABASE_URL at a throwaway copy of the database (clone-db.ts) before
// booting, so whatever the agents write is dropped with it. Tool stubs (stub-layer.ts)
// answer calls test mode cannot serve.

import { randomUUID } from 'node:crypto';
import { BullpenDispatcher } from '../../src/dispatch/bullpen-dispatcher.js';
import { Dispatcher } from '../../src/dispatch/dispatcher.js';
import { createAgentDiscuss, createInboundMessage, type ModelFallbackEngagedEvent } from '../../src/bus/events.js';
import type { EventBus } from '../../src/bus/bus.js';
import type { Logger } from '../../src/logger.js';
import type { BullpenService } from '../../src/memory/bullpen.js';
import { createTestModeStack, type TestModeStack } from '../../src/startup/test-mode-stack.js';
import { createTurnCapture, withoutRecentHistory, type ObservedToolCall } from '../shared/turn-capture.js';
import { createSmokeStubs, type SmokeStubs } from './stub-layer.js';
import type { CaseTarget, SmokeSender } from './types.js';

// How long each sendMessage() call waits for the agent's response.
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
 * After a publish resolves (the whole turn is over), how long to wait for the agent's
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

/** The bullpen thread a targeted case's turns are posted on. Its id is the conversation. */
export interface TargetThread {
  threadId: string;
  topic: string;
  participants: string[];
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
   *
   * With `target`, the message is instead `target.spec.from`'s post on the thread,
   * mentioning `target.spec.agent`, and the turn awaited is that agent's.
   * `conversationId` must be the thread id: BullpenDispatcher runs the agent with the
   * thread as its conversation.
   */
  sendMessage(options: {
    conversationId: string;
    content: string;
    sender?: SmokeSender;
    target?: { spec: CaseTarget; thread: TargetThread };
  }): Promise<TurnResponse>;
  /**
   * Open a targeted case's thread: `target.agent` opened it with `target.opening`,
   * addressed to `target.from`. Written to the database copy, like any agent's post.
   */
  openTargetThread(target: CaseTarget): Promise<TargetThread>;
  /**
   * Close the thread once the case is done. An open thread is injected into its
   * participants' later prompts as a pending discussion, so a later case would see it.
   */
  closeTargetThread(target: CaseTarget, thread: TargetThread): Promise<void>;
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
  // The bullpen threads agents may see as pending: only the one the running case opened.
  const caseThreads = new Set<string>();
  const stack = await createTestModeStack({
    model: options.model,
    wrapExecutionLayer: (layer) => stubs.wrap(layer),
    // No contact recent history: a case must not inherit another case's turns, or the
    // real principal's, through cross-conversation recall.
    wrapWorkingMemory: withoutRecentHistory,
    // Runtimes inject an agent's open bullpen threads from the last week into its prompt.
    // On a copy of the dev database those are whatever the dev instance left open: a real
    // CONSULT REPLY would sit beside a targeted case's own. Show only the case's thread
    // (the scenario suite's scopedBullpen does the same).
    wrapBullpenService: (bullpen) => Object.assign(Object.create(bullpen) as BullpenService, {
      getPendingThreadsForAgent: async (agentId: string, windowMinutes: number) =>
        (await bullpen.getPendingThreadsForAgent(agentId, windowMinutes)).filter(t => caseThreads.has(t.threadId)),
    }),
  });
  const { bus, logger, contactResolver } = stack;

  // Dispatcher — subscribes to inbound.message + agent.response.
  // Registered after agents so agent.task already has handlers.
  const dispatcher = new Dispatcher({ bus, logger, contactResolver, channelPolicies: undefined });
  dispatcher.register();

  // Production's BullpenDispatcher, but acting only on the posts a targeted case makes.
  // Registered for every agent.discuss, it would also wake agents on each post they make
  // to one another mid-case: turns nothing here awaits, which would run on into the next
  // case's stubs. So agent-to-agent bullpen wakes still do not happen in smoke.
  const casePosts = new Set<string>();
  const caseOnlyBus = Object.assign(Object.create(bus) as EventBus, {
    subscribe: (...[type, layer, handler]: Parameters<EventBus['subscribe']>) =>
      bus.subscribe(type, layer, async (event) => {
        if (!casePosts.has(event.id)) return;
        await handler(event);
      }),
    publish: (...args: Parameters<EventBus['publish']>) => bus.publish(...args),
  });
  new BullpenDispatcher(caseOnlyBus, logger, stack.bullpenService, stack.agentRegistry).register();

  // -- No HTTP adapter, no CLI adapter, no SIGTERM handler --
  // This harness is headless: the only way to inject messages is sendMessage().

  const capture = createTurnCapture(bus);

  // A fallback means some agent ran on a different model than the one the run is labelled
  // with. The shared capture only sees the awaited agent's; specialists work in their own
  // conversations, so collect every agent's here and let the runner charge the case.
  let fallbacks: string[] = [];
  bus.subscribe('model.fallback', 'system', async (event) => {
    const { payload } = event as ModelFallbackEngagedEvent;
    fallbacks.push(`${payload.agentId}: ${payload.failedModel} → ${payload.fallbackModel} (${payload.reason})`);
  });

  /**
   * Turns still running after sendMessage gave up on them. EventBus.publish awaits every
   * subscriber, so a publish resolves only when the whole agent turn has finished;
   * sendMessage therefore races the capture's timeout instead of awaiting it. Shutdown
   * waits (bounded) for these before closing the pool.
   */
  const lateTurns = new Set<Promise<void>>();

  function trackDelivery(delivery: Promise<void>, conversationId: string): void {
    const settled = delivery
      .catch((err: unknown) => {
        // sendMessage has its outcome already (capture.fail or the timeout).
        logger.error({ err, conversationId }, 'smoke harness: an agent turn failed');
      })
      .finally(() => { lateTurns.delete(settled); });
    lateTurns.add(settled);
  }

  async function openTargetThread(target: CaseTarget): Promise<TargetThread> {
    const opened = await stack.bullpenService.openThread(
      target.topic,
      target.agent,
      [target.agent, target.from],
      target.opening,
      [target.from],
    );
    const thread = { threadId: opened.thread.id, topic: opened.thread.topic, participants: opened.thread.participants };
    caseThreads.add(thread.threadId);
    answerOnThread(target, thread);
    return thread;
  }

  /**
   * Test mode gives the tool layer no bullpen service, so the bullpen tool is refused. A
   * woken agent's first step is usually reading the thread it was woken on, and its
   * natural last step a reply there, and a refusal of either sends it chasing a broken
   * tool layer. Serve both for this case's thread, through the real service on the
   * database copy, in the shapes the bullpen handler returns. The reply wakes no one
   * (see caseOnlyBus above). Any other bullpen call stays refused unless a case stubs it.
   */
  function answerOnThread(target: CaseTarget, thread: TargetThread): void {
    stubs.answer('bullpen', async (input, agentId) => {
      // Only the targeted agent's calls: a reply is posted as it, so another agent's
      // (one it delegated to, say) must not be credited to it. Those stay refused.
      if (input['thread_id'] !== thread.threadId || agentId !== target.agent) return undefined;
      if (input['action'] === 'get_thread') {
        const loaded = await stack.bullpenService.getThread(thread.threadId);
        if (!loaded) return { success: false, error: `No bullpen thread with ID ${thread.threadId} exists` };
        return { success: true, data: { thread_id: thread.threadId, thread: loaded.thread, messages: loaded.messages } };
      }
      if (input['action'] === 'reply' && typeof input['content'] === 'string' && input['content'] !== '') {
        const closeAfter = input['close_after'] === true;
        try {
          const message = await stack.bullpenService.postMessage(thread.threadId, target.agent, input['content'], [], closeAfter);
          return {
            success: true,
            data: closeAfter
              ? { thread_id: thread.threadId, message_id: message.id, status: 'closed' }
              : { thread_id: thread.threadId, message_id: message.id },
          };
        } catch (err) {
          // What the handler reports for a closed or capped thread.
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      return undefined;
    });
  }

  async function closeTargetThread(target: CaseTarget, thread: TargetThread): Promise<void> {
    // Out of view first: even if the close fails, no later case is shown this thread.
    caseThreads.delete(thread.threadId);
    await stack.bullpenService.closeThread(thread.threadId, target.agent);
  }

  /** Post `from`'s turn on the thread, then publish the agent.discuss a bullpen reply does. */
  async function postOnThread(target: CaseTarget, thread: TargetThread, content: string): Promise<void> {
    const message = await stack.bullpenService.postMessage(thread.threadId, target.from, content, [target.agent]);
    const discuss = createAgentDiscuss({
      threadId: thread.threadId,
      messageId: message.id,
      topic: thread.topic,
      senderAgentId: target.from,
      participants: thread.participants,
      mentionedAgentIds: [target.agent],
      content,
      parentEventId: randomUUID(),
    });
    casePosts.add(discuss.id);
    try {
      // Resolves when the woken agent's turn is over, like an inbound publish.
      await bus.publish('agent', discuss);
    } finally {
      casePosts.delete(discuss.id);
    }
  }

  /** The coordinator path: an inbound.message from the principal or an unknown sender. */
  function publishInbound(conversationId: string, content: string, sender: SmokeSender): Promise<void> {
    const inbound = sender === 'unknown'
      ? createInboundMessage({
          conversationId,
          channelId: 'email',
          senderId: UNKNOWN_SENDER_EMAIL,
          content,
          // What the email adapter attaches, minus anything a test cannot know.
          metadata: {
            participants: [{ email: UNKNOWN_SENDER_EMAIL, role: 'from' }],
            nylasMessageId: `smoke-msg-${randomUUID()}`,
            isAutoGenerated: false,
            autoGeneratedSignals: [],
          },
        })
      : createInboundMessage({
          conversationId,
          // The contact resolver treats smoke-test as a local console session: the principal.
          channelId: 'smoke-test',
          senderId: 'smoke-test-user',
          content,
        });
    return bus.publish('channel', inbound);
  }

  async function sendMessage(options: {
    conversationId: string;
    content: string;
    sender?: SmokeSender;
    target?: { spec: CaseTarget; thread: TargetThread };
  }): Promise<TurnResponse> {
    const start = Date.now();
    const sender = options.sender ?? 'principal';
    const target = options.target;
    if (target && target.thread.threadId !== options.conversationId) {
      // The agent's events carry the thread id; a different id would never match them.
      throw new Error('a targeted turn must use its thread id as the conversation id');
    }
    const agentId = target?.spec.agent ?? 'coordinator';
    // capture.fail() is keyed by conversation, and later turns of a case reuse this
    // conversation id. Once this turn has its outcome, its own late handlers below must
    // not fail whichever turn is pending by then.
    let turnEnded = false;
    const waiter = capture.waitFor(options.conversationId, RESPONSE_TIMEOUT_MS, agentId)
      .then((outcome) => { turnEnded = true; return outcome; });
    const failThisTurn = (err: unknown): void => {
      if (!turnEnded) capture.fail(options.conversationId, err);
    };

    let delivery: Promise<void>;
    try {
      delivery = target
        ? postOnThread(target.spec, target.thread, options.content)
        : publishInbound(options.conversationId, options.content, sender);
    } catch (err) {
      failThisTurn(err);
      delivery = Promise.resolve();
    }
    // A publish that fails outright must end the turn now, not after the timeout. One that
    // completes without the agent's response ends it shortly after, instead of waiting
    // out the timeout. Both are no-ops once this turn has its outcome.
    delivery.then(
      () => {
        // unref: the grace timer alone must not keep the process alive at shutdown.
        setTimeout(() => failThisTurn(new Error(`the turn ended without a response from ${agentId}`)), NO_RESPONSE_GRACE_MS).unref();
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
    openTargetThread,
    closeTargetThread,
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
