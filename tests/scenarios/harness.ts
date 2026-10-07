// tests/scenarios/harness.ts — boots the test-mode stack once and runs single scenario
// runs on it (#1956).
//
// What a run goes through is production's path: the Dispatcher resolves the sender,
// injects the [ACTIVE OUTBOUND CONTEXT] block and builds the agent.task; the coordinator
// runtime assembles the production prompt and calls the model; tool calls go through
// the ExecutionLayer (wrapped by the stub layer); the runtime formats failures as
// <task_error>. The harness only adds seeding, stubs and capture.
//
// Capture (tests/shared/turn-capture.ts) listens as the `system` layer, so a NO_REPLY
// turn, or a reply Gate C holds for a non-principal sender, still ends the run instead
// of timing out.
//
// Runs of different cases overlap (#1980). Each attempt runs inside its own case context
// (tests/shared/case-scope.ts): the seeded-state views, the model-call guard and the cost
// meter all find the calling run through it. A run that times out is cancelled, so its
// abandoned turn stops calling the model.
import { randomUUID } from 'node:crypto';
import { createAgentDiscuss, createAgentTask, createInboundMessage } from '../../src/bus/events.js';
import { loadConfig } from '../../src/config.js';
import { BullpenDispatcher } from '../../src/dispatch/bullpen-dispatcher.js';
import { Dispatcher } from '../../src/dispatch/dispatcher.js';
import { createTestModeStack, type TestModeStack } from '../../src/startup/test-mode-stack.js';
import {
  closeAttempt,
  createCaseContext,
  guardProvider,
  meterAgentCalls,
  newAttempt,
  PROVIDER_RETRIES,
  providerFailure,
  stalledCallMs,
  type CaseAttempt,
} from '../shared/case-scope.js';
import { sumBreakdowns, UsageLedger, type UsageBreakdown } from '../shared/usage.js';
import {
  cleanupConversation,
  createTurnCapture,
  withoutRecentHistory,
  type ObservedToolCall,
  type TurnOutcome,
} from '../shared/turn-capture.js';
import { internalNamesFor } from './assertions.js';
import { resolvePlaceholders, type RunClock } from './loader.js';
import { resolveDatePlaceholders } from '../shared/date-placeholders.js';
import {
  cleanupRun,
  createOutboundContextService,
  resolveSender,
  scopedBullpen,
  scopedOutboundContext,
  SeedScope,
  describeError,
  seedRun,
  sweepLeftovers,
  type SeededRun,
} from './seed.js';
import { createStubController, type StubController, type StubbedCall } from './stub-layer.js';
import type { CapturedToolCall, ScenarioCase, ScenarioRun } from './types.js';

const COORDINATOR = 'coordinator';

/** Prefix of the application_name every suite process sets on its connections. */
export const SCENARIO_APPLICATION_PREFIX = 'curia-scenarios';

/**
 * This process's application_name. Per process, so the busy-database guard skips only its
 * own connections and still sees another suite's.
 */
export const SCENARIO_APPLICATION_NAME = `${SCENARIO_APPLICATION_PREFIX}-${process.pid}`;

/** Per-run wait for the coordinator's agent.response. Default 180s; SCENARIO_TIMEOUT_MS overrides. */
export const RUN_TIMEOUT_MS = parseTimeout(process.env.SCENARIO_TIMEOUT_MS);

/** A set-but-invalid value is an error, not a silent fallback to the default. */
export function parseTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 180_000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`SCENARIO_TIMEOUT_MS must be a positive integer of milliseconds (got '${raw}')`);
  }
  return value;
}

/** How long shutdown waits for turns that outlived their run's timeout. */
const LATE_TURN_GRACE_MS = 60_000;

/**
 * After a run ends and is cancelled, how long to wait for its leftover work to wind down
 * before removing its rows and reading its spend. A cancelled turn ends at its next model
 * call; one that runs longer is left to shutdown, its spend counted outside any run.
 */
const CANCEL_SETTLE_MS = 30_000;

/** One attempt at a run: what the case context carries. */
interface ScenarioRunState extends CaseAttempt {
  /** The rows this attempt seeded, which are all its views show. */
  scope: SeedScope;
}

