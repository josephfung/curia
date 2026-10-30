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
//
// A case with `delegation: real` (#2027) lets `delegate` run: production's handler starts
// the specialist (agent.task, requester identity, the pending_delegations claim, the
// wait and its timeout), and the specialist works under the same stub layer, in the same
// case context. Its calls, brief and response are captured beside the coordinator's
// (delegation-capture.ts), and its rows are cleaned with the run's.
//
// A case can instead reach a specialist directly (#2025): `agent: ceo-inbox` with a
// `delegate` inbound publishes the agent.task the delegate handler would, and the run
// captures that specialist's turn the way it captures the coordinator's. A `bullpen` or
// `scheduler` inbound reaches it the way a thread reply or its own schedule does.
//
// A case with `through_gateway: true` (#2312) runs its sends' real handlers through
// production's gateway review. The stack's recording transports put what passes in the run's
// scope (the case context finds it), approvals the review raises land in the action log under
// the run's conversation, and approve-action on a later live principal turn (a `followup`)
// acts only on the run's own. readGatewayOutcome reads all of it before cleanup removes it.
import { randomUUID } from 'node:crypto';
import { ActionLogRepo } from '../../src/autonomy/action-log-repo.js';
import { createAgentDiscuss, createAgentTask, createInboundMessage, type AgentTaskEvent, type InjectionDrainPoint } from '../../src/bus/events.js';
import { stampOriginator } from '../../src/contacts/stamp-originator.js';
import {
  buildInboundEmailIdentifierBlock,
  preambleAccountLabel,
  sanitizeNylasMessageId,
} from '../../src/dispatch/email-metadata.js';
import {
  clampDelegateWaitTimeoutMs,
  computeDelegateTimeoutMs,
  DELEGATE_DEFAULT_TIMEOUT_FLOOR_MS,
} from '../../src/agents/delegate-timeout.js';
import { loadConfig } from '../../src/config.js';
import { BullpenDispatcher } from '../../src/dispatch/bullpen-dispatcher.js';
import { Dispatcher } from '../../src/dispatch/dispatcher.js';
import { PrincipalAcquaintanceCheck } from '../../src/contacts/principal-acquaintance.js';
import type { NylasMessage } from '../../src/channels/email/nylas-client.js';
import { principalOrgDomainSet } from '../../src/contacts/non-org-domains.js';
import { OutreachMatcher } from '../../src/dispatch/outreach-matcher.js';
import { TaskOutreachRepo } from '../../src/dispatch/task-outreach.js';

/**
 * The scenario office's `security.principal_org_domains`: the test principal is
 * avery.testwell@example.test. Only an inbound with `sender_verified: true` is checked, so
 * cases without it never meet this rule (#2227).
 */
const SCENARIO_ORG_DOMAINS = ['example.test'];
import { recordedReplyViews } from '../../src/dispatch/outbound-context.js';
import { inboundSenderAuthenticated } from '../../src/dispatch/outbound-entry-access.js';
import { formatTaskWakeContent } from '../../src/scheduler/wake-disposition.js';
import { autonomyFixtureMismatch, createTestModeStack, runWithAutonomyFixture, type AutonomyFixture, type OfficeIdentityFixture, type TestModeStack, type TierReasoningOverride } from '../../src/startup/test-mode-stack.js';
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
  createTurnCapture,
  withoutRecentHistory,
  type ObservedToolCall,
  type TurnOutcome,
} from '../shared/turn-capture.js';
import { internalNamesFor } from './assertions.js';
import { publishFollowupOnTextFinish, turnStartDrainError, type TextFinishSlot } from './followup-exit.js';
import { createDelegationCapture, inRunOrder, type DelegationCapture, type DelegationTrace } from './delegation-capture.js';
import { discoverableTools } from './discovery.js';
import { applyReach } from './reach.js';
import { resolvePlaceholders, type RunClock } from './loader.js';
import { resolveDatePlaceholders } from '../shared/date-placeholders.js';
import {
  cleanupRun,
  createOutboundContextService,
  deletePendingDelegations,
  resolveEnvelope,
  readGatewayOutcome,
  resolveSender,
  acceptsRelay,
  SCENARIO_CURIA_EMAIL,
  scopedActionLog,
  scopedOutreachRepo,
  scopedBrowserSessionAlive,
  scopedBullpen,
  scopedOutboundContext,
  scopedPinnedContextReader,
  scopedPrincipalBacklog,
  scopedVerification,
  SeedScope,
  cleanupScenarioConversation,
  createOutcomeGate,
  runConversations,
  describeError,
  seedRun,
  sweepLeftovers,
  type ResolvedEnvelope,
  type ResolvedSender,
  type SeededRun,
} from './seed.js';
import { createStubController, type StubController, type StubbedCall } from './stub-layer.js';
import { COORDINATOR, type CapturedToolCall, type ScenarioCase, type ScenarioRun } from './types.js';
import type { AutonomyService } from '../../src/autonomy/autonomy-service.js';

/**
 * What a real-delegation run waits beyond the longest delegate wait: the coordinator's own
 * turn around it. The delegate wait must time out first, so its result is what gets scored.
 */
const DELEGATION_RUN_MARGIN_MS = 120_000;
/**
 * How long the first tool stays held while a follow-up is published (#2018).
 * Injection queues in well under this. Past it, the tool returns anyway, so a
 * run with the flag off still finishes instead of waiting out the case timeout.
 */
const FOLLOWUP_QUEUE_WAIT_MS = 5_000;

/** Conversation of the coordinator turn a held relay wakes to deliver its approval (buildApprovalDeliveryWake). */
const APPROVAL_WAKE_PREFIX = 'approval-delivery:';

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

/** A declared follow-up that never started publishing. The run must not be scored as one turn. */
export const FOLLOWUP_UNPUBLISHED_ERROR = 'inbound.followup was never published: the turn ended first';

/** Publish started, and the dispatcher did not queue the message into the live turn. */
export const FOLLOWUP_NOT_QUEUED_ERROR = 'follow-up was not queued into the live turn';

/**
 * Keep an error the turn already recorded (a timeout, a refused queue). Otherwise
 * fail a follow-up case whose second message never started.
 */
export function unpublishedFollowupError(
  hasFollowup: boolean,
  published: boolean,
  existingError: string | undefined,
): string | undefined {
  if (!hasFollowup || published) return existingError;
  return existingError ?? FOLLOWUP_UNPUBLISHED_ERROR;
}

/**
 * A publish that started still has to join the host. `undefined` means the
 * decision has not arrived: that is a miss, not a pass. An error already on
 * the turn stays.
 */
export function unjoinedFollowupError(
  hasFollowup: boolean,
  published: boolean,
  joinedHost: boolean | undefined,
  existingError: string | undefined,
): string | undefined {
  if (existingError !== undefined) return existingError;
  if (!hasFollowup || !published || joinedHost === true) return undefined;
  return FOLLOWUP_NOT_QUEUED_ERROR;
}

/**
 * Wait for an in-flight landing before either check. `published` and
 * `joinedHost` are read after it settles, so a decision still in flight is
 * not scored as a miss or a pass.
 */
