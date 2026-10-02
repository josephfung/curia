// tests/scenarios/harness.ts — boots the test-mode stack once and runs single scenario
// runs on it (#1956).
//
// What a run goes through is production's path: the Dispatcher resolves the sender,
// injects the [ACTIVE OUTBOUND CONTEXT] block and builds the agent.task; the coordinator
// runtime assembles the production prompt and calls the model; tool calls go through
// the ExecutionLayer (wrapped by the stub layer); the runtime formats failures as
// <task_error>. The harness only adds seeding, stubs and capture.
//
// Capture listens as the `system` layer, which unlike the smoke harness's `channel`
// subscription also sees agent.response — so a NO_REPLY turn, or a reply Gate C holds
// for a non-principal sender, still ends the run instead of timing out.
import { randomUUID } from 'node:crypto';
import type { EventBus } from '../../src/bus/bus.js';
import {
  createAgentDiscuss,
  createInboundMessage,
  type AgentErrorEvent,
  type AgentResponseEvent,
  type BusEvent,
  type OutboundNoReplyEvent,
  type ToolInvokeEvent,
  type ToolResultEvent,
} from '../../src/bus/events.js';
import { loadConfig } from '../../src/config.js';
import { BullpenDispatcher } from '../../src/dispatch/bullpen-dispatcher.js';
import { Dispatcher } from '../../src/dispatch/dispatcher.js';
import { createTestModeStack, type TestModeStack } from '../../src/startup/test-mode-stack.js';
import { internalNamesFor } from './assertions.js';
import { resolvePlaceholders } from './loader.js';
import {
  cleanupRun,
  createOutboundContextService,
  resolveSender,
  scopedBullpen,
  scopedOutboundContext,
  SeedScope,
  seedRun,
  type SeededRun,
} from './seed.js';
import { createStubController, type StubController, type StubbedCall } from './stub-layer.js';
import type { CapturedToolCall, ScenarioCase, ScenarioRun } from './types.js';

const COORDINATOR = 'coordinator';

/** Set on every connection the suite opens, so the busy-database guard can skip them. */
export const SCENARIO_APPLICATION_NAME = 'curia-scenarios';

const _rawTimeout = parseInt(process.env.SCENARIO_TIMEOUT_MS ?? '', 10);
/** Per-run wait for the coordinator's agent.response. Default 180s. */
export const RUN_TIMEOUT_MS = Number.isFinite(_rawTimeout) && _rawTimeout > 0 ? _rawTimeout : 180_000;

/**
 * After agent.response, wait this long for the Dispatcher's follow-up events
 * (outbound.no_reply) before closing the run. They are published in the same tick
 * chain, so a short settle is enough.
 */
const SETTLE_MS = 250;

export interface ScenarioHarness {
  stack: TestModeStack;
  stubs: StubController;
  /** Identifiers a principal- or external-facing reply must not contain. */
  internalNames: string[];
  /** Tool names the coordinator is offered (for stub validation). */
  coordinatorTools: Set<string>;
  runOnce(scenario: ScenarioCase, runIndex: number): Promise<ScenarioRun>;
  shutdown(): Promise<void>;
}

function withApplicationName(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('application_name', SCENARIO_APPLICATION_NAME);
  return url.toString();
}

/**
 * Other clients connected to this database. A running Curia instance would act on the
 * entries and threads a run seeds (and its scheduler would race the run), so the CLI
 * refuses to start while any exist unless told otherwise.
 */
export async function otherDatabaseClients(stack: TestModeStack): Promise<Array<{ application: string; count: number }>> {
  const result = await stack.pool.query<{ application: string; count: string }>(
    `SELECT coalesce(nullif(application_name, ''), '(unnamed)') AS application, count(*)::text AS count
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND backend_type = 'client backend'
        AND coalesce(application_name, '') <> $1
      GROUP BY 1
      ORDER BY 1`,
    [SCENARIO_APPLICATION_NAME],
  );
  return result.rows.map(r => ({ application: r.application, count: Number(r.count) }));
}