export interface ScenarioHarness {
  stack: TestModeStack;
  stubs: StubController;
  /** Identifiers a principal- or external-facing reply must not contain. */
  internalNames: string[];
  /** Tool names the coordinator is offered (for stub validation). */
  coordinatorTools: Set<string>;
  /**
   * What the coordinator is offered plus what it can load mid-turn with skill-activate
   * (#2024): a case may stub and check those too, since activation is the behavior
   * under test.
   */
  reachableTools: Set<string>;
  /** Tools test mode cannot serve; the stub layer refuses them unless a case stubs them. */
  unavailableTools: ReadonlySet<string>;
  /** Tools served from an MCP snapshot; the stub layer runs them unstubbed (#2024). */
  inertTools: ReadonlySet<string>;
  /**
   * One run of a case. An attempt that fails for a provider reason is run again, up to
   * PROVIDER_RETRIES times, and the run records why (#1980).
   */
  runOnce(scenario: ScenarioCase, runIndex: number, options?: { onProviderRetry?: (reason: string) => void }): Promise<ScenarioRun>;
  /** Model spend no run's figure includes: outside every run, or billed after its run ended. */
  unattributedUsage(): UsageBreakdown;
  /** Remove rows an interrupted run left behind (by the suite's own markers). */
  sweep(): Promise<Record<string, number>>;
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
        -- backend_type is NULL for another role's session unless we hold
        -- pg_read_all_stats; an unknown session counts as a client, not as nothing.
        AND (backend_type = 'client backend' OR backend_type IS NULL)
        AND coalesce(application_name, '') <> $1
      GROUP BY 1
      ORDER BY 1`,
    [SCENARIO_APPLICATION_NAME],
  );
  return result.rows.map(r => ({ application: r.application, count: Number(r.count) }));
}

/**
 * Hold a session-level advisory lock for the suite's lifetime, so a second `pnpm
 * scenarios` on the same database refuses to start. otherDatabaseClients() cannot see
 * it (it skips this suite's own application_name), and two suites would delete each
 * other's tagged fixtures. Returns a release function, or null when the lock is held.
 */
export async function acquireSuiteLock(stack: TestModeStack): Promise<(() => Promise<void>) | null> {
  const client = await stack.pool.connect();
  try {
    const result = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
      [SCENARIO_APPLICATION_PREFIX],
    );
    if (!result.rows[0]?.locked) {
      client.release();
      return null;
    }
  } catch (err) {
    client.release();
    throw err;
  }
  return async () => {
    try {
      await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [SCENARIO_APPLICATION_PREFIX]);
    } finally {
      client.release();
    }
  };
}

export async function createScenarioHarness(options: { model?: string } = {}): Promise<ScenarioHarness> {
  const context = createCaseContext<ScenarioRunState>();
  const currentScope = (): SeedScope | undefined => context.current()?.scope;
  const config = loadConfig();
  // The registry exists only once the stack is built; the stub layer reads it lazily.
  let booted: TestModeStack | undefined;
  let unavailable: ReadonlySet<string> = new Set();
  const controller = createStubController(
    () => {
      if (!booted) throw new Error('scenario harness: tool call before the stack finished booting');
      return booted.toolRegistry;
    },
    () => unavailable,
    () => booted?.snapshotMcpTools ?? new Set(),
  );

  const stack = await createTestModeStack({
    config: { ...config, databaseUrl: withApplicationName(config.databaseUrl) },
    model: options.model,
    wrapExecutionLayer: (layer) => controller.wrap(layer),
    wrapBullpenService: (bullpen) => scopedBullpen(bullpen, currentScope),
    // Times each model call against its run, and refuses a cancelled run's calls.
    wrapLlmProvider: (provider) => guardProvider(provider, context.current),
    // No contact recent history: every case starts from a clean slate.
    wrapWorkingMemory: withoutRecentHistory,
  });
  booted = stack;
  // Tools any agent is offered that test mode refuses for a missing capability.
  unavailable = new Set(Object.values(stack.disabledTools).flat().map(d => d.tool));

  const { bus, logger } = stack;
  const outboundContext = createOutboundContextService(stack);

  // Production's Dispatcher, given an outbound-context service so it injects the
  // block — narrowed to the run's own entries.
  new Dispatcher({
    bus,
    logger,
    contactResolver: stack.contactResolver,
    channelPolicies: undefined,
    outboundContextService: scopedOutboundContext(outboundContext, currentScope),
  }).register();
  // Bullpen mentions reach the coordinator the way they do in production.
  new BullpenDispatcher(bus, logger, stack.bullpenService, stack.agentRegistry).register();

  const capture = createTurnCapture(bus);
  // Every model call billed to the run it was made in (#1980).
  const unattributed = new UsageLedger();
  meterAgentCalls(bus, context.current, unattributed);
  const coordinator = stack.agent(COORDINATOR);
  const coordinatorTools = new Set(coordinator.toolDefs.map(t => t.name));
  // Production's own activation check, per skill: what skill-activate would hand the
  // coordinator. Only with discovery on — without it the coordinator has no skill-activate.
  const reachableTools = new Set(coordinatorTools);
  if (coordinator.agentConfig.allow_discovery) {
    for (const skill of stack.skillRegistry.list()) {
      const activation = stack.executionLayer.resolveSkillActivationForAgent(skill.manifest.name, COORDINATOR);
      if (!('error' in activation)) for (const tool of activation.tools) reachableTools.add(tool);
    }
  }
  const internalNames = internalNamesFor({
    tools: [...stack.toolRegistry.list().map(t => t.manifest.name)],
    agents: stack.agentRegistry.list().map(a => a.name),
  });

  /**
   * Turns still running after their run gave up on them. EventBus.publish awaits every
   * subscriber, so publishing an inbound resolves only when the whole coordinator turn
   * has finished; runs therefore do NOT await it — they race the capture's timeout —
   * and a turn that outlives its run is tracked here. When one finally ends, its
   * conversation rows are cleaned again (it wrote turns after the run's cleanup), and
   * shutdown waits for them before closing the pool.
   */
  const lateTurns = new Map<Promise<void>, ScenarioRunState | undefined>();

  function trackDelivery(delivery: Promise<void>, conversationId: string): void {
    const settled: Promise<void> = delivery
      .catch((err: unknown) => {
        // The run has its outcome already (via capture.fail or its timeout); this only
        // records that the late turn ended in an error.
        logger.error({ err, conversationId }, 'scenario harness: a coordinator turn failed');
      })
      .then(() => cleanupConversation(stack.pool, conversationId))
      .catch((err: unknown) => {
        logger.error({ err, conversationId }, 'scenario harness: late conversation cleanup failed');
        process.stderr.write(`  [WARN] late cleanup failed for ${conversationId}: ${err instanceof Error ? err.message : String(err)}\n`);
      })
      .finally(() => { lateTurns.delete(settled); });
    lateTurns.set(settled, context.current());
  }

  /** Wait (up to `maxMs`) for `state`'s turns still running; false if some still are. */
  async function settle(state: ScenarioRunState, maxMs: number): Promise<boolean> {
    const own = (): Array<Promise<void>> => [...lateTurns].filter(([, s]) => s === state).map(([p]) => p);
    if (own().length === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(own()),
      new Promise(resolve => { timer = setTimeout(resolve, maxMs); timer.unref(); }),
    ]);
    clearTimeout(timer);
    return own().length === 0;
  }

  async function runOnce(
    scenario: ScenarioCase,
    runIndex: number,
    options: { onProviderRetry?: (reason: string) => void } = {},
  ): Promise<ScenarioRun> {
    const providerRetries: string[] = [];
    const spent: UsageBreakdown[] = [];
    for (;;) {
      const { run, providerReason } = await attempt(scenario, runIndex);
      spent.push(run.usage);
      if (providerReason && providerRetries.length < PROVIDER_RETRIES) {
        providerRetries.push(providerReason);
        options.onProviderRetry?.(providerReason);
        continue;
      }
      return { ...run, usage: sumBreakdowns(spent), providerRetries };
    }
  }

  /** One attempt at a run, in a fresh case context with its own seeded rows. */
  async function attempt(scenario: ScenarioCase, runIndex: number): Promise<{ run: ScenarioRun; providerReason?: string }> {
    const state: ScenarioRunState = { ...newAttempt(`${scenario.name} run ${runIndex + 1}`), scope: new SeedScope() };
    return context.run(state, () => attemptInContext(scenario, runIndex, state));
  }

  async function attemptInContext(
    scenario: ScenarioCase,
    runIndex: number,
    state: ScenarioRunState,
  ): Promise<{ run: ScenarioRun; providerReason?: string }> {
    const { scope } = state;
    const started = Date.now();
    let providerReason: string | undefined;
    // Set once seeding succeeds. seedRun removes its own partial rows when it throws, so
    // a failed seed becomes this run's error instead of aborting the suite.
    let seeded: SeededRun | undefined;
    let conversationId: string | undefined;
    let stubbedCalls: StubbedCall[] = [];
    let inboundContent = '';
    let cleanupError: string | undefined;
    // Filled by the try/catch, finished after cleanup so a cleanup failure can be attached.
    let result: ScenarioRun;
    // One clock per run (#1958). The inbound, the stubs and the seeded rows must agree on
    // what "next week" is, and rating re-resolves the behaviors against this same instant
    // (resolveRunPlaceholders), even if it happens after midnight.
    const clock: RunClock = { now: new Date().toISOString(), timezone: stack.config.timezone };
    const resolveDates = <T>(value: T): T => resolveDatePlaceholders(value, clock.timezone, new Date(clock.now));
    const dated: ScenarioCase = {
      ...scenario,
      seed: resolveDates(scenario.seed),
      inbound: resolveDates(scenario.inbound),
      toolStubs: resolveDates(scenario.toolStubs),
    };
    try {
      seeded = await seedRun(dated, { stack, outboundContext, scope });
      const stubTable = resolvePlaceholders(dated.toolStubs, seeded.refs);
      const inbound = resolvePlaceholders(dated.inbound, seeded.refs);
      inboundContent = inbound.content;

      const sender = await resolveSender(scenario, stack);
      const timeoutMs = scenario.timeoutSeconds ? scenario.timeoutSeconds * 1000 : RUN_TIMEOUT_MS;
      const thread = sender === 'bullpen' ? seeded.threads.get(inbound.thread!)! : undefined;
      const runConversationId = thread
        ? thread.threadId // BullpenDispatcher uses the thread id as the conversation
        : sender === 'scheduler'
          ? `scheduler:scenario-${randomUUID()}:${randomUUID()}` // scheduler:<job>:<run>
          : sender !== 'bullpen' && sender.channelId === 'email'
            ? `email:scenario-${randomUUID()}`
            : `scenario-${randomUUID()}`;
      conversationId = runConversationId;

      controller.beginRun(stubTable, runConversationId);
      let outcome: TurnOutcome;
      try {
        const waiter = capture.waitFor(runConversationId, timeoutMs);
        let delivery: Promise<void>;
        if (thread) {
          // Posted by the thread's creator, mentioning the coordinator — the event a
          // specialist's bullpen reply produces. BullpenDispatcher turns it into the
          // coordinator's agent.task.
          const creator = scenario.seed.bullpen.find(t => t.key === inbound.thread)!.creatorAgentId;
          const message = await stack.bullpenService.postMessage(thread.threadId, creator, inbound.content, [COORDINATOR]);
          delivery = bus.publish('agent', createAgentDiscuss({
            threadId: thread.threadId,
            messageId: message.id,
            topic: thread.topic,
            senderAgentId: creator,
            participants: thread.participants,
            mentionedAgentIds: [COORDINATOR],
            content: inbound.content,
            parentEventId: randomUUID(),
          }));
        } else if (sender === 'scheduler') {
          // What Scheduler.fireJob publishes for a recurring job with no linked task: an
          // agent.task straight to the agent, no Dispatcher, content = the payload JSON.
          delivery = bus.publish('system', createAgentTask({
            agentId: COORDINATOR,
            conversationId: runConversationId,
            channelId: 'scheduler',
            senderId: 'scheduler',
            content: JSON.stringify({ task: inbound.content }),
            parentEventId: randomUUID(),
          }));
        } else if (sender !== 'bullpen') {
          delivery = bus.publish('channel', createInboundMessage({
            conversationId: runConversationId,
            channelId: sender.channelId,
            senderId: sender.senderId,
            content: inbound.content,
            ...(sender.channelId === 'email' ? { metadata: emailMetadata(sender.senderId, inbound.email) } : {}),
          }));
        } else {
          throw new Error('unreachable: bullpen sender without a thread');
        }
        // A publish that fails outright (no handler, a throwing subscriber) must end the
        // run now, not after the timeout.
        delivery.catch((err: unknown) => capture.fail(runConversationId, err));
        trackDelivery(delivery, runConversationId);
        outcome = await waiter;
      } finally {
        stubbedCalls = controller.endRun(runConversationId);
      }
      if (outcome.error) {
        // Measured before cancelling, while a stalled call is still in flight.
        providerReason = providerFailure({
          ...(outcome.errorKind ? { kind: outcome.errorKind } : {}),
          ...(outcome.errorType ? { errorType: outcome.errorType } : {}),
          stalledCallMs: stalledCallMs(state),
        });
      }
      // The run has its outcome, passed or not; whatever it still has running must stop
      // spending. Waited for (bounded) so nothing is still acting while its rows are removed.
      state.cancelled = true;
      if (!(await settle(state, CANCEL_SETTLE_MS))) {
        process.stderr.write(`  [WARN] ${state.label}: a turn was still running ${CANCEL_SETTLE_MS / 1000}s after the run ended; its later spend is counted outside any run\n`);
      }

      const merged = mergeCalls(outcome.calls, stubbedCalls);
      // A scoped view failing means the case ran without its premise (no block, no thread).
      const premiseError = scope.errors.length > 0 ? `seeded state was not visible: ${scope.errors.join('; ')}` : undefined;
      result = {
        runIndex,
        inboundContent,
        refs: Object.fromEntries(seeded.refs),
        clock,
        toolCalls: merged,
        reply: outcome.reply,
        ...(outcome.noReplyReason ? { noReplyReason: outcome.noReplyReason } : {}),
        durationMs: Date.now() - started,
        unstubbedCalls: countHoles(merged),
        ...(outcome.error ?? premiseError ? { error: outcome.error ?? premiseError } : {}),
        usage: state.usage.snapshot(),
        providerRetries: [],
      };
    } catch (err) {
      result = {
        runIndex,
        inboundContent,
        refs: seeded ? Object.fromEntries(seeded.refs) : {},
        clock,
        toolCalls: [],
        reply: null,
        durationMs: Date.now() - started,
        unstubbedCalls: stubbedCalls.filter(c => c.disposition === 'refused' && c.agentId === COORDINATOR).length,
        error: describeError(err),
        usage: state.usage.snapshot(),
        providerRetries: [],
      };
    } finally {
      if (seeded) {
        // Recorded on the run, not thrown: a throw here would replace the run's result
        // and abort the suite, losing every paid run before it. gateFailures reports it.
        try {
          await cleanupRun(stack, seeded, scope, conversationId);
        } catch (err) {
          cleanupError = describeError(err);
          process.stderr.write(`  [WARN] cleanup failed after '${scenario.name}' run ${runIndex + 1}: ${cleanupError}\n`);
        }
      }
    }
    // Spend billed from here on is no longer this run's figure (case-scope.ts: closeAttempt).
    closeAttempt(state);
    const run = cleanupError ? { ...result, cleanupError } : result;
    return { run, ...(providerReason ? { providerReason } : {}) };
  }

  return {
    stack,
    stubs: controller,
    internalNames,
    coordinatorTools,
    reachableTools,
    unavailableTools: unavailable,
    inertTools: stack.snapshotMcpTools,
    runOnce,
    unattributedUsage: () => unattributed.snapshot(),
    sweep: () => sweepLeftovers(stack),
    shutdown: async () => {
      // Late turns still hold the pool; wait (bounded) so their writes and cleanup land.
      if (lateTurns.size > 0) {
        process.stderr.write(`  waiting up to ${LATE_TURN_GRACE_MS / 1000}s for ${lateTurns.size} timed-out turn(s) to finish...\n`);
        await Promise.race([
          Promise.allSettled([...lateTurns.keys()]),
          new Promise(resolve => setTimeout(resolve, LATE_TURN_GRACE_MS)),
        ]);
      }
      await stack.shutdown();
    },
  };
}

/**
 * Calls the harness, not the model, decided: refused by the stub layer — an unstubbed
 * side-effecting tool, or a read test mode cannot serve (missing capability). Either way
 * the model reacted to the harness's gap, so the coverage gate counts it.
 */
export function countHoles(calls: CapturedToolCall[]): number {
  // A passthrough read that fails is a real outcome (e.g. date-resolve rejecting
  // "next week"): production returns the same. Tools test mode cannot serve are refused
  // up front (see mustStub's `unavailable`), so they land here as refusals.
  return calls.filter(c => c.disposition === 'refused').length;
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

/**
 * The bus view (what the model saw) joined with the stub layer's view (how it was
 * answered), by tool.invoke event id. A bus call with no stub-layer record never reached
 * the ExecutionLayer: the runtime answered it itself (a tool outside the turn's
 * allowlist, a delegation its guard blocked). That is the model's doing, not a hole.
 */
function mergeCalls(observed: ObservedToolCall[], stubbed: StubbedCall[]): CapturedToolCall[] {
  const byInvoke = new Map(stubbed.filter(s => s.invokeEventId).map(s => [s.invokeEventId!, s]));
  return observed.map(call => {
    const s = call.invokeEventId ? byInvoke.get(call.invokeEventId) : undefined;
    return { ...call, disposition: s ? s.disposition : 'runtime' };
  });
}