export async function followupScoreError(input: {
  hasFollowup: boolean;
  published: () => boolean;
  landing: Promise<void> | undefined;
  joinedHost: () => boolean | undefined;
  existingError: string | undefined;
}): Promise<string | undefined> {
  if (input.landing !== undefined) {
    try {
      await input.landing;
    } catch (err) {
      if (input.existingError !== undefined) return input.existingError;
      return err instanceof Error ? err.message : String(err);
    }
  }
  const unpublished = unpublishedFollowupError(input.hasFollowup, input.published(), input.existingError);
  if (unpublished !== undefined) return unpublished;
  return unjoinedFollowupError(
    input.hasFollowup,
    input.published(),
    input.joinedHost(),
    input.existingError,
  );
}

/**
 * A queued follow-up's publish settles when the host drains it, while that turn
 * is still running. Only a publish that did not join the host is its own turn,
 * and only that one owns cleanup.
 */
export function followupCleansAfterSettle(joinedHost: boolean | undefined): boolean {
  return joinedHost !== true;
}

/**
 * Stay pending until `delivery` settles, then clean up unless the follow-up
 * joined the host. Callers put the returned promise in the shutdown wait
 * immediately, so a separate turn is not still writing when the pool closes.
 */
export function observeFollowupDelivery(
  delivery: Promise<void>,
  joinedHost: () => boolean | undefined,
  cleanup: () => Promise<void>,
): Promise<void> {
  const finish = async (): Promise<void> => {
    if (!followupCleansAfterSettle(joinedHost())) return;
    await cleanup();
  };
  return delivery.then(finish, finish);
}

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
  /** The same, for every agent in the stack (#2027): what a real specialist can call. */
  reachableByAgent: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * A real-delegation run's default wait: the longest delegate wait any specialist gets,
   * plus a margin for the coordinator's own turn.
   */
  delegationRunTimeoutMs: number;
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
  /** `fixtureConversations`: through-gateway Signal conversations to sweep by id (fixtureSignalConversations). */
  sweep(fixtureConversations?: readonly string[]): Promise<Record<string, number>>;
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

/** Where the stack loads agents, skills and config from: core's, or a deployment overlay laid over them. */
export interface StackSources {
  agentsDir?: string;
  skillsDir?: string;
  configDir?: string;
  /** MCP tools/list snapshots searched before core's: a deployment's own servers. */
  mcpSnapshotDirs?: string[];
}

/**
 * Why a case's autonomy fixture is not what the stack reads in the calling context, or
 * undefined when it is (or the case has none). Called inside the attempt (#2312): the
 * fixture is entered per attempt, so this is where a fixture that never arrived shows.
 */
export async function caseAutonomyError(
  fixture: AutonomyFixture | undefined,
  autonomy: Pick<AutonomyService, 'getConfig'>,
): Promise<string | undefined> {
  if (!fixture) return undefined;
  const mismatch = autonomyFixtureMismatch(fixture, await autonomy.getConfig());
  return mismatch ? `autonomy fixture not in force: ${mismatch}` : undefined;
}

/**
 * Why a through-gateway run cannot be scored on this stack, or undefined when it can (#2312
 * review). Without the band-review judge every detected item fails closed, so the run would
 * score a missing key as the agent's error: it is an errored run instead.
 */
export function throughGatewayJudgeError(
  scenario: Pick<ScenarioCase, 'throughGateway'>,
  stack: Pick<TestModeStack, 'bandReviewJudgeMissing'>,
): string | undefined {
  if (scenario.throughGateway !== true || !stack.bandReviewJudgeMissing) return undefined;
  return `through_gateway run needs the band-review judge: ${stack.bandReviewJudgeMissing}`;
}

/**
 * `officeIdentity`: the run's identity fixture (#2143). One stack serves every case in a
 * run, so the identity is the run's, never a case's. A case's `autonomy:` fixture is its
 * own (#2312): each attempt enters it (see attempt()), so cases with different scores and
 * gatings share the stack and run at once.
 */