export async function createScenarioHarness(options: { model?: string } = {}): Promise<ScenarioHarness> {
  const scope = new SeedScope();
  const config = loadConfig();
  // The registry exists only once the stack is built; the stub layer reads it lazily.
  let booted: TestModeStack | undefined;
  const controller = createStubController(() => {
    if (!booted) throw new Error('scenario harness: tool call before the stack finished booting');
    return booted.toolRegistry;
  });

  const stack = await createTestModeStack({
    config: { ...config, databaseUrl: withApplicationName(config.databaseUrl) },
    model: options.model,
    wrapExecutionLayer: (layer) => controller.wrap(layer),
    wrapBullpenService: (bullpen) => scopedBullpen(bullpen, scope),
  });
  booted = stack;

  const { bus, logger } = stack;
  const outboundContext = createOutboundContextService(stack);

  // Production's Dispatcher, given an outbound-context service so it injects the
  // block — narrowed to the run's own entries.
  new Dispatcher({
    bus,
    logger,
    contactResolver: stack.contactResolver,
    channelPolicies: undefined,
    outboundContextService: scopedOutboundContext(outboundContext, scope),
  }).register();
  // Bullpen mentions reach the coordinator the way they do in production.
  new BullpenDispatcher(bus, logger, stack.bullpenService, stack.agentRegistry).register();

  const capture = createCapture(bus);
  const coordinator = stack.agent(COORDINATOR);
  const coordinatorTools = new Set(coordinator.toolDefs.map(t => t.name));
  const internalNames = internalNamesFor({
    tools: [...stack.toolRegistry.list().map(t => t.manifest.name)],
    agents: stack.agentRegistry.list().map(a => a.name),
  });

  async function runOnce(scenario: ScenarioCase, runIndex: number): Promise<ScenarioRun> {
    const started = Date.now();
    // Set once seeding succeeds. seedRun removes its own partial rows when it throws, so
    // a failed seed becomes this run's error instead of aborting the suite.
    let seeded: SeededRun | undefined;
    let conversationId: string | undefined;
    let stubbedCalls: StubbedCall[] = [];
    let inboundContent = '';
    try {
      seeded = await seedRun(scenario, { stack, outboundContext, scope });
      const stubTable = resolvePlaceholders(scenario.toolStubs, seeded.refs);
      const inbound = resolvePlaceholders(scenario.inbound, seeded.refs);
      inboundContent = inbound.content;

      const sender = await resolveSender(scenario, stack);
      const timeoutMs = scenario.timeoutSeconds ? scenario.timeoutSeconds * 1000 : RUN_TIMEOUT_MS;
      controller.beginRun(stubTable);
      let outcome: CaptureOutcome;
      try {
        if (sender === 'bullpen') {
          const thread = seeded.threads.get(inbound.thread!)!;
          conversationId = thread.threadId;
          const waiter = capture.waitFor(conversationId, timeoutMs);
          // Posted by the thread's creator, mentioning the coordinator — the event a
          // specialist's bullpen reply produces. BullpenDispatcher turns it into the
          // coordinator's agent.task.
          const creator = scenario.seed.bullpen.find(t => t.key === inbound.thread)!.creatorAgentId;
          const message = await stack.bullpenService.postMessage(thread.threadId, creator, inbound.content, [COORDINATOR]);
          await bus.publish('agent', createAgentDiscuss({
            threadId: thread.threadId,
            messageId: message.id,
            topic: thread.topic,
            senderAgentId: creator,
            participants: thread.participants,
            mentionedAgentIds: [COORDINATOR],
            content: inbound.content,
            parentEventId: randomUUID(),
          }));
          outcome = await waiter;
        } else {
          conversationId = sender.channelId === 'email'
            ? `email:scenario-${randomUUID()}`
            : `scenario-${randomUUID()}`;
          const waiter = capture.waitFor(conversationId, timeoutMs);
          await bus.publish('channel', createInboundMessage({
            conversationId,
            channelId: sender.channelId,
            senderId: sender.senderId,
            content: inbound.content,
            ...(sender.channelId === 'email' ? { metadata: emailMetadata(sender.senderId, inbound.email) } : {}),
          }));
          outcome = await waiter;
        }
      } finally {
        stubbedCalls = controller.endRun();
      }

      const merged = mergeCalls(outcome.calls, stubbedCalls);
      return {
        runIndex,
        inboundContent,
        refs: Object.fromEntries(seeded.refs),
        toolCalls: merged,
        reply: outcome.reply,
        ...(outcome.noReplyReason ? { noReplyReason: outcome.noReplyReason } : {}),
        durationMs: Date.now() - started,
        unstubbedCalls: countHoles(merged),
        ...(outcome.error ? { error: outcome.error } : {}),
      };
    } catch (err) {
      return {
        runIndex,
        inboundContent,
        refs: seeded ? Object.fromEntries(seeded.refs) : {},
        toolCalls: [],
        reply: null,
        durationMs: Date.now() - started,
        unstubbedCalls: stubbedCalls.filter(c => c.disposition === 'refused' && c.agentId === COORDINATOR).length,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (seeded) await cleanupRun(stack, seeded, scope, conversationId);
    }
  }

  return {
    stack,
    stubs: controller,
    internalNames,
    coordinatorTools,
    runOnce,
    shutdown: () => stack.shutdown(),
  };
}

/**
 * Calls the harness, not the model, decided: refused by the stub layer, or a real
 * read-only tool that failed because test mode cannot serve it (no mail client, no
 * task service…). Either way the model reacted to the harness's gap. Counting failed
 * passthroughs here means a newly unservable read shows up in the coverage gate with
 * no list of "tools that don't work in test mode" to keep current.
 */
export function countHoles(calls: CapturedToolCall[]): number {
  return calls.filter(c =>
    c.disposition === 'refused' || (c.disposition === 'passthrough' && c.result?.success === false),
  ).length;
}

/** The metadata the email adapter attaches, minus anything a scenario cannot know. */
function emailMetadata(senderEmail: string, email: ScenarioCase['inbound']['email']): Record<string, unknown> {
  return {
    participants: [{ email: senderEmail, role: 'from' }],
    nylasMessageId: email?.nylasMessageId ?? `scenario-msg-${randomUUID()}`,
    isAutoGenerated: email?.autoGenerated ?? false,
    autoGeneratedSignals: email?.autoGeneratedSignals ?? [],
  };
}

/** The bus view (what the model saw) joined with the stub layer's view (how it was answered). */
function mergeCalls(observed: CapturedToolCall[], stubbed: StubbedCall[]): CapturedToolCall[] {
  const coordinatorStubbed = stubbed.filter(s => s.agentId === COORDINATOR);
  return observed.map((call, i) => {
    const s = coordinatorStubbed[i];
    // Both lists are in invocation order for the one coordinator turn. A name mismatch
    // means a call bypassed the stub layer — keep the bus record, mark it passthrough.
    return { ...call, disposition: s && s.toolName === call.name ? s.disposition : 'passthrough' };
  });
}

// ── Bus capture ────────────────────────────────────────────────────────────

interface CaptureOutcome {
  calls: CapturedToolCall[];
  reply: string | null;
  noReplyReason?: string;
  error?: string;
}

interface PendingCapture {
  calls: CapturedToolCall[];
  invokeIndex: Map<string, number>;
  reply: string | null;
  noReplyReason?: string;
  error?: string;
  done: boolean;
  resolve: (outcome: CaptureOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

function createCapture(bus: EventBus): { waitFor(conversationId: string, timeoutMs: number): Promise<CaptureOutcome> } {
  const pending = new Map<string, PendingCapture>();

  const finish = (conversationId: string, p: PendingCapture): void => {
    if (p.done) return;
    p.done = true;
    clearTimeout(p.timer);
    // Let the Dispatcher's follow-up (outbound.no_reply) land before closing.
    setTimeout(() => {
      pending.delete(conversationId);
      p.resolve({
        calls: p.calls,
        reply: p.reply,
        ...(p.noReplyReason ? { noReplyReason: p.noReplyReason } : {}),
        ...(p.error ? { error: p.error } : {}),
      });
    }, SETTLE_MS);
  };

  const forCoordinator = (agentId: string, conversationId: string): PendingCapture | undefined =>
    agentId === COORDINATOR ? pending.get(conversationId) : undefined;

  const on = (type: BusEvent['type'], handler: (event: BusEvent) => void): void => {
    bus.subscribe(type, 'system', async (event) => handler(event));
  };

  on('tool.invoke', (event) => {
    const { payload } = event as ToolInvokeEvent;
    const p = forCoordinator(payload.agentId, payload.conversationId);
    if (!p || p.done) return;
    p.invokeIndex.set(event.id, p.calls.length);
    p.calls.push({ name: payload.toolName, input: payload.input, disposition: 'passthrough' });
  });

  on('tool.result', (event) => {
    const { payload, parentEventId } = event as ToolResultEvent;
    const p = forCoordinator(payload.agentId, payload.conversationId);
    if (!p || p.done || !parentEventId) return;
    const index = p.invokeIndex.get(parentEventId);
    if (index === undefined) return;
    const result = payload.result;
    p.calls[index]!.result = result.success
      ? { success: true, data: result.data }
      : { success: false, error: result.error };
  });

  on('agent.response', (event) => {
    const { payload } = event as AgentResponseEvent;
    const p = forCoordinator(payload.agentId, payload.conversationId);
    if (!p) return;
    // The runtime lifts an exact NO_REPLY out of the content before publishing (#1732):
    // what arrives is empty content with suppressDelivery. Put the sentinel back so
    // checks and the judge see the decision the model made. A narrated decline
    // ("NO_REPLY — automated notice") keeps its text and suppressDelivery, so it still
    // reads as not-exactly-NO_REPLY — which is the failure the check exists to catch.
    p.reply = payload.suppressDelivery && payload.content === '' ? 'NO_REPLY' : payload.content;
    if (payload.isError) p.error = `coordinator returned an error response: ${payload.content.slice(0, 200)}`;
    finish(payload.conversationId, p);
  });

  on('agent.error', (event) => {
    const { payload } = event as AgentErrorEvent;
    const p = forCoordinator(payload.agentId, payload.conversationId);
    if (!p) return;
    p.error = `agent.error ${payload.errorType}: ${payload.message}`;
    finish(payload.conversationId, p);
  });

  on('outbound.no_reply', (event) => {
    const { payload } = event as OutboundNoReplyEvent;
    const p = pending.get(payload.conversationId);
    if (p) p.noReplyReason = payload.reason;
  });

  return {
    waitFor(conversationId, timeoutMs) {
      return new Promise((resolve) => {
        const p: PendingCapture = {
          calls: [],
          invokeIndex: new Map(),
          reply: null,
          done: false,
          resolve,
          timer: setTimeout(() => {
            p.error = `Timeout waiting for the coordinator (${Math.round(timeoutMs / 1000)}s)`;
            finish(conversationId, p);
          }, timeoutMs),
        };
        pending.set(conversationId, p);
      });
    },
  };
}