export async function createScenarioHarness(
  options: {
    model?: string;
    reasoning?: TierReasoningOverride;
    officeIdentity?: OfficeIdentityFixture;
    /** Refuse to boot without the band-review judge: the CLI sets it when a through_gateway case is selected. */
    requireBandReviewJudge?: boolean;
  } & StackSources = {},
): Promise<ScenarioHarness> {
  const context = createCaseContext<ScenarioRunState>();
  const currentScope = (): SeedScope | undefined => context.current()?.scope;
  const config = loadConfig();
  // The registry exists only once the stack is built; the stub layer reads it lazily.
  let booted: TestModeStack | undefined;
  let unavailable: ReadonlySet<string> = new Set();
  /** Open runs by the coordinator's conversation, so a specialist's conversation lands in its run's scope. */
  const openRuns = new Map<string, ScenarioRunState>();
  const controller = createStubController(
    () => {
      if (!booted) throw new Error('scenario harness: tool call before the stack finished booting');
      return booted.toolRegistry;
    },
    () => unavailable,
    () => booted?.snapshotMcpTools ?? new Set(),
    {
      onDelegate: (root, specialistConversation) => {
        openRuns.get(root)?.scope.specialistConversations.add(specialistConversation);
      },
    },
  );
  // Built in observeBus, ahead of every agent runtime (see delegation-capture.ts).
  let delegationCapture: DelegationCapture | undefined;
  // The turn capture, built after boot; the approval-wake observer reads it at event time.
  let lateCapture: ReturnType<typeof createTurnCapture> | undefined;

  const stack = await createTestModeStack({
    config: { ...config, databaseUrl: withApplicationName(config.databaseUrl) },
    model: options.model,
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
    ...(options.agentsDir ? { agentsDir: options.agentsDir } : {}),
    ...(options.skillsDir ? { skillsDir: options.skillsDir } : {}),
    ...(options.configDir ? { configDir: options.configDir } : {}),
    ...(options.mcpSnapshotDirs ? { mcpSnapshotDirs: options.mcpSnapshotDirs } : {}),
    ...(options.officeIdentity ? { officeIdentity: options.officeIdentity } : {}),
    wrapExecutionLayer: (layer, reviewLayer) => controller.wrap(layer, reviewLayer),
    wrapBullpenService: (bullpen) => scopedBullpen(bullpen, currentScope),
    // Times each model call against its run, and refuses a cancelled run's calls.
    wrapLlmProvider: (provider) => guardProvider(provider, context.current),
    // No contact recent history: every case starts from a clean slate.
    wrapWorkingMemory: withoutRecentHistory,
    // For real delegation (#2027): delegate links and settles the run's own entries, and
    // its dispatch claims are production's. Both only ever see this suite's rows.
    wrapOutboundContext: (service) => scopedOutboundContext(service, currentScope),
    // Sign-in verifications (#2017): the block, the code tracking and the ExecutionLayer
    // see only the run's seeded rows, and the run's seeded sessions read as alive (there
    // is no browser; web-browser is stubbed).
    wrapVerification: (runtime) => scopedVerification(runtime, currentScope),
    wrapPinnedContextReader: (reader) => scopedPinnedContextReader(reader, currentScope),
    browserSessionAlive: scopedBrowserSessionAlive(currentScope),
    delegationClaims: true,
    // Through-gateway sends (#2312): production's review, recording transports. What passes
    // lands in the calling run's scope; a send outside every run fails. Non-opted cases never
    // reach the gateway (the stub layer answers or refuses their sends), so they are unchanged.
    recordSends: {
      record: (send) => {
        const scope = currentScope();
        if (!scope) throw new Error('scenario harness: a send outside every scenario run');
        scope.deliveries.push(send);
      },
      message: (messageId) => currentScope()?.inboundMessages.get(messageId),
      display: (shortRef, shown) => { currentScope()?.approvalDisplays.set(shortRef, shown); },
      // Each run's own fail-open cap (#2312).
      limiter: () => currentScope()?.failOpen,
      drafts: () => currentScope()?.drafts,
      // Labels and outcome of each band review, for the `reviewed` check (#2312).
      reviewed: (review) => { currentScope()?.reviews.push(review); },
      // Relayed replies (#2312): production's adapter path, for a through-gateway run's own
      // conversations only. Every other run's outbound.message stays on the bus, as before.
      relays: (conversationId) => acceptsRelay(currentScope(), conversationId),
      threadMessages: (threadId) => currentScope()?.threadMessages.get(threadId) ?? [],
      ownAddresses: [SCENARIO_CURIA_EMAIL],
    },
    // approve-action's "the sole pending approval" means the run's own.
    wrapActionLog: (repo) => scopedActionLog(repo, currentScope),
    ...(options.requireBandReviewJudge ? { requireBandReviewJudge: true } : {}),
    // The agents' layer keeps tier Gate C, as before #2312, except in a through-gateway run,
    // whose gates follow its fixture's gating as production's would.
    agentLayerFollowsFixtureGating: () => currentScope()?.throughGateway === true,
    observeBus: (bus) => {
      // A held relay wakes the coordinator to deliver the approval (#2159), in a conversation
      // of its own. In a through-gateway run that turn is the run's: file it under the run (its
      // tool calls get the run's stubs, deliver-approval runs for real) and capture it. Called
      // before the agent runtime sees the task, so the capture sees the whole turn.
      bus.subscribe('agent.task', 'system', (event) => {
        const { conversationId } = (event as AgentTaskEvent).payload;
        const scope = currentScope();
        if (!conversationId.startsWith(APPROVAL_WAKE_PREFIX) || !scope?.throughGateway || !scope.rootConversation) return;
        // The run already closed (a late wake): its tool calls are refused as stale, as before.
        if (scope.followOnConversations.has(conversationId) || controller.rootOf(scope.rootConversation) === undefined) return;
        scope.followOnConversations.add(conversationId);
        controller.attach(scope.rootConversation, conversationId);
        if (lateCapture) scope.wakeTurns.push(lateCapture.waitFor(conversationId, RUN_TIMEOUT_MS, COORDINATOR));
      });
      delegationCapture = createDelegationCapture(
        bus,
        (conversationId) => controller.rootOf(conversationId),
        // A specialist the run abandoned (its delegate wait timed out) finished after the
        // run's cleanup: remove what it wrote since.
        (conversationId) => {
          if (!booted) return;
          const { pool, logger } = booted;
          void Promise.all([
            cleanupScenarioConversation(pool, conversationId),
            deletePendingDelegations(booted, [], [conversationId]),
          ]).catch((err: unknown) => {
            logger.error({ err, conversationId }, 'scenario harness: late specialist cleanup failed');
            process.stderr.write(`  [WARN] late cleanup failed for ${conversationId}: ${err instanceof Error ? err.message : String(err)}\n`);
          });
        },
        // Approval wakes and `inbound.then` turns: the coordinator's own, not a specialist's.
        (conversationId) => currentScope()?.followOnConversations.has(conversationId) === true,
      );
    },
  });
  booted = stack;
  // Tools any agent is offered that test mode refuses for a missing capability.
  unavailable = new Set(Object.values(stack.disabledTools).flat().map(d => d.tool));

  const { bus, logger } = stack;
  const outboundContext = createOutboundContextService(stack);
  const scopedOutbound = scopedOutboundContext(outboundContext, currentScope);

  // Production's Dispatcher, given an outbound-context service so it injects the
  // block — narrowed to the run's own entries — the run's own backlog counts, and the
  // run's own verifications, so a principal's relayed code is tracked as in production.
  // A missing scan is not a clean scan: the stack's scanner is the one production
  // builds, and a bad extra pattern fails the stack rather than weakening it (#2018).
  new Dispatcher({
    bus,
    logger,
    contactResolver: stack.contactResolver,
    injectionScanner: stack.injectionScanner,
    // Production's trust scoring (#2227): the coordinator sees the sender's trust score,
    // and a message counts toward the sender's confidence, as in production.
    channelPolicies: stack.trustScoring.channelPolicies,
    trustScorerWeights: stack.trustScoring.weights,
    confidencePipeline: stack.trustScoring.confidencePipeline,
    outboundContextService: scopedOutbound,
    principalBacklog: scopedPrincipalBacklog(currentScope, new ActionLogRepo(stack.pool, logger)),
    verification: stack.verification,
    turnLanes: stack.turnLanes,
    selfEmail: SCENARIO_CURIA_EMAIL,
    // Relay Gate C follows the case's autonomy fixture, read per relay (#2312).
    autonomyService: stack.autonomyService,
    // Production's outreach link (#2312) over the run's own rows: the outreach it seeded and
    // what its sends recorded. With none (every case without seed.outreach or sends) nothing
    // links, as before. No model step: production's last, weak-only match runs on infraLlm,
    // which test mode does not build.
    outreachMatcher: new OutreachMatcher({
      repo: scopedOutreachRepo(new TaskOutreachRepo(stack.pool), currentScope),
      infraLlm: undefined,
      logger,
      // The stack's own (production's config), as its band review reads them.
      nonOrgDomains: principalOrgDomainSet(stack.yamlConfig.security?.principal_org_domains ?? []),
      taskStatus: async (taskId) => {
        if (!currentScope()?.taskIds.has(taskId)) return null;
        const { rows } = await stack.pool.query<{ status: string }>(`SELECT status FROM tasks WHERE id = $1`, [taskId]);
        return rows[0]?.status ?? null;
      },
    }),
    // Production's check against the run's own seed: the principal's email identities as
    // the stack read them, and a mailbox whose Sent folder is the run's principal_wrote
    // contacts. A fresh check per lookup, so no answer is cached across runs (#2227).
    principalAcquaintance: {
      check: {
        evidenceFor: (address: string) => new PrincipalAcquaintanceCheck({
          orgDomains: SCENARIO_ORG_DOMAINS,
          principalEmails: () =>
            stack.principalIdentities.filter(id => id.channel === 'email').map(id => id.channelIdentifier),
          mailbox: { hasSentTo: async (a: string) => currentScope()?.principalWroteTo.has(a.toLowerCase()) ?? false },
          logger,
        }).evidenceFor(address),
      },
      contacts: stack.contactService,
    },
  }).register();
  // A follow-up's tryInject has decided. The harness waits for that before it
  // lets a held tool return, and does not await the follow-up's publish (that
  // publish resolves only when the follow-up is drained, inside the host turn).
  // The boolean is whether the decision was `queued`.
  const injectionQueued = new Map<string, (queued: boolean) => void>();
  const tryInject = stack.turnLanes.tryInject.bind(stack.turnLanes);
  stack.turnLanes.tryInject = (conversationId, input) => {
    const decision = tryInject(conversationId, input);
    const wake = injectionQueued.get(conversationId);
    if (wake) {
      injectionQueued.delete(conversationId);
      wake(decision.kind === 'queued');
    }
    return decision;
  };
  const waitForInjection = (conversationId: string): Promise<boolean> => new Promise((resolve) => {
    injectionQueued.set(conversationId, resolve);
  });
  // A text llm.call is awaited before the runtime's exit hook. The follow-up
  // for a reply with no tool call is published from that subscriber, so the
  // queue is full when closeIfIdle runs and the correction drains at exit.
  const exitSlots = new Map<string, TextFinishSlot>();
  // Bullpen mentions reach the coordinator the way they do in production.
  new BullpenDispatcher(bus, logger, stack.bullpenService, stack.agentRegistry).register();

  const capture = createTurnCapture(bus);
  lateCapture = capture;
  const delegations = delegationCapture!;
  // Every model call billed to the run it was made in (#1980).
  const unattributed = new UsageLedger();
  meterAgentCalls(bus, context.current, unattributed);
  // After the meter, so a text finish is billed even though this handler holds
  // the llm.call delivery until the follow-up is queued. A throw here would be
  // swallowed by the runtime's telemetry catch, and the exit hook would then
  // see an empty queue, so the failure is recorded on the run instead.
  bus.subscribe('llm.call', 'system', (event) =>
    publishFollowupOnTextFinish(event, exitSlots, (conversationId, err) => {
      capture.fail(conversationId, err);
    }));
  // Drain points live on the run result. A turn_start drain means the
  // correction joined before the model had chosen, so the run fails here
  // instead of depending on log level to notice it (#2018).
  const injectionDrains = new Map<string, InjectionDrainPoint[]>();
  bus.subscribe('agent.task.input_injected', 'system', (event) => {
    if (event.type !== 'agent.task.input_injected') return;
    const points = injectionDrains.get(event.payload.conversationId);
    if (!points) return;
    points.push(event.payload.drainPoint);
    const message = turnStartDrainError(event.payload.drainPoint);
    if (message !== undefined) {
      capture.fail(event.payload.conversationId, new Error(message));
    }
  });
  const coordinator = stack.agent(COORDINATOR);
  const coordinatorTools = new Set(coordinator.toolDefs.map(t => t.name));
  // Production's own activation check, per skill: what skill-activate would hand the
  // agent. applyReach counts those tools only while skill-activate itself can run, so a
  // case cannot stub a tool no run can load. The same for tool-registry (#2050). A tool
  // either path would add that test mode cannot serve is refused like an offered one
  // (#2059): an unstubbed call counts as a stub hole instead of passing through to a
  // missing-capability error production never shows. Every agent's reach counts: a
  // real specialist (#2027) can activate a tool the coordinator never would.
  const reachableByAgent = new Map<string, Set<string>>();
  const unservable = new Set(unavailable);
  for (const assembled of stack.agents) {
    const name = assembled.agentConfig.name;
    const activatedTools: string[] = [];
    for (const skill of stack.skillRegistry.list()) {
      const activation = stack.executionLayer.resolveSkillActivationForAgent(skill.manifest.name, name);
      if (!('error' in activation)) activatedTools.push(...activation.tools);
    }
    const reach = applyReach({
      offered: new Set(assembled.toolDefs.map(t => t.name)),
      unavailable,
      activated: activatedTools,
      discovered: discoverableTools(stack.toolRegistry, stack.skillRegistry, name),
      missingCapabilities: tool => stack.executionLayer.unavailableCapabilities(tool),
    });
    reachableByAgent.set(name, reach.reachable);
    for (const tool of reach.unavailable) unservable.add(tool);
  }
  const reachableTools = reachableByAgent.get(COORDINATOR)!;
  unavailable = unservable;
  const delegationRunTimeoutMs = longestDelegateWaitMs(stack) + DELEGATION_RUN_MARGIN_MS;
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
  // A run's conversations keep their rows until its outcome is read (createOutcomeGate).
  const outcomeGate = createOutcomeGate((conversationId) => cleanupScenarioConversation(stack.pool, conversationId));

  function trackDelivery(delivery: Promise<void>, conversationId: string): void {
    const settled: Promise<void> = delivery
      .catch((err: unknown) => {
        // The run has its outcome already (via capture.fail or its timeout); this only
        // records that the late turn ended in an error.
        logger.error({ err, conversationId }, 'scenario harness: a coordinator turn failed');
      })
      .then(() => outcomeGate.clean(conversationId))
      .catch((err: unknown) => {
        logger.error({ err, conversationId }, 'scenario harness: late conversation cleanup failed');
        process.stderr.write(`  [WARN] late cleanup failed for ${conversationId}: ${err instanceof Error ? err.message : String(err)}\n`);
      })
      .finally(() => { lateTurns.delete(settled); });
    lateTurns.set(settled, context.current());
  }

  /**
   * A follow-up publish joins `lateTurns` as soon as it starts. Cleanup runs
   * only when `joinedHost` is not true at settlement: a queued follow-up
   * resolves inside the live host turn, and that host delivery owns cleanup.
   */
  function trackFollowupDelivery(
    delivery: Promise<void>,
    conversationId: string,
    joinedHost: () => boolean | undefined,
  ): void {
    const settled: Promise<void> = observeFollowupDelivery(
      delivery,
      joinedHost,
      () => outcomeGate.clean(conversationId),
    )
      .catch((err: unknown) => {
        logger.error({ err, conversationId }, 'scenario harness: follow-up conversation cleanup failed');
        process.stderr.write(`  [WARN] follow-up cleanup failed for ${conversationId}: ${err instanceof Error ? err.message : String(err)}\n`);
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

  /**
   * What the coordinator's `delegate` call publishes for a specialist (#2025;
   * skills/delegate/handler.ts): an agent.task on the internal channel from the
   * coordinator, carrying the brief, with the dispatcher-stamped `Message ID` / `Account`
   * lines in front when the request came by email. Its metadata names the delegation
   * origin and forwards the requester's originator, and the live-turn signal comes along,
   * so the specialist builds the requester-identity block and passes the same skill gates
   * it does in production. What the case leaves out is the coordinator's own turn.
   */
  async function publishDelegatedTask(
    agent: string,
    conversationId: string,
    requester: ResolvedSender,
    inbound: ScenarioCase['inbound'],
  ): Promise<void> {
    const senderContext = await stack.contactResolver.resolve(requester.channelId, requester.senderId);
    // The dispatcher's derivation (#2312): the same channel test over the metadata emailMetadata() would set.
    const authenticated = inboundSenderAuthenticated(requester.channelId, { senderVerified: inbound.email?.senderVerified });
    const { originator, liveTurn } = stampOriginator({ senderContext, channel: requester.channelId, senderId: requester.senderId, authenticated });
    const messageId = inbound.email ? sanitizeNylasMessageId(inbound.email.nylasMessageId ?? `scenario-msg-${randomUUID()}`) : undefined;
    const account = inbound.email ? preambleAccountLabel(inbound.email.account) : undefined;
    const identifiers = inbound.email ? buildInboundEmailIdentifierBlock(messageId?.ok ? messageId.value : undefined, account) : null;
    const brief = identifiers ? identifiers + inbound.content : inbound.content;
    return bus.publish('dispatch', createAgentTask({
      agentId: agent,
      conversationId,
      channelId: 'internal',
      senderId: COORDINATOR,
      content: brief,
      metadata: {
        delegationOrigin: {
          conversationId: `scenario-${randomUUID()}`,
          channelId: requester.channelId,
          agentId: COORDINATOR,
          originalTask: brief,
        },
        ...(messageId?.ok ? { inboundNylasMessageId: messageId.value } : {}),
        ...(account ? { inboundEmailAccount: account } : {}),
        originator,
      },
      liveTurn,
      parentEventId: `delegate-${randomUUID()}`,
    }));
  }

  /**
   * The principal's `inbound.then` turn (#2312): an inbound from the principal's verified
   * identity on its channel, in a conversation of its own filed under the run (its tool calls
   * get the run's stubs, and its rows are the run's). The Dispatcher stamps it a live principal
   * turn, so approve-action's elevated gate runs as in production.
   */
  async function runPrincipalTurn(
    scenario: ScenarioCase,
    turn: NonNullable<ScenarioCase['inbound']['then']>,
    rootConversationId: string,
    scope: SeedScope,
    timeoutMs: number,
  ): Promise<{ outcome: TurnOutcome; delivery: Promise<void> }> {
    const sender = await resolveSender({ ...scenario, inbound: { ...scenario.inbound, from: 'principal', channel: turn.channel } }, stack);
    if (typeof sender !== 'object' || !('channelId' in sender)) throw new Error('unreachable: inbound.then sender is not a channel sender');
    // A reply on the approval email's thread (#2333) joins that thread, as Nylas threads it.
    const approvalThread = turn.replyToApproval ? await approvalEmailThread(scope) : undefined;
    const conversationId = sender.channelId === 'email'
      ? `email:${approvalThread ?? `scenario-then-${randomUUID()}`}`
      : `scenario-then-${randomUUID()}`;
    scope.followOnConversations.add(conversationId);
    // The turn boundary (#2333): a delivery before it went out before the principal answered.
    scope.thenStartsAt = scope.deliveries.length;
    outcomeGate.hold(conversationId);
    controller.attach(rootConversationId, conversationId);
    const waiter = capture.waitFor(conversationId, timeoutMs, COORDINATOR);
    // The principal's own verified identity: their mail authenticates as the adapter would see it.
    const principalEmail = { senderVerified: true };
    const messageId = `scenario-msg-${randomUUID()}`;
    if (sender.channelId === 'email') {
      const message = inboundNylasMessage(messageId, sender.senderId, { content: turn.content, email: principalEmail }, undefined, conversationId.slice('email:'.length));
      scope.inboundMessages.set(messageId, message);
      scope.threadMessages.set(message.threadId, [message]);
    }
    const delivery = bus.publish('channel', createInboundMessage({
      conversationId,
      channelId: sender.channelId,
      senderId: sender.senderId,
      content: turn.content,
      // nylasThreadId as the email adapter sets it (message-converter.ts).
      ...(sender.channelId === 'email'
        ? { metadata: { ...emailMetadata(sender.senderId, principalEmail, undefined, messageId), nylasThreadId: conversationId.slice('email:'.length) } }
        : {}),
      ...(sender.channelId === 'signal' ? { metadata: { isGroup: false } } : {}),
      ...(sender.channelId === 'slack' ? { metadata: { isDm: true } } : {}),
    }));
    delivery.catch((err: unknown) => capture.fail(conversationId, err));
    trackDelivery(delivery, conversationId);
    return { outcome: await waiter, delivery };
  }

  /**
   * The thread of the newest approval email the run delivered to the principal (#2333), from
   * the binding approval delivery wrote. None is an error: the case's reply has nothing to be on.
   */
  async function approvalEmailThread(scope: SeedScope): Promise<string> {
    const result = await stack.pool.query<{ message_id: string }>(
      `SELECT b.message_id FROM approval_message_bindings b
         JOIN autonomy_action_log a ON a.id = b.action_log_id
        WHERE b.channel = 'email-thread' AND a.conversation_id = ANY($1::text[])
        ORDER BY b.id DESC LIMIT 1`,
      [runConversations(scope)],
    );
    const thread = result.rows[0]?.message_id;
    if (!thread) throw new Error('inbound.then.reply_to_approval: the run delivered no approval email to reply on');
    return thread;
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

  /**
   * One attempt at a run, in a fresh case context with its own seeded rows, under the case's
   * autonomy fixture (#2312) or, without one, the database's. Both contexts wrap everything
   * the attempt starts: the inbound's publish, the turns, their tool calls and follow-ups.
   */
  async function attempt(scenario: ScenarioCase, runIndex: number): Promise<{ run: ScenarioRun; providerReason?: string }> {
    const state: ScenarioRunState = { ...newAttempt(`${scenario.name} run ${runIndex + 1}`), scope: new SeedScope() };
    return context.run(state, () => runWithAutonomyFixture(scenario.autonomy, () => attemptInContext(scenario, runIndex, state)));
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
    // Follow-up drain points for this attempt. The map entry is removed on
    // disarm; this array is what the run result keeps.
    let injectionDrainPoints: InjectionDrainPoint[] | undefined;
    // A follow-up lives only for this attempt. Cleanup disarms it so a late
    // timer cannot publish after the run, and releases a held first tool so
    // the turn can finish (#2018).
    let releaseFirstCall: (() => void) | undefined;
    let followupArmed = true;
    let followupTimer: ReturnType<typeof setTimeout> | undefined;
    const disarmFollowup = (): void => {
      followupArmed = false;
      if (followupTimer !== undefined) {
        clearTimeout(followupTimer);
        followupTimer = undefined;
      }
      releaseFirstCall?.();
      releaseFirstCall = undefined;
      if (conversationId !== undefined) {
        injectionQueued.delete(conversationId);
        exitSlots.delete(conversationId);
        injectionDrains.delete(conversationId);
      }
    };
    let stubbedCalls: StubbedCall[] = [];
    let trace: DelegationTrace | undefined;
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
      // What the agents will read, read back inside the attempt: a fixture that never reached
      // the stack must fail the run, not be scored as in force.
      const autonomyError = await caseAutonomyError(scenario.autonomy, stack.autonomyService);
      if (autonomyError) throw new Error(autonomyError);
      const judgeError = throughGatewayJudgeError(scenario, stack);
      if (judgeError) throw new Error(judgeError);
      seeded = await seedRun(dated, { stack, outboundContext, scope });
      const stubTable = resolvePlaceholders(dated.toolStubs, seeded.refs);
      const inbound = resolvePlaceholders(dated.inbound, seeded.refs);
      // A task wake's body comes from the scheduler's own builder, so the case sees the
      // wake instruction production sends. A wake_at job's payload is the bare envelope.
      // The scheduler's job has no originator, so the wake lists every recorded reply on
      // the agent's open sends, as Scheduler.recordedRepliesFor reads them (#2261).
      const wakeTask = inbound.task;
      inboundContent = wakeTask
        ? formatTaskWakeContent(
            { taskId: wakeTask.id, title: wakeTask.title, progress: { notes: wakeTask.notes }, agentId: scenario.agent, tags: wakeTask.tags ?? [] },
            { type: 'task-wake' },
            recordedReplyViews(await scopedOutbound.getActiveWithReplies(scenario.agent, { taskId: wakeTask.id }), wakeTask.id),
          )
        : inbound.content;

      const sender = await resolveSender(scenario, stack);
      const envelope = await resolveEnvelope(scenario, stack);
      // The agent the inbound reaches and whose turn is scored (#2025).
      const agent = scenario.agent;
      const realDelegation = scenario.delegation === 'real';
      const timeoutMs = scenario.timeoutSeconds
        ? scenario.timeoutSeconds * 1000
        : realDelegation ? Math.max(RUN_TIMEOUT_MS, delegationRunTimeoutMs) : RUN_TIMEOUT_MS;
      const thread = sender === 'bullpen' ? seeded.threads.get(inbound.thread!)! : undefined;
      const runConversationId = thread
        ? thread.threadId // BullpenDispatcher uses the thread id as the conversation
        : sender === 'scheduler' || sender === 'task-wake'
          ? `scheduler:scenario-${randomUUID()}:${randomUUID()}` // scheduler:<job>:<run>
          : typeof sender === 'object' && 'channelId' in sender && sender.channelId === 'email'
            ? `email:scenario-${randomUUID()}`
            // A through-gateway Signal reply relays to the number the conversation names, as
            // the adapter reads it (#2312). Third parties only: cases seeding one identity never
            // run at once, while the principal's number is every case's.
            : scenario.throughGateway && typeof sender === 'object' && 'channelId' in sender
                && sender.channelId === 'signal' && scenario.inbound.from !== 'principal'
              ? `signal:${sender.senderId}`
              : `scenario-${randomUUID()}`;
      conversationId = runConversationId;

      // A through-gateway Signal reply's conversation is named by the fixture's number, so it is
      // reused across runs and attempts: start it clean, or the last run's turns are this run's
      // history.
      if (runConversationId.startsWith('signal:')) await cleanupScenarioConversation(stack.pool, runConversationId);
      outcomeGate.hold(runConversationId);

      scope.rootConversation = runConversationId;
      scope.throughGateway = scenario.throughGateway === true;
      controller.beginRun(stubTable, runConversationId, { realDelegation, throughGateway: scenario.throughGateway === true });
      // Armed before the inbound is published. A fast first tool call must
      // already be held, or the follow-up lands after the model has moved on.
      if (inbound.followup?.after === 'first_tool_call') {
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => { release = resolve; });
        controller.holdFirstCall(runConversationId, held);
        releaseFirstCall = release;
      }
      openRuns.set(runConversationId, state);
      delegations.begin(runConversationId);
      let outcome: TurnOutcome;
      // Specialists still working when the run's own wait ran out (#2027).
      let stillWorking: string[] = [];
      // The principal's `inbound.then` turn (#2312), when the case has one and it ran.
      let thenOutcome: TurnOutcome | undefined;
      // Approval-wake turns a held relay started (#2312): their calls join the run's.
      let wakeCalls: TurnOutcome['calls'] = [];
      let wakeError: string | undefined;
      try {
        // Capture matches events by conversation id, so a second live turn is
        // not a second reply: it is mixed in or dropped. A follow-up that was
        // not queued must fail the run before any of that is scored (#2018).
        if (inbound.followup && stack.turnLanes.enabled !== true) {
          throw new Error(
            'inbound.followup requires dispatch.turnInjection.enabled; the flag is off',
          );
        }
        const waiter = capture.waitFor(runConversationId, timeoutMs, agent);
        let delivery: Promise<void>;
        let hostInboundId: string | undefined;
        if (thread) {
          // Posted by the thread's creator (or the case's author), mentioning the case's
          // agent — the event a bullpen reply produces. BullpenDispatcher turns it into
          // that agent's agent.task.
          const author = inbound.author ?? scenario.seed.bullpen.find(t => t.key === inbound.thread)!.creatorAgentId;
          const message = await stack.bullpenService.postMessage(thread.threadId, author, inbound.content, [agent]);
          delivery = bus.publish('agent', createAgentDiscuss({
            threadId: thread.threadId,
            messageId: message.id,
            topic: thread.topic,
            senderAgentId: author,
            participants: thread.participants,
            mentionedAgentIds: [agent],
            content: inbound.content,
            parentEventId: randomUUID(),
          }));
        } else if (typeof sender === 'object' && 'delegate' in sender) {
          delivery = publishDelegatedTask(agent, runConversationId, sender.delegate, inbound);
        } else if (sender === 'scheduler') {
          // What Scheduler.fireJob publishes for a recurring job with no linked task: an
          // agent.task straight to the agent, no Dispatcher, content = the payload JSON.
          delivery = bus.publish('system', createAgentTask({
            agentId: agent,
            conversationId: runConversationId,
            channelId: 'scheduler',
            senderId: 'scheduler',
            content: JSON.stringify({ task: inbound.content }),
            parentEventId: randomUUID(),
          }));
        } else if (sender === 'task-wake') {
          // What Scheduler.fireJob publishes for a task's wake_at: the wake body, the
          // task's intent anchor and the bound-task metadata. A wake_at job carries no
          // standing, so no wakeContext.
          delivery = bus.publish('system', createAgentTask({
            agentId: agent,
            conversationId: runConversationId,
            channelId: 'scheduler',
            senderId: 'scheduler',
            content: inboundContent,
            intentAnchor: wakeTask!.intent,
            metadata: {
              boundTask: { taskId: wakeTask!.id, errorBudget: {}, tags: wakeTask!.tags ?? [], progress: { notes: wakeTask!.notes } },
            },
            parentEventId: randomUUID(),
          }));
        } else if (sender !== 'bullpen' && 'channelId' in sender) {
          const nylasMessageId = inbound.email?.nylasMessageId ?? `scenario-msg-${randomUUID()}`;
          // What the fake mailbox serves an email-reply to this message (#2312).
          if (sender.channelId === 'email' && scenario.throughGateway) {
            const message = inboundNylasMessage(nylasMessageId, sender.senderId, inbound, envelope, runConversationId.slice('email:'.length));
            scope.inboundMessages.set(nylasMessageId, message);
            scope.threadMessages.set(message.threadId, [message]);
          }
          const hostInbound = createInboundMessage({
            conversationId: runConversationId,
            channelId: sender.channelId,
            senderId: sender.senderId,
            content: inbound.content,
            ...(inbound.email?.account ? { accountId: inbound.email.account } : {}),
            ...(sender.channelId === 'email' ? { metadata: emailMetadata(sender.senderId, inbound.email, envelope, nylasMessageId) } : {}),
            // A scenario inbound is a one-to-one message, and the adapters say so (#2261).
            ...(sender.channelId === 'signal' ? { metadata: { isGroup: false } } : {}),
            ...(sender.channelId === 'slack' ? { metadata: { isDm: true } } : {}),
          });
          hostInboundId = hostInbound.id;
          delivery = bus.publish('channel', hostInbound);
        } else {
          throw new Error('unreachable: bullpen sender without a thread');
        }
        // A publish that fails outright (no handler, a throwing subscriber) must end the
        // run now, not after the timeout.
        delivery.catch((err: unknown) => capture.fail(runConversationId, err));
        // Not awaited. Awaiting the host publish waits for the whole turn, and
        // the follow-up has to be in flight before that turn ends (#2018).
        // True once publishFollowup gets past its armed check and calls publish.
        let followupPublished = false;
        // Set from tryInject's decision. Undefined until then: a publish that
        // settles without it did not join the host turn.
        let joinedHost: boolean | undefined;
        // The landing already in flight. Scoring awaits this before disarm, so
        // a decision still inside the dispatcher's contact and scan work is
        // not dropped. Absent until that landing starts: a timer that has not
        // fired must not be waited into a finished turn.
        let followupLanding: Promise<void> | undefined;
        if (inbound.followup && typeof sender === 'object' && 'channelId' in sender) {
          // A follow-up is only valid from a channel sender, and that branch
          // always sets the id. Publishing without it would skip the wait.
          if (hostInboundId === undefined) {
            throw new Error('channel follow-up has no host inbound id');
          }
          const follow = inbound.followup;
          injectionDrainPoints = [];
          injectionDrains.set(runConversationId, injectionDrainPoints);
          const publishFollowup = async (): Promise<void> => {
            if (!followupArmed) return;
            const followSender = await resolveSender({
              ...scenario,
              inbound: {
                ...scenario.inbound,
                from: follow.from,
                channel: follow.channel ?? scenario.inbound.channel,
              },
            }, stack);
            if (typeof followSender !== 'object' || !('channelId' in followSender)) {
              throw new Error(`followup from '${follow.from}' is not a channel sender`);
            }
            if (!followupArmed) return;
            followupPublished = true;
            const followDelivery = bus.publish('channel', createInboundMessage({
              conversationId: runConversationId,
              channelId: followSender.channelId,
              senderId: followSender.senderId,
              content: follow.content,
              ...(followSender.channelId === 'signal' ? { metadata: { isGroup: false } } : {}),
              ...(followSender.channelId === 'slack' ? { metadata: { isDm: true } } : {}),
            }));
            // In lateTurns now, so shutdown waits if this becomes its own turn.
            // A queued follow-up settles on drain, inside the host turn; cleanup
            // stays with the host delivery. Not awaited: this promise resolves
            // only when the follow-up is drained or its own turn ends.
            trackFollowupDelivery(followDelivery, runConversationId, () => joinedHost);
            followDelivery.catch((err: unknown) => capture.fail(runConversationId, err));
          };
          const followupLanded = async (): Promise<void> => {
            if (!followupArmed) return;
            const queued = waitForInjection(runConversationId);
            void queued.then((wasQueued) => { joinedHost = wasQueued; });
            void publishFollowup().catch((err: unknown) => capture.fail(runConversationId, err));
            const injected = await Promise.race([
              queued,
              new Promise<boolean>((resolve) => {
                const timer = setTimeout(() => resolve(false), FOLLOWUP_QUEUE_WAIT_MS);
                timer.unref();
              }),
            ]);
            if (!injected && followupArmed) {
              capture.fail(runConversationId, new Error(FOLLOWUP_NOT_QUEUED_ERROR));
            }
          };
          if (follow.after === 'first_tool_call') {
            // The model has to have chosen before the correction arrives.
            // whenFirstCall is that moment for a tool round: the call stays
            // held until the follow-up is queued, and the next round drains
            // it. A text reply never records a tool call. Its llm.call is
            // awaited before the exit hook, and the subscriber publishes
            // there, so closeIfIdle sees the queue and the drain is `exit`
            // rather than `turn_start`. A `turn_start` drain fails the run.
            let claimed = false;
            const claim = (): boolean => {
              if (claimed || !followupArmed) return false;
              claimed = true;
              return true;
            };
            const publish = async (): Promise<void> => {
              const landing = followupLanded();
              followupLanding = landing;
              await landing;
              releaseFirstCall?.();
            };
            exitSlots.set(runConversationId, { agentId: agent, claim, publish });
            void (async () => {
              await controller.whenFirstCall(runConversationId);
              if (!claim()) return;
              await publish();
            })().catch((err: unknown) => capture.fail(runConversationId, err));
          } else {
            followupTimer = setTimeout(() => {
              followupTimer = undefined;
              const landing = followupLanded();
              followupLanding = landing;
              void landing.catch((err: unknown) => capture.fail(runConversationId, err));
            }, follow.after.ms);
            followupTimer.unref();
          }
        }
        trackDelivery(delivery, runConversationId);
        outcome = await waiter;
        // Before disarm drops the injection waiter. Publish returns before
        // tryInject, so the host can finish while the decision is in flight.
        const followupError = await followupScoreError({
          hasFollowup: inbound.followup !== undefined,
          published: () => followupPublished,
          landing: followupLanding,
          joinedHost: () => joinedHost,
          existingError: outcome.error,
        });
        if (followupError !== undefined && outcome.error === undefined) {
          outcome = { ...outcome, error: followupError };
        }
        if (outcome.errorKind === 'timeout') stillWorking = controller.pendingDelegations(runConversationId);
        // In a through-gateway run the reply is relayed after the turn replies (the adapter path,
        // its review, a hold's approval wake): let that finish before the run is cancelled.
        if (scenario.throughGateway) await settleWithin(delivery, timeoutMs);
        if (inbound.then && outcome.error === undefined) {
          // The first turn has replied; let its publish (and anything it set off) finish, so the
          // principal's next message is a turn of its own, as it would be in production.
          await settleWithin(delivery, timeoutMs);
          // And its approval wakes (#2333): the principal answers an approval the wake delivered,
          // and what the first turn sent, a holding note included, falls before the turn boundary.
          await settleWithin((async () => {
            let settled = 0;
            while (settled < scope.wakeTurns.length) {
              const snapshot = [...scope.wakeTurns];
              await Promise.all(snapshot);
              settled = snapshot.length;
            }
          })(), timeoutMs);
          const then = await runPrincipalTurn(scenario, inbound.then, runConversationId, scope, timeoutMs);
          thenOutcome = then.outcome;
          await settleWithin(then.delivery, timeoutMs);
        }
        // A wake turn can itself hold a send that starts another wake: await until the list stops
        // growing, not just the snapshot taken here.
        let wakes = await Promise.all(scope.wakeTurns);
        while (wakes.length < scope.wakeTurns.length) wakes = await Promise.all(scope.wakeTurns);
        wakeCalls = wakes.flatMap(w => w.calls);
        wakeError = wakes.find(w => w.error)?.error;
      } finally {
        // Before endRun resolves a waiting first-call, so the publisher sees
        // the follow-up is no longer armed.
        disarmFollowup();
        stubbedCalls = controller.endRun(runConversationId);
        trace = delegations.end(runConversationId);
        openRuns.delete(runConversationId);
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

      // Wake and `then` turns are the coordinator's (both are captured for it), in run order.
      const followOnCalls = [...wakeCalls, ...(thenOutcome?.calls ?? [])].map(c => ({ ...c, agentId: COORDINATOR }));
      const merged = mergeCalls(inRunOrder([...outcome.calls, ...followOnCalls], trace, agent), stubbedCalls);
      // Read after the run's turns settled, before cleanup removes the rows (#2312).
      const gateway = scenario.throughGateway ? await readGatewayOutcome(stack, scenario, seeded, scope) : undefined;
      // A scoped view failing means the case ran without its premise (no block, no thread).
      const premiseError = scope.errors.length > 0 ? `seeded state was not visible: ${scope.errors.join('; ')}` : undefined;
      // A slow specialist is not a stuck coordinator (#2027): say which it was.
      const timeoutKind = outcome.errorKind === 'timeout'
        ? (stillWorking.length > 0 ? 'delegate_wait' as const : 'run' as const)
        : undefined;
      // Sends held for want of a reviewer test the judge's outage, not the agent (#2312).
      const reviewerError = gateway?.reviewerFailedOpen
        ? 'band review\'s fail-open cap tripped: the review judge failed on too many sends, so sends held for want of a reviewer'
        : undefined;
      const error = timeoutKind === 'delegate_wait'
        ? `${outcome.error} — a specialist was still working (${[...new Set(stillWorking)].join(', ')}): the run's wait ran out before the delegate wait did`
        : outcome.error ?? (thenOutcome?.error ? `inbound.then turn: ${thenOutcome.error}` : undefined)
          ?? (wakeError ? `approval wake turn: ${wakeError}` : undefined) ?? premiseError ?? reviewerError;
      result = {
        runIndex,
        inboundContent,
        refs: Object.fromEntries(seeded.refs),
        clock,
        toolCalls: merged,
        reply: outcome.reply,
        ...(outcome.principalNote !== undefined ? { principalNote: outcome.principalNote } : {}),
        ...(outcome.noReplyReason ? { noReplyReason: outcome.noReplyReason } : {}),
        durationMs: Date.now() - started,
        unstubbedCalls: countHoles(merged),
        ...(error ? { error } : {}),
        ...(timeoutKind ? { timeoutKind } : {}),
        ...(injectionDrainPoints !== undefined ? { injectionDrainPoints: [...injectionDrainPoints] } : {}),
        ...(realDelegation ? { delegations: trace?.delegations ?? [] } : {}),
        ...(gateway ? { gateway } : {}),
        ...(thenOutcome ? { then: { reply: thenOutcome.reply } } : {}),
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
        unstubbedCalls: stubbedCalls.filter(c => c.disposition === 'refused' || c.disposition === 'canned').length,
        error: describeError(err),
        ...(injectionDrainPoints !== undefined ? { injectionDrainPoints: [...injectionDrainPoints] } : {}),
        usage: state.usage.snapshot(),
        providerRetries: [],
      };
    } finally {
      disarmFollowup();
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
      // Read and cleaned: a turn there that settles from now on cleans up after itself.
      outcomeGate.release([...runConversations(scope), ...(conversationId ? [conversationId] : [])]);
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
    reachableByAgent,
    delegationRunTimeoutMs,
    unavailableTools: unavailable,
    inertTools: stack.snapshotMcpTools,
    runOnce,
    unattributedUsage: () => unattributed.snapshot(),
    sweep: (fixtureConversations) => sweepLeftovers(stack, fixtureConversations),
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
  // up front (see mustStub's `unavailable`), so they land here as refusals. An
  // unstubbed snapshot MCP call got an empty stand-in result the case never chose (#2024).
  return calls.filter(c => c.disposition === 'refused' || c.disposition === 'canned').length;
}

/** The metadata the email adapter attaches, minus anything a scenario cannot know. */
function emailMetadata(
  senderEmail: string,
  email: ScenarioCase['inbound']['email'],
  envelope: ResolvedEnvelope | undefined,
  nylasMessageId: string,
): Record<string, unknown> {
  return {
    participants: [
      { email: senderEmail, role: 'from' },
      ...(envelope?.to ?? []).map(a => ({ email: a, role: 'to' })),
      ...(envelope?.cc ?? []).map(a => ({ email: a, role: 'cc' })),
    ],
    // As the email adapter sets them (src/channels/email/message-converter.ts).
    ...(envelope
      ? {
          primaryRecipientEmails: envelope.to,
          curiaRole: envelope.cc.includes(SCENARIO_CURIA_EMAIL) ? 'cc' : 'to',
        }
      : {}),
    // Everyone else the email reached (#2261); with no envelope it reached only Curia.
    otherRecipientCount: new Set(
      [...(envelope?.to ?? []), ...(envelope?.cc ?? [])]
        .map(a => a.toLowerCase())
        .filter(a => a !== senderEmail.toLowerCase() && a !== SCENARIO_CURIA_EMAIL.toLowerCase()),
    ).size,
    ...(email?.senderVerified !== undefined ? { senderVerified: email.senderVerified } : {}),
    nylasMessageId,
    isAutoGenerated: email?.autoGenerated ?? false,
    autoGeneratedSignals: email?.autoGeneratedSignals ?? [],
  };
}

/** Wait for `work` to settle, but no longer than `maxMs`. Its failure is the caller's to report. */
async function settleWithin(work: Promise<unknown>, maxMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work.then(() => undefined, () => undefined),
    new Promise<void>(resolve => { timer = setTimeout(resolve, maxMs); timer.unref(); }),
  ]);
  clearTimeout(timer);
}

/**
 * The inbound email as the fake mailbox returns it (#2312): what an email-reply's Gate C and
 * handler fetch. Its Authentication-Results passes only when the case says the sender was
 * verified, the way the adapter derives `senderVerified` from the same header.
 */
export function inboundNylasMessage(
  id: string,
  senderEmail: string,
  inbound: Pick<ScenarioCase['inbound'], 'content' | 'email'>,
  envelope: ResolvedEnvelope | undefined,
  /** The email conversation's thread (its id after `email:`), which a relayed reply lists. */
  threadId = `scenario-thread-${id}`,
): NylasMessage {
  const domain = senderEmail.slice(senderEmail.lastIndexOf('@') + 1);
  const verdict = inbound.email?.senderVerified === true ? 'pass' : 'fail';
  return {
    id,
    threadId,
    subject: '',
    from: [{ email: senderEmail }],
    to: (envelope?.to ?? [SCENARIO_CURIA_EMAIL]).map(email => ({ email })),
    cc: (envelope?.cc ?? []).map(email => ({ email })),
    bcc: [],
    body: inbound.content,
    snippet: inbound.content.slice(0, 120),
    date: Math.floor(Date.now() / 1000),
    unread: true,
    folders: ['INBOX'],
    headers: [{
      name: 'Authentication-Results',
      value: `mx.example.test; spf=${verdict} smtp.mailfrom=${domain}; dkim=${verdict} header.d=${domain}; dmarc=${verdict} header.from=${domain}`,
    }],
    attachments: [],
  };
}

/**
 * The bus view (what the model saw) joined with the stub layer's view (how it was
 * answered), by tool.invoke event id. A bus call with no stub-layer record never reached
 * the ExecutionLayer: the runtime answered it itself (a tool outside the turn's
 * allowlist, a delegation its guard blocked). That is the model's doing, not a hole.
 */
function mergeCalls<C extends ObservedToolCall>(observed: C[], stubbed: StubbedCall[]): Array<C & CapturedToolCall> {
  const byInvoke = new Map(stubbed.filter(s => s.invokeEventId).map(s => [s.invokeEventId!, s]));
  return observed.map(call => {
    const s = call.invokeEventId ? byInvoke.get(call.invokeEventId) : undefined;
    return { ...call, disposition: s ? s.disposition : 'runtime' };
  });
}

/**
 * The longest a coordinator's `delegate` waits for any specialist in this stack: the
 * runtime's wait from a specialist's expected_duration_seconds, or the configured
 * default (src/agents/runtime.ts, skills/delegate/handler.ts).
 */
function longestDelegateWaitMs(stack: TestModeStack): number {
  let longest = clampDelegateWaitTimeoutMs(stack.yamlConfig.delegate?.defaultTimeoutMs ?? DELEGATE_DEFAULT_TIMEOUT_FLOOR_MS);
  for (const specialist of stack.agentRegistry.listSpecialists()) {
    const seconds = specialist.expectedDurationSeconds;
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
      longest = Math.max(longest, computeDelegateTimeoutMs(seconds));
    }
  }
  return longest;
}
