// test-mode-stack.ts — the production agent stack, minus everything that can reach
// the outside world. Used by the smoke harness, the scenario runner (#1956) and
// scripts/render-coordinator-prompt.ts (#1966).
//
// Agents are built through src/startup/agent-assembly.ts, the same path src/index.ts
// uses, so the coordinator here gets the same identity, security, specialist roster,
// autonomy, date guardrail, contact-details and SKILL.md blocks production does. The
// services those blocks read are the real Postgres-backed services, constructed with
// the same constructors as index.ts.
//
// Test mode is defined by what it CANNOT do, by construction (nothing to configure):
//
//   - No transport clients. The OutboundGateway has no Nylas, Signal, Slack or SMS
//     client, and TestModeStackOptions has no field to pass one. Every send/draft
//     fails inside the gateway before it reaches a network call. With `recordSends`
//     (#2312) a second gateway gets production's review and recording fakes
//     (test-mode-sends.ts), on a second ExecutionLayer the caller routes chosen calls
//     to: what passes is handed to the caller's recorder, still with no real client
//     constructed and no outbound queue. The layer agents call keeps the no-send one.
//   - No channel adapters. outbound.message events stay on the in-process bus. With
//     `recordSends` (#2312) the email and Signal adapters' outbound side (never started:
//     no poll, no socket) relays the events SendRecorder.relays accepts to the recording
//     gateway; every other relay stays on the bus.
//   - Withheld credentials. Skills that call a provider directly with a declared
//     secret (e.g. ceo-inbox → Nylas) get a "withheld in test mode" error. Only the
//     read-only secrets in TEST_MODE_PASSTHROUGH_SECRETS fall back to env as usual.
//   - No deferred work. The stack usually shares a database with a real instance
//     (smoke reads DATABASE_URL from .env), and anything a real process acts on
//     later would send with real transports. So the ExecutionLayer gets no
//     scheduler service, task repo, action log (pending approvals), outbound-context
//     service or bullpen service, and the gateway gets no outbound queue. Tools that
//     need them fail with a missing-capability error; scenario tests stub them.
//     `disabledTools` lists them per agent. Runtimes see pending bullpen threads but
//     never write read watermarks, which would hide threads from the real agent.
//     Three of these a caller can opt into when it owns the rows they write (the
//     scenario suite's real delegation, #2027, and through-gateway sends, #2312):
//     `wrapOutboundContext` wires an outbound-context service the caller narrows,
//     `delegationClaims` wires production's pending_delegations claims for `delegate`,
//     and `recordSends` wires the action log (held sends' approval rows) beside the
//     recording gateway.
//   - No shared-setting writes. Smoke turns run with principal standing, so agents get
//     read-only views of the autonomy score and office identity (a real instance would
//     send under a changed score), and no working-docs repo (ceo-inbox shadow drafts
//     feed the real instance's learning signal).
//   - No calendar client, browser, scheduler loop or heartbeat, and no MCP server
//     process. A configured MCP server with a tools/list snapshot (tests/fixtures/mcp)
//     is registered from it instead, answering every call with a canned result
//     (test-mode-mcp.ts, #2024): its tools and projected skill are production's, but
//     nothing reaches an account.
//
// The real vault IS read, the way boot reads it (#911): LLM API keys, the Signal
// number and the email-account grants come from it, so the prompt's contact-details
// block matches production. That needs SECRET_ENCRYPTION_KEY. The vault service and
// the values it returns stay inside createTestModeStack: the ExecutionLayer never sees
// the vault, and the returned `config` carries no vault value.
//
// Known differences from production (only the last two change the system prompt):
//   - The tools above fail closed instead of running.
//   - MCP tools come from a snapshot and return canned results; a configured server
//     without a snapshot is absent (listed in `warnings`).
//   - No Dispatcher: the caller wires its own (the smoke harness does).
//   - Offline mode without SECRET_ENCRYPTION_KEY: no Signal or SMS number, and email
//     self-addresses come from email_accounts without the vault grant check.
//   - Your Contact Details shows the Signal and SMS numbers whenever they resolve;
//     production also drops a number whose channel is disabled in the registry.

import { AsyncLocalStorage } from 'node:async_hooks';
import * as path from 'node:path';
import { loadConfig, loadYamlConfig, resolveAutonomyGating, resolveIdentityGateMode, resolveLateDeliveryConfig, resolveOutboundJudgeConfig, resolveOutboundRedactionConfig, resolveRelayBudgetConfig, resolveTasksConfig, resolveTurnInjectionConfig, resolveVerificationConfig, type Config, type YamlConfig } from '../config.js';
import { ActionLogRepo } from '../autonomy/action-log-repo.js';
import { ApprovalDelivery, type ApprovalDisplay } from '../autonomy/approval-delivery.js';
import { ApprovalTriggerService } from '../autonomy/approval-trigger.js';
import { DisclosureDecisionRecorder, DisclosureDecisionsRepo } from '../autonomy/disclosure-decisions.js';
import type { EscalationJudge } from '../autonomy/escalation-judge.js';
import { RelayBudget } from '../autonomy/relay-budget.js';
import { SendEvidenceCollector } from '../autonomy/send-evidence.js';
import { LLMProviderRouter } from '../agents/llm/provider-router.js';
import { formatWhoYouServeBlock } from '../agents/principal-contact-block.js';
import { TRIGGER_GUIDANCE_MARKER_SOURCES } from '../agents/prompts/trigger-guidance-sources.js';
import { principalOrgDomainSet } from '../contacts/non-org-domains.js';
import { TaskRepo } from '../db/task-repo.js';
import { BandSendReview } from '../dispatch/band-send-review.js';
import { buildEscalationJudge, buildOutboundContentFilter, EscalationJudgeConfigError } from '../dispatch/outbound-filter-wiring.js';
import { OutboundLlmJudge, type JudgeConfig } from '../dispatch/outbound-judge.js';
import { PiiRedactor } from '../dispatch/pii-redactor.js';
import { extractPromptExfiltrationMarkers } from '../dispatch/prompt-exfiltration-markers.js';
import { parseExtraPiiPatterns } from '../pii/scrubber.js';
import { createRecordingOutboundGateway, PerRunFailOpenLimiter, subscribeRecordingRelays, type SendRecorder } from './test-mode-sends.js';
import { createVerificationRuntime, type VerificationRuntime } from '../verification/index.js';
import { createLogger, type Logger } from '../logger.js';
import { createPool, type DbPool } from '../db/connection.js';
import { EventBus } from '../bus/bus.js';
import { AuditLogger } from '../audit/logger.js';
import { AuditLogRepo } from '../audit/audit-log-repo.js';
import { AgentRuntime } from '../agents/runtime.js';
import { AgentRegistry } from '../agents/agent-registry.js';
import { discoverAgentManifests, type AgentYamlConfig } from '../agents/loader.js';
import { createPinnedContextReader } from '../agents/pinned-context.js';
import { WorkingDocsRepo } from '../db/working-docs-repo.js';
import { AnthropicProvider } from '../agents/llm/anthropic.js';
import { OpenRouterProvider } from '../agents/llm/openrouter.js';
import { BedrockProvider } from '../agents/llm/bedrock.js';
import { watchProvider } from '../agents/llm/reasoning-watchdog-provider.js';
import { ModelRegistry } from '../agents/llm/model-registry.js';
import { ModelRouter, type ModelRoutingConfig, type Tier, type TierConfig } from '../agents/llm/model-router.js';
import type { ReasoningSetting } from '../agents/llm/sampling-options.js';

/** Per-tier reasoning settings laid over model_routing (the suites' --reasoning-effort). */
export type TierReasoningOverride = Partial<Record<Tier, ReasoningSetting>>;
import { createEstimateCostUsd } from '../agents/llm/pricing.js';
import type { LLMProvider } from '../agents/llm/provider.js';
import { buildBaseSystemPrompt, formatTaskTailBlocks } from '../agents/system-prompt.js';
import { AutonomyService, type AutonomyConfig } from '../autonomy/autonomy-service.js';
import type { AutonomyGating } from '../autonomy/band-policy.js';
import { resolveBypassLadder } from '../autonomy/effective-standing.js';
import { applyChannelVaultSecrets } from '../channels/apply-channel-vault-secrets.js';
import { EmailAccountsRepo } from '../channels/email/email-accounts-repo.js';
import { resolveEmailAccounts } from '../channels/email/resolve-email-accounts.js';
import { resolvePrincipalCalendarGrant } from '../channels/calendar/resolve-calendar-grant.js';
import { ContactService } from '../contacts/contact-service.js';
import { ContactResolver } from '../contacts/contact-resolver.js';
import { ConfidencePipeline } from '../contacts/confidence-pipeline.js';
import { loadAuthConfig } from '../contacts/config-loader.js';
import { AuthorizationService } from '../contacts/authorization.js';
import type { TrustScorerWeights } from '../dispatch/trust-scorer.js';
import type { ChannelIdentity, ChannelPolicyConfig, PrincipalEmailRef, PrincipalPrimaryEmailRef, PrincipalProfileRef } from '../contacts/types.js';
import { OutboundContextService } from '../dispatch/outbound-context.js';
import { TaskOutreachRepo } from '../dispatch/task-outreach.js';
import { TaskOutreachService, taskLookupFrom } from '../dispatch/task-outreach-capability.js';
import { OutboundContentFilter } from '../dispatch/outbound-filter.js';
import { TurnLanes } from '../dispatch/turn-lanes.js';
import { createInboundScanner } from '../dispatch/security-config-loader.js';
import type { InboundScanner } from '../dispatch/inbound-scanner.js';
import {
  acquireRunningDelegation,
  findInFlightPendingDelegation,
  releaseRunningDelegation,
  type OpenDelegationLookup,
} from '../db/queries/pending-delegations.js';
import { bootstrapAgentIdentity } from '../entity-context/bootstrap.js';
import { EntityContextAssembler } from '../entity-context/assembler.js';
import { ConversationEntityState } from '../entity-context/conversation-entities.js';
import { OfficeIdentityService } from '../identity/service.js';
import type { OfficeIdentity } from '../identity/types.js';
import { BullpenService } from '../memory/bullpen.js';
import { EmbeddingService } from '../memory/embedding.js';
import { resolveKnowledgeGraphEmbedding } from '../memory/embedding-schema.js';
import { EntityMemory } from '../memory/entity-memory.js';
import { KnowledgeGraphStore } from '../memory/knowledge-graph.js';
import { MemoryValidator } from '../memory/validation.js';
import { WorkingMemory } from '../memory/working-memory.js';
import {
  bundleMembersFromDiscovery, loadRegistryDefaults, reconcileRegistries, toolManifestsFromDiscovery,
} from '../registry/reconcile.js';
import { RegistryRepo } from '../registry/registry-repo.js';
import type { IRegistryRepo, RegistryRow } from '../registry/types.js';
import { applyVaultSecrets } from '../secrets/apply-vault-secrets.js';
import { loadEncryptionKey } from '../secrets/crypto.js';
import { SecretsService } from '../secrets/secrets-service.js';
import { compileSecurityContextBlock, resolveSecurityThresholds } from '../security/security-context.js';
import { ExecutionLayer } from '../skills/execution.js';
import { discoverToolManifests, loadToolsFromDirectory, type ToolDiscovery } from '../skills/loader.js';
import { OutboundGateway } from '../skills/outbound-gateway.js';
import { ToolRegistry } from '../skills/registry.js';
import { SkillRegistry } from '../skills/skill-registry.js';
import type { SkillDiscovery } from '../skills/skill-types.js';
import {
  discoverSkillManifests,
  loadSkillsFromDiscovery,
  registerSyntheticSingletonSkills,
} from '../skills/skill-loader.js';
import {
  assembleAgents,
  principalIdentitySnapshotGaps,
  readPrincipalIdentitySnapshot,
  registerAgentRoster,
  type AssembledAgent,
} from './agent-assembly.js';
import { registerSnapshotMcpServers } from './test-mode-mcp.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/** tools/list snapshots of the configured MCP servers (#2024). */
const MCP_SNAPSHOT_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'mcp');

/**
 * Secrets a skill may still read from env in test mode. Read-only lookups only:
 * nothing here can send, draft or write to an account someone else reads.
 * Everything not listed is withheld — fail closed, so a new credential added to a
 * manifest is blocked until someone decides it is safe here.
 */
export const TEST_MODE_PASSTHROUGH_SECRETS: ReadonlySet<string> = new Set([
  'tavily_api_key', // web-search
  'openai_api_key', // image-generate (returns an image; sends nothing)
]);

/**
 * Wraps the ExecutionLayer before any agent receives it. The scenario runner (#1956)
 * uses this to stub tools: return a Proxy (or subclass instance) whose `invoke`
 * answers stubbed tools itself and fails closed for unstubbed side-effecting ones.
 * The returned object must still behave as an ExecutionLayer for every other method
 * (getToolDefinitions, resolveSkillActivationForAgent, …) — delegate them to `layer`.
 *
 * The wrapped layer is what AgentRuntime calls, so tool.invoke / tool.result bus
 * events and the production <task_error> formatting are unchanged.
 *
 * `reviewLayer` exists only with `recordSends` (#2312): a second, unwrapped layer whose sends
 * go through production's review to the recording gateway. The wrapper routes the calls it
 * chooses there (the scenario suite: a through-gateway case's sends and approvals).
 */
export type ExecutionLayerWrapper = (layer: ExecutionLayer, reviewLayer?: ExecutionLayer) => ExecutionLayer;

export interface TestModeStackOptions {
  /** Defaults to loadConfig(). Copied, never mutated — vault values land on the copy. */
  config?: Config;
  /** Defaults to loadYamlConfig(<repo>/config) — default.yaml merged with local.yaml. */
  yamlConfig?: YamlConfig;
  /** Defaults to an error-level logger, so test output stays readable. */
  logger?: Logger;
  /**
   * 'live' registers the real Anthropic / OpenRouter providers for whichever keys the
   * vault holds (requires SECRET_ENCRYPTION_KEY). 'offline' registers providers that
   * throw on any call — for rendering prompts; the vault is then optional. Default 'live'.
   */
  llm?: 'live' | 'offline';
  /**
   * Route every tier (and its fallback) to this model id instead of the configured
   * model_routing. The provider follows from the model registry, so this picks
   * Anthropic or OpenRouter. Must be a model the registry knows.
   */
  model?: string;
  /**
   * Reasoning settings laid over the routing's tiers (the suites' --reasoning-effort,
   * ADR-048). A tier left out keeps its configured setting. ModelRouter validates each
   * against its tier's model, as at a real boot.
   */
  reasoning?: TierReasoningOverride;
  /**
   * Which agents/tools/skills load. 'registry' (default) is what production would load
   * on its next boot: the enabled rows in tool_registry / skill_registry /
   * agent_registry, plus any core default (config/registry-defaults.yaml) that has no
   * row yet — production's own reconcile, run without writing. 'all' loads everything
   * on disk.
   */
  enablement?: 'registry' | 'all';
  /** See ExecutionLayerWrapper. */
  wrapExecutionLayer?: ExecutionLayerWrapper;
  /**
   * Narrow what agents read from the bullpen. The scenario runner (#1956) uses it so a
   * runtime injects only the threads a case seeded, not every open thread a real
   * instance on the same database has. Applied before the read-only view, so the
   * watermark writes stay disabled whatever the wrapper returns.
   */
  wrapBullpenService?: (bullpen: BullpenService) => BullpenService;
  /**
   * Narrow what agents read from working memory. The scenario runner (#1956) uses it to
   * withhold *contact recent history* — a sender's turns from other conversations —
   * so a case does not inherit the dev database's history (a smoke run's, or the real
   * principal's) and score on a premise it did not set up.
   */
  wrapWorkingMemory?: (memory: WorkingMemory) => WorkingMemory;
  /**
   * Wrap each live LLM provider before agents (and `llmProviders`) receive it. The
   * behavior suites (#1980) use it to see which case a call belongs to and to refuse
   * further calls from a case that has timed out, so an abandoned turn stops spending.
   * Not applied to offline providers, which never make a call.
   */
  wrapLlmProvider?: (provider: LLMProvider) => LLMProvider;
  /**
   * Give the ExecutionLayer an outbound-context service, narrowed by this wrapper. Without
   * it the layer has none (see header). The scenario suite (#2027) narrows it to the
   * calling run's entries, so `delegate` can link and settle the entry a reply answers and
   * a specialist's context-bridge-keep-open can hold it, without touching a real entry.
   */
  wrapOutboundContext?: (service: OutboundContextService) => OutboundContextService;
  /**
   * Narrow the sign-in verification runtime (#2017) before the ExecutionLayer and the agents
   * receive it, and before `verification` on the stack exposes it. The scenario suite
   * narrows it to the calling run's rows: production's listActive() spans the whole table,
   * so every run would otherwise see every other run's seeded verifications.
   */
  wrapVerification?: (runtime: VerificationRuntime) => VerificationRuntime;
  /**
   * Wire production's `delegate` dispatch claims (pending_delegations: the in-flight
   * refusal and the running claim, #1858 / #1893), as src/index.ts does when late
   * delivery is enabled. Off by default: the rows name the caller's conversations, and
   * the caller must delete them. Nothing here promotes or sweeps them (no late-delivery
   * subscriber or sweep), so a claim a timed-out wait keeps stays `running` until removed.
   */
  delegationClaims?: boolean;
  /**
   * Called with the bus before any subscriber is registered. The bus delivers an event to
   * its subscribers in order, awaiting each, so an observer that must see an agent.task
   * before the agent acts on it (the scenario suite's delegation capture, #2027)
   * subscribes here.
   */
  observeBus?: (bus: EventBus) => void;
  /**
   * Which browser session ids read as alive in the per-turn sign-in verification block
   * (#2017). There is no browser service in this stack, so without it every session reads
   * as gone; a suite that seeds a verification and stubs `web-browser` passes the ids its
   * stub honours.
   */
  browserSessionAlive?: (sessionId: string) => boolean;
  /** Override for fixtures. Default <repo>/agents and <repo>/skills. */
  agentsDir?: string;
  skillsDir?: string;
  /**
   * Override for <repo>/config: the YAML config, registry defaults and MCP servers. The
   * scenario suite's --overlay points it at core's config with a deployment's local.yaml
   * and skills.yaml laid over it, as that deployment's image does.
   */
  configDir?: string;
  /**
   * MCP tools/list snapshot directories searched before core's tests/fixtures/mcp: a
   * deployment's own servers, for the scenario suite's --overlay.
   */
  mcpSnapshotDirs?: string[];
  /**
   * Lay this over the database's office identity for the whole stack: the scenario
   * suite's style cases (#2143) run under one fixed tone. Held in memory only; see
   * FixtureOfficeIdentityService.
   */
  officeIdentity?: OfficeIdentityFixture;
  /**
   * Lay this autonomy score (and gating) over the database's for the whole stack, unless
   * the work in hand entered its own with runWithAutonomyFixture (the scenario suite's
   * `autonomy:` cases, per attempt). Held in memory only; see FixtureAutonomyService.
   */
  autonomy?: AutonomyFixture;
  /**
   * Run sends through production's gateway review and hand what passes to this recorder
   * instead of failing them (#2312): the scenario suite's `through_gateway` cases. The stack
   * then builds the recording gateway (test-mode-sends.ts) wired as src/index.ts wires the
   * real one — PII redactor, content filter with its judges, band review over the drafting
   * turn's evidence, the action log — and a second ExecutionLayer over it with the action
   * log, approval delivery, disclosure decisions and the escalation judge, so a held send can
   * be delivered to the principal and approved. wrapExecutionLayer receives that layer and
   * routes to it only the calls it chooses; the layer agents call is unchanged. Still no
   * transport client and no outbound queue. Absent: no review layer (smoke, the scripts).
   */
  recordSends?: SendRecorder;
  /**
   * Narrow the action log the gateway and the ExecutionLayer use (recordSends only). The
   * scenario suite narrows approve-action's "the sole pending approval" to the calling run's.
   */
  wrapActionLog?: (repo: ActionLogRepo) => ActionLogRepo;
  /**
   * Refuse to boot when the band-review judge (escalation.judge) cannot be built (recordSends
   * only). Without it band review fails every detected item closed, so a run tests the missing
   * key, not the agent. The scenario CLI sets it when a selected case is `through_gateway`; a
   * stack booted without it reports the gap in `bandReviewJudgeMissing` instead.
   */
  requireBandReviewJudge?: boolean;
  /**
   * Whether the work in hand follows its autonomy fixture's gating on the layer agents call.
   * That layer otherwise keeps the gating it was built with (tier), as before #2312: the fixture
   * sets its score and the prompt block only. The scenario suite answers true for a
   * `through_gateway` run. The review layer always follows the fixture's gating.
   */
  agentLayerFollowsFixtureGating?: () => boolean;
}

/** A pinned autonomy score and the gating its prompt block describes. */
export interface AutonomyFixture {
  score: number;
  gating: AutonomyGating;
}

/**
 * Why the stack's autonomy config does not match a pinned fixture, or null when it does.
 * The scenario harness reads the config back inside each attempt, so a fixture that never
 * reached the stack fails the run instead of being reported as in force.
 */
export function autonomyFixtureMismatch(fixture: AutonomyFixture, config: AutonomyConfig | null): string | null {
  if (!config) return `the stack has no autonomy config; the fixture asked for ${fixture.score} (${fixture.gating} gating)`;
  const gating = config.gating ?? 'tier';
  if (config.score === fixture.score && gating === fixture.gating) return null;
  return `the stack reads autonomy ${config.score} (${gating} gating); the fixture asked for ${fixture.score} (${fixture.gating} gating)`;
}

/**
 * The autonomy fixture the work in hand runs under (#2312). The scenario harness enters one
 * per attempt, around everything the attempt does: the bus delivers an event by awaiting
 * every subscriber in the publisher's call chain, so the dispatcher, the agents' turns and
 * their tool calls all run inside it (tests/shared/case-scope.ts). Cases running at once
 * on one stack each read their own.
 */
const autonomyFixtureStorage = new AsyncLocalStorage<AutonomyFixture | undefined>();

/**
 * Run `fn` under `fixture`: every getConfig() it causes on a FixtureAutonomyService, however
 * indirectly, reads it. `undefined` runs `fn` under the service's default, so work entered
 * without a fixture never inherits one from an enclosing context.
 */
export function runWithAutonomyFixture<T>(fixture: AutonomyFixture | undefined, fn: () => Promise<T>): Promise<T> {
  return autonomyFixtureStorage.run(fixture, fn);
}

/**
 * The autonomy config with a fixture's score and gating in place of the database's: the
 * fixture entered with runWithAutonomyFixture, else the stack's default fixture, else the
 * database's row under the configured gating. Only getConfig() changes, so the prompt block
 * still comes from the real formatPromptBlock(), and the recording OutboundGateway and the
 * review ExecutionLayer read the gating from it on each call (the agents' layer reads it
 * through agentLayerAutonomy). Nothing is written: autonomy_config and its history
 * stay as they were.
 */
export class FixtureAutonomyService extends AutonomyService {
  private readonly defaultFixture?: AutonomyFixture;

  constructor(pool: DbPool, logger: Logger, opts: { fixture?: AutonomyFixture; gating?: AutonomyGating } = {}) {
    super(pool, logger, { gating: opts.gating ?? 'tier' });
    this.defaultFixture = opts.fixture;
  }

  override async getConfig(): Promise<AutonomyConfig | null> {
    const stored = await super.getConfig();
    const fixture = autonomyFixtureStorage.getStore() ?? this.defaultFixture;
    if (!fixture) return stored;
    return {
      score: fixture.score,
      band: AutonomyService.bandForScore(fixture.score),
      updatedAt: stored?.updatedAt ?? new Date(0),
      updatedBy: 'scenario-fixture',
      // Named even for tier: the gateway and execution layer fall back to their constructed
      // gating only when the config names none, and a tier case must stay tier.
      gating: fixture.gating,
    };
  }
}

/** Everything in an office identity but the assistant's name, title and signature. */
export type OfficeIdentityFixture = Omit<OfficeIdentity, 'assistant'>;

/**
 * The office identity with a fixture laid over the database's. Only get() changes, so
 * every agent's block still comes from the real compileSystemPromptBlock(), and nothing
 * is written: the database's identity and its history stay as they were. The assistant
 * stays the database's, so bootstrapAgentIdentity finds the same agent contact.
 */
class FixtureOfficeIdentityService extends OfficeIdentityService {
  constructor(pool: DbPool, logger: Logger, bus: EventBus, private readonly fixture: OfficeIdentityFixture) {
    super(pool, logger, bus);
  }

  override async initialize(): Promise<void> {
    await super.initialize();
    // At boot, not as a prompt that renders "undefined" in every case.
    this.validateIdentity(this.get());
  }

  override get(): OfficeIdentity {
    return { ...super.get(), ...this.fixture };
  }
}

export interface TestModeStack {
  config: Config;
  yamlConfig: YamlConfig;
  logger: Logger;
  pool: DbPool;
  bus: EventBus;
  agentRegistry: AgentRegistry;
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
  /** The layer agents call — the wrapped one when wrapExecutionLayer was given. */
  executionLayer: ExecutionLayer;
  /**
   * No transport clients: every send fails before any network call. (With recordSends, the
   * review layer's sends go through a recording gateway of their own.)
   */
  outboundGateway: OutboundGateway;
  contactService: ContactService;
  contactResolver: ContactResolver;
  officeIdentityService: OfficeIdentityService;
  autonomyService: AutonomyService;
  /** The real service. Agents only read it (see header); seed threads through it. */
  bullpenService: BullpenService;
  /**
   * The sign-in verification runtime the ExecutionLayer and agents use (#2017) — the wrapped
   * one when wrapVerification was given. A caller that builds its own Dispatcher passes this.
   */
  verification: VerificationRuntime;
  agentContactId: string | undefined;
  principalContactId: string | undefined;
  /** The principal's verified, active identities as read at boot (production's snapshot). */
  principalIdentities: readonly ChannelIdentity[];
  /**
   * What production's Dispatcher scores senders with (#2227): channel trust policies
   * (config/channel-trust.yaml), `security.trust_score` weights, and the confidence pipeline.
   * A caller that builds its own Dispatcher passes these so the coordinator sees the same
   * trust score production would show it.
   */
  trustScoring: {
    channelPolicies: Record<string, ChannelPolicyConfig>;
    weights: TrustScorerWeights | undefined;
    confidencePipeline: ConfidencePipeline;
  };
  /**
   * The LLM providers agents use, keyed by provider id ('anthropic', 'openrouter').
   * For test infrastructure that needs its own model calls — the scenario judge (#1956)
   * — without the stack handing out the raw vault key. (The provider's SDK client still
   * holds it in-process, as it does for the agents; this is not an isolation boundary.)
   * Offline stacks hold providers that throw.
   */
  llmProviders: ReadonlyMap<string, LLMProvider>;
  /**
   * The process-wide turn lane (#2018), shared with every agent runtime. Harnesses
   * that build their own Dispatcher pass this same instance. The flag comes from
   * config. The shipped default.yaml turns it on; an absent field stays off.
   */
  turnLanes: TurnLanes;
  /**
   * The inbound scanner production builds for the Dispatcher (#2018). Harnesses
   * that build their own Dispatcher pass this same instance. A bad
   * `extra_injection_patterns` entry throws: a suite must not quietly scan with
   * weaker rules than production.
   */
  injectionScanner: InboundScanner;
  /** Every assembled agent, already registered on the bus. */
  agents: AssembledAgent[];
  /**
   * Per agent: tools it is offered that the test-mode ExecutionLayer will refuse
   * (missing capability), with the capabilities each lacks. Empty agents omitted.
   * Measured on the unwrapped layer — a stub wrapper may answer some of these.
   */
  disabledTools: Record<string, Array<{ tool: string; missing: string[] }>>;
  /**
   * Tools registered from an MCP tools/list snapshot (#2024). Their session answers
   * with a canned result and reaches no account, so they are safe to run unstubbed
   * whatever their action_risk says.
   */
  snapshotMcpTools: ReadonlySet<string>;
  /**
   * Ways this stack differs from production that change what agents see (no vault
   * key, unresolved pins). Callers print these: the stack's own logger is usually silent.
   */
  warnings: string[];
  /** Look up an assembled agent by name. Throws if it is not loaded. */
  agent(name: string): AssembledAgent;
  /**
   * The exact system string the runtime sends this agent for an ordinary
   * (non-scheduler, non-task-bound) turn at `now`. Same functions AgentRuntime calls.
   * Throws if a block that would be in production's prompt fails to build — the
   * runtime omits it and carries on, a render must not.
   */
  renderSystemPrompt(agentName?: string, opts?: { now?: Date }): Promise<string>;
  /**
   * Why the recording stack's band review has no judge (recordSends only), or undefined when it
   * has one. A through-gateway run on such a stack is an error, not a scored result.
   */
  bandReviewJudgeMissing?: string;
  shutdown(): Promise<void>;
}

/** The vault key each LLM provider's client is built from (src/secrets/apply-vault-secrets.ts). */
const PROVIDER_VAULT_KEYS: Readonly<Record<string, string>> = {
  anthropic: 'anthropic_api_key',
  openrouter: 'openrouter_api_key',
  bedrock: 'aws_access_key_id and aws_secret_access_key',
};

/**
 * Why the band-review judge is missing, naming the model, its provider and the vault key that
 * provider needs when that is the gap. `err` is undefined when the config turned the judge off.
 */
export function describeMissingBandJudge(err: EscalationJudgeConfigError | undefined): string {
  if (!err) return 'escalation.judge.enabled is false, so band review has no judge and holds every detected item';
  const { model, provider } = err.detail;
  if (typeof provider === 'string' && typeof model === 'string') {
    const key = PROVIDER_VAULT_KEYS[provider];
    return `the band-review judge (escalation.judge.model '${model}') needs the '${provider}' provider, ` +
      `which is not registered${key ? `: add ${key} to the vault` : ''}`;
  }
  return `the band-review judge cannot be built: ${err.message}`;
}

/**
 * The recording stack's escalation judge, which band review and Gate C share, or why there is
 * none. Band review without it fails every detected item closed, so a through-gateway run would
 * score the missing key as the agent's error: with `require` a missing judge throws, naming
 * the provider key; without, the caller errors each such run. Any other build error throws.
 */
export function resolveBandReviewJudge(deps: Parameters<typeof buildEscalationJudge>[0] & { require: boolean }): {
  judge: EscalationJudge | undefined;
  missing: string | undefined;
} {
  let judgeError: EscalationJudgeConfigError | undefined;
  try {
    const judge = buildEscalationJudge(deps);
    if (judge) return { judge, missing: undefined };
  } catch (err) {
    if (!(err instanceof EscalationJudgeConfigError)) throw err;
    judgeError = err;
  }
  const missing = describeMissingBandJudge(judgeError);
  if (deps.require) throw new Error(`through_gateway cases need the band-review judge: ${missing}`);
  return { judge: undefined, missing };
}

/**
 * The autonomy service the layer agents call reads (#2312 review): the fixture's score, but the
 * gating the layer was built with (tier) unless `followsFixtureGating()` says the work in hand
 * is a through-gateway run. Before #2312 that layer never followed a fixture's gating; band
 * fixture cases that stub their sends (25a–25n) still run tier Gate C, without a judge call.
 * The prompt block reads the full service, so it still describes the fixture's gating.
 */
export function agentLayerAutonomy(service: AutonomyService, followsFixtureGating: () => boolean): AutonomyService {
  return Object.assign(Object.create(service) as AutonomyService, {
    getConfig: async (): Promise<AutonomyConfig | null> => {
      const config = await service.getConfig();
      if (!config || followsFixtureGating()) return config;
      // No gating named: the layer falls back to its constructed one (execution.ts currentGating).
      const tierGated: AutonomyConfig = { ...config };
      delete tierGated.gating;
      return tierGated;
    },
  });
}

/** A provider that refuses to talk to anyone. Used for llm: 'offline'. */
function offlineProvider(id: string): LLMProvider {
  return {
    id,
    chat: async () => {
      throw new Error(`LLM calls are disabled in this test-mode stack (llm: 'offline', provider '${id}')`);
    },
  };
}

/**
 * The vault the ExecutionLayer sees in test mode. Throwing from get() is what blocks
 * the env fallback: ExecutionLayer only falls back to process.env when the vault
 * returns null, and defers a vault error to the moment the skill reads the secret.
 * Only get() and listUserNames() are called by ExecutionLayer.
 */
export function createTestModeSecrets(): SecretsService {
  const vault = {
    get: async (name: string): Promise<string | null> => {
      if (TEST_MODE_PASSTHROUGH_SECRETS.has(name)) return null; // → env fallback
      throw new Error(
        `Secret '${name}' is withheld in test mode — it can reach a real account. ` +
        'Stub the tool instead (see ExecutionLayerWrapper).',
      );
    },
    // Throw rather than return []: an empty list would tell the model the principal
    // has no stored secrets, which is false, not withheld.
    listUserNames: async (): Promise<string[]> => {
      throw new Error('User secret names are withheld in test mode.');
    },
  };
  // Cast: ExecutionLayer types the option as the concrete SecretsService class but
  // only calls the two methods above (src/skills/execution.ts).
  return vault as unknown as SecretsService;
}

/**
 * The only OutboundGateway test mode builds. It has no transport client of any kind,
 * so email, Signal, Slack and SMS sends — and email drafts — fail inside the gateway.
 * Exported so the no-send guarantee can be unit-tested without a database.
 */
export function createNoSendOutboundGateway(deps: {
  contactService: ContactService;
  bus: EventBus;
  logger: Logger;
  principalIdentities: ChannelIdentity[];
  autonomyService?: AutonomyService;
}): OutboundGateway {
  return new OutboundGateway({
    // Deliberately empty, and no outboundQueue: a queued row would be flushed later
    // by any real instance sharing the database. Do not add either here — this is
    // the no-send guarantee.
    nylasClients: new Map(),
    contactService: deps.contactService,
    // No markers / judge: nothing is delivered, so there is nothing to filter.
    contentFilter: new OutboundContentFilter({ systemPromptMarkers: [], ceoEmail: '' }),
    bus: deps.bus,
    logger: deps.logger,
    principalIdentities: deps.principalIdentities,
    autonomyService: deps.autonomyService,
  });
}

/** What buildRecordingSends hands the stack: the gateway, and the ExecutionLayer's extra options. */
interface RecordingSends {
  gateway: OutboundGateway;
  executionOptions: Pick<
    NonNullable<ConstructorParameters<typeof ExecutionLayer>[2]>,
    'actionLogRepo' | 'approvalDelivery' | 'approvalTrigger' | 'disclosureDecisions' | 'escalationJudge' | 'gating' | 'sendEvidence'
  >;
  /** Task reads (getTask, project root) for outreach titles and band evidence. Never handed to agents. */
  taskReads: Pick<TaskRepo, 'getTask' | 'resolveProjectRootTaskId'>;
  /** Why band review has no judge, or undefined when it has one. */
  bandReviewJudgeMissing: string | undefined;
}

/**
 * Production's send review, built for a recording stack (src/index.ts ~1479-1946 and the
 * approval wiring after it). Differences, each deliberate:
 *   - Recording transports and no outbound queue (test-mode-sends.ts).
 *   - No confidence pipeline or export controls on the gateway: both write rows a real
 *     instance shares (contact confidence, export events) for sends that never left.
 *   - The fail-open cap is per run (SendRecorder.limiter), and only logs when it trips;
 *     production keeps one per process and also emails the principal.
 *   - A judge whose config cannot be built is a warning, not a boot failure: the review then
 *     runs as production's does with that judge off (Gate C escalates ambiguous actions,
 *     band review holds). The band-review judge is the exception when `requireBandReviewJudge`
 *     is set (the boot fails, naming the missing provider key); otherwise the gap is returned
 *     as `bandReviewJudgeMissing`, which errors each through-gateway run.
 */
function buildRecordingSends(deps: {
  recorder: SendRecorder;
  wrapActionLog?: (repo: ActionLogRepo) => ActionLogRepo;
  pool: DbPool;
  bus: EventBus;
  logger: Logger;
  config: Config;
  yamlConfig: YamlConfig;
  configDir: string;
  modelRegistry: ModelRegistry;
  providerRegistry: Map<string, LLMProvider>;
  contactService: ContactService;
  principalIdentities: ChannelIdentity[];
  principalPrimaryEmail: PrincipalPrimaryEmailRef;
  principalProfile: PrincipalProfileRef;
  officeIdentity: OfficeIdentity;
  coordinatorPrompt: string | undefined;
  emailAccounts: ReadonlyArray<{ name: string; selfEmail: string }>;
  selfEmails: string[];
  signalPhoneNumber: string | undefined;
  autonomyService: AutonomyService;
  conversationEntities: ConversationEntityState;
  taskOutreachRepo: TaskOutreachRepo;
  outreachNonOrgDomains: ReadonlySet<string>;
  warnings: string[];
  requireBandReviewJudge?: boolean;
}): RecordingSends {
  const { pool, bus, logger, yamlConfig, modelRegistry, providerRegistry, warnings } = deps;
  const gating = resolveAutonomyGating(yamlConfig.autonomy);

  const { judge: escalationJudge, missing: bandReviewJudgeMissing } = resolveBandReviewJudge({
    yaml: yamlConfig.escalation?.judge, modelRegistry, providerRegistry, bus, logger,
    require: deps.requireBandReviewJudge === true,
  });
  if (bandReviewJudgeMissing) {
    warnings.push(`Escalation judge off for recorded sends; through_gateway runs will error: ${bandReviewJudgeMissing}`);
  }

  // The content filter's Stage 2 judge, from filter.llmJudge as production reads it.
  // Production's resolution and validation (a bad timeout fails the boot, as in production).
  let outboundJudge: OutboundLlmJudge | undefined;
  const judgeSettings = resolveOutboundJudgeConfig(yamlConfig.filter, (detail, message) => logger.warn(detail, message));
  if (judgeSettings.enabled) {
    const judgeConfig: JudgeConfig = { ...judgeSettings, enabled: true };
    const provider = modelRegistry.isKnownModel(judgeConfig.model) ? modelRegistry.getProvider(judgeConfig.model) : undefined;
    if (provider && providerRegistry.has(provider)) {
      outboundJudge = new OutboundLlmJudge(new LLMProviderRouter(modelRegistry, providerRegistry), judgeConfig, bus, logger, modelRegistry);
    } else {
      warnings.push(`Content-filter judge off for recorded sends (through_gateway cases only): model '${judgeConfig.model}' has no registered provider`);
    }
  }

  // Read per call, as production's mutable ref is: identity binds update it in place.
  const principalEmail: PrincipalEmailRef = {
    get current(): string { return deps.principalPrimaryEmail.current ?? ''; },
  };
  const contentFilter = buildOutboundContentFilter({
    systemPromptMarkers: extractPromptExfiltrationMarkers(deps.officeIdentity, deps.coordinatorPrompt, TRIGGER_GUIDANCE_MARKER_SOURCES),
    ceoEmail: principalEmail,
    ownEmails: deps.selfEmails,
    judge: outboundJudge,
    escalationJudge,
    logger,
    gating,
  });

  // The same redaction config and extra patterns production reads (src/index.ts ~1607).
  const extraPatterns = (yamlConfig.pii?.extra_patterns ?? []).length > 0
    ? parseExtraPiiPatterns(yamlConfig.pii?.extra_patterns ?? [], path.join(deps.configDir, 'default.yaml'))
    : [];
  const piiRedactor = new PiiRedactor({
    config: resolveOutboundRedactionConfig(yamlConfig.pii, (detail, message) => logger.warn(detail, message)),
    bus,
    logger,
    extraPatterns,
  });

  const realActionLog = new ActionLogRepo(pool, logger);
  const actionLogRepo = deps.wrapActionLog ? deps.wrapActionLog(realActionLog) : realActionLog;
  // Reads only: the band evidence and outreach titles. Agents never get a task repo here.
  const taskReads = new TaskRepo(pool, bus, logger, deps.config.timezone, undefined, deps.taskOutreachRepo);
  const disclosureDecisionsRepo = new DisclosureDecisionsRepo(pool);
  const disclosureDecisions = new DisclosureDecisionRecorder({
    repo: disclosureDecisionsRepo, taskOutreachRepo: deps.taskOutreachRepo, logger,
  });
  const sendEvidence = new SendEvidenceCollector({
    auditLogRepo: new AuditLogRepo(pool, logger),
    taskRepo: taskReads,
    taskOutreachRepo: deps.taskOutreachRepo,
    disclosureDecisionsRepo,
    principalBlock: () => formatWhoYouServeBlock(deps.principalIdentities, deps.principalPrimaryEmail.current, deps.principalProfile.current),
    logger,
  });
  // Built whatever the configured gating: a case pins band per attempt, and the gateway
  // reads the gating per send (#2312).
  const bandReview = new BandSendReview({
    judge: escalationJudge,
    nonOrgDomains: deps.outreachNonOrgDomains,
    evidence: sendEvidence,
    // Per run when the recorder says whose run a send is: one run's judge failures must not
    // hold another's sends.
    limiter: new PerRunFailOpenLimiter(() => deps.recorder.limiter?.()),
    onLimiterTripped: async () => {
      logger.error('band review (test mode): fail-open cap tripped — sends are holding for approval');
    },
    contactTier: async (contactId) => (await deps.contactService.getContact(contactId))?.tier ?? null,
    logger,
  });
  const persona = deps.officeIdentity.assistant;
  const gateway = createRecordingOutboundGateway({
    recorder: deps.recorder,
    emailAccounts: deps.emailAccounts,
    ...(deps.signalPhoneNumber ? { signalPhoneNumber: deps.signalPhoneNumber } : {}),
    contactService: deps.contactService,
    bus,
    logger,
    principalIdentities: deps.principalIdentities,
    autonomyService: deps.autonomyService,
    review: {
      contentFilter,
      piiRedactor,
      bandReview,
      actionLogRepo,
      conversationEntities: deps.conversationEntities,
      identityGate: resolveIdentityGateMode(yamlConfig.filter),
      relayBudget: new RelayBudget({ perHour: resolveRelayBudgetConfig(yamlConfig.autonomy).perHour }),
      agentPersona: {
        displayName: persona.name,
        title: persona.title,
        ...(persona.emailSignature ? { emailSignature: persona.emailSignature } : {}),
      },
      gating,
    },
  });
  const delivery = new ApprovalDelivery({
    actionLogRepo, outboundGateway: gateway, principalIdentities: deps.principalIdentities, principalEmail, logger,
  });
  // Each raise site (the gateway's holds, the ExecutionLayer's gates) registers what the
  // principal will be shown; the recorder sees it too, so a `held` check can read the
  // preamble the approval carries. Everything else is the real delivery.
  const display = deps.recorder.display?.bind(deps.recorder);
  const approvalDelivery = display
    ? Object.assign(Object.create(delivery) as ApprovalDelivery, {
        registerDisplay: (ref: string, shown: ApprovalDisplay): void => {
          delivery.registerDisplay(ref, shown);
          display(ref, shown);
        },
      })
    : delivery;
  gateway.setApprovalDelivery(approvalDelivery);
  // Relayed replies (outbound.message) take production's adapter path to this gateway, for
  // the events the recorder accepts (its through-gateway runs).
  subscribeRecordingRelays({
    recorder: deps.recorder,
    gateway,
    bus,
    logger,
    contactService: deps.contactService,
    emailAccounts: deps.emailAccounts,
    ownAddresses: deps.recorder.ownAddresses ?? [],
    principalEmail,
    ...(deps.signalPhoneNumber ? { signalPhoneNumber: deps.signalPhoneNumber } : {}),
    timezone: deps.config.timezone,
  });
  return {
    gateway,
    executionOptions: {
      actionLogRepo,
      approvalDelivery,
      // The ExecutionLayer's gates (A, B, C) raise their approvals through it, as in production.
      approvalTrigger: new ApprovalTriggerService(actionLogRepo, logger, bus, approvalDelivery),
      disclosureDecisions,
      escalationJudge,
      gating,
      sendEvidence,
    },
    taskReads,
    bandReviewJudgeMissing,
  };
}

/**
 * A registry repo that reads the real table and keeps reconcile's enrolments in
 * memory. Lets the stack run production's reconcileRegistries() and get production's
 * enabled set without writing a row. Reconcile only calls listRows and installAndEnable.
 */
class DryRunRegistryRepo implements IRegistryRepo {
  private readonly enrolled: RegistryRow[] = [];
  constructor(private readonly real: RegistryRepo) {}

  async listRows(): Promise<RegistryRow[]> {
    return [...(await this.real.listRows()), ...this.enrolled];
  }

  async installAndEnable(name: string, actor: string): Promise<RegistryRow | null> {
    const now = new Date().toISOString();
    const row: RegistryRow = {
      name, enabled: true, installedAt: now, installedBy: actor, enabledAt: now, enabledBy: actor, updatedAt: now,
    };
    this.enrolled.push(row);
    return row;
  }

  private refuse(method: string): never {
    throw new Error(`DryRunRegistryRepo.${method}: the test-mode stack never writes the registry`);
  }
  async getRow(): Promise<RegistryRow | null> { return this.refuse('getRow'); }
  async install(): Promise<RegistryRow> { return this.refuse('install'); }
  async enable(): Promise<RegistryRow> { return this.refuse('enable'); }
  async disable(): Promise<RegistryRow> { return this.refuse('disable'); }
  async uninstall(): Promise<boolean> { return this.refuse('uninstall'); }
  async uninstallIfDisabled(): Promise<boolean> { return this.refuse('uninstallIfDisabled'); }
}

/**
 * The tools, skills and agents production would enable on its next boot against
 * this database: production's reconcile, run against dry-run repos.
 */
async function productionEnabledNames(
  pool: DbPool,
  discovered: { skills: Set<string>; agents: Set<string> },
  discovery: { tools: ToolDiscovery[]; skills: SkillDiscovery[] },
  vault: SecretsService | undefined,
  calendarConfigured: boolean,
  configDir: string,
  logger: Logger,
): Promise<{ tool: Set<string>; skill: Set<string>; agent: Set<string> }> {
  const toolRepo = new DryRunRegistryRepo(new RegistryRepo(pool, 'tool_registry'));
  const skillRepo = new DryRunRegistryRepo(new RegistryRepo(pool, 'skill_registry'));
  const agentRepo = new DryRunRegistryRepo(new RegistryRepo(pool, 'agent_registry'));
  await reconcileRegistries({
    toolRepo,
    agentRepo,
    skillRepo,
    toolManifests: toolManifestsFromDiscovery(discovery.tools),
    agentDiscoveryNames: discovered.agents,
    skillDiscoveryNames: discovered.skills,
    bundleMembers: bundleMembersFromDiscovery(discovery.skills),
    // No vault (offline, no SECRET_ENCRYPTION_KEY): tools declaring requires_secrets stay
    // out, fail closed. The caller adds that gap to the stack's warnings.
    secrets: vault,
    // Production's condition for building the calendar client, without building one.
    unavailableCapabilities: new Set(calendarConfigured ? [] : ['nylasCalendarClient']),
    defaults: loadRegistryDefaults(path.join(configDir, 'registry-defaults.yaml')),
    logger,
  });
  const enabled = async (repo: DryRunRegistryRepo): Promise<Set<string>> =>
    new Set((await repo.listRows()).filter(r => r.enabled).map(r => r.name));
  return { tool: await enabled(toolRepo), skill: await enabled(skillRepo), agent: await enabled(agentRepo) };
}

/**
 * A view of the bullpen service whose read-watermark writes do nothing. AgentRuntime
 * marks injected threads as seen per agent id; from a test run sharing the database,
 * that would hide pending threads from the real agent of the same name.
 */
export function readOnlyBullpen(bullpen: BullpenService): BullpenService {
  return Object.assign(Object.create(bullpen) as BullpenService, {
    markThreadsSeen: async () => {},
    recordUnhandledInjection: async () => {},
  });
}

/**
 * A view of `target` on which only `readMethods` work; any other method throws. Used
 * for services whose writes change state a real instance sharing the database acts
 * on. Allowlist, so a write method added later is refused until someone lists it.
 */
export function readOnlyView<T extends object>(target: T, readMethods: readonly string[], label: string): T {
  const allowed = new Set(readMethods);
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value: unknown = Reflect.get(obj, prop, receiver);
      if (typeof value !== 'function') return value;
      if (typeof prop === 'string' && allowed.has(prop)) {
        return (value as (...args: unknown[]) => unknown).bind(obj);
      }
      return () => {
        throw new Error(`${label}.${String(prop)} is read-only in test mode — it would change state a real instance shares`);
      };
    },
  });
}

const AUTONOMY_READS = ['getConfig', 'getHistory', 'getHistoryPaginated', 'getScoredActionCount'] as const;
const OFFICE_IDENTITY_READS = ['get', 'compileSystemPromptBlock', 'compileWritesAsBlock', 'history'] as const;

/** Methods AgentRuntime calls on its ExecutionLayer. A wrapper must keep all of them. */
const EXECUTION_LAYER_METHODS = [
  'invoke',
  'getToolDefinitions',
  'resolveSkillActivationForAgent',
  'provenanceSourceText',
] as const;

/**
 * The routing a test-mode stack boots with: the configured model_routing, with
 * --model replacing every tier's model and --reasoning-effort laid over the
 * tiers it names. ModelRouter validates the result as at a real boot.
 */
export function routingFor(
  yamlConfig: YamlConfig,
  model: string | undefined,
  reasoning: TierReasoningOverride | undefined,
  modelRegistry: ModelRegistry,
): ModelRoutingConfig {
  const configured = yamlConfig.model_routing;
  if (!configured) {
    throw new Error('model_routing config section is required in config/default.yaml');
  }
  if (model && !modelRegistry.isKnownModel(model)) {
    throw new Error(
      `Unknown model '${model}'. Known models: ${Object.keys(modelRegistry.getAllModels()).sort().join(', ')}`,
    );
  }
  // --model replaces every tier, configured reasoning included: that setting was
  // validated against the configured model, not this one.
  const tier = (name: Tier): TierConfig => {
    const base: TierConfig = model ? { model } : configured.tiers[name];
    const override = reasoning?.[name];
    return override ? { ...base, reasoning: override } : base;
  };
  if (!model && !reasoning) return configured;
  return {
    ...configured,
    tiers: { fast: tier('fast'), standard: tier('standard'), powerful: tier('powerful') },
  };
}

/**
 * Build the test-mode stack against `config.databaseUrl`. The database must be
 * migrated. Writes the same idempotent bootstrap rows a real boot writes (office
 * identity, agent contact), and whatever the agents do while it runs.
 */
export async function createTestModeStack(options: TestModeStackOptions = {}): Promise<TestModeStack> {
  // Returned to the caller, so it never receives vault values (those stay in locals).
  const config: Config = { ...(options.config ?? loadConfig()) };
  let anthropicApiKey = config.anthropicApiKey;
  let openrouterApiKey = config.openrouterApiKey;
  let awsAccessKeyId = config.awsAccessKeyId;
  let awsSecretAccessKey = config.awsSecretAccessKey;
  let openaiApiKey = config.openaiApiKey;
  let embeddingApiKey = config.embeddingApiKey;
  let signalPhoneNumber = config.signalPhoneNumber;
  let smsFromNumber = config.smsFromNumber;
  const llmMode = options.llm ?? 'live';
  const warnings: string[] = [];
  const configDir = options.configDir ?? path.join(REPO_ROOT, 'config');
  const yamlConfig = options.yamlConfig ?? loadYamlConfig(configDir);
  const logger = options.logger ?? createLogger('error');
  const agentsDir = options.agentsDir ?? path.join(REPO_ROOT, 'agents');
  const skillsDir = options.skillsDir ?? path.join(REPO_ROOT, 'skills');

  // Fail before any I/O if the security config is one production would refuse.
  const thresholds = resolveSecurityThresholds(yamlConfig.security?.trust_thresholds);
  if (!thresholds.ok) {
    const fields = 'fields' in thresholds ? `: ${thresholds.fields.join(', ')}` : '';
    throw new Error(`Invalid security.trust_thresholds (${thresholds.reason}${fields})`);
  }
  const securityContextBlock = compileSecurityContextBlock(thresholds.thresholds);

  const pool = createPool(config.databaseUrl, logger);
  // Everything below may throw; release the pool and identity watcher if it does.
  let officeIdentityService: OfficeIdentityService | undefined;
  try {
    await pool.query('SELECT 1');

    const auditLogger = new AuditLogger(pool, logger);
    const bus = new EventBus(
      logger,
      (event) => auditLogger.log(event),
      (eventId) => auditLogger.markAcknowledged(eventId),
    );
    options.observeBus?.(bus);

    // ── Vault (boot's view of it) ──────────────────────────────────────────
    // Same resolution as src/index.ts: bootstrap secrets (LLM keys) and channel secrets
    // (Signal number) onto config. Only provider construction and the prompt's own
    // contact details read them; no transport client is ever built from them.
    // Only an UNSET key is tolerated (offline). A malformed one is a config bug and
    // loadEncryptionKey() throws for it in every mode.
    let vault: SecretsService | undefined;
    let encryptionKey: Buffer | undefined;
    // Whether production would build its calendar client (Nylas key + principal grant).
    // Decides if reconcile holds back the calendar tools (#1974); no client is built here.
    let calendarConfigured = false;
    if (process.env.SECRET_ENCRYPTION_KEY) {
      encryptionKey = loadEncryptionKey();
    } else if (llmMode === 'live') {
      throw new Error('SECRET_ENCRYPTION_KEY is required: LLM API keys are read from the vault (#911)');
    } else {
      warnings.push(
        'SECRET_ENCRYPTION_KEY is not set — no vault: the Signal and SMS numbers are missing from Your Contact ' +
        'Details, email addresses skip the grant check, and tools not yet enrolled that need a vault ' +
        'secret or the calendar stay off, so the prompt may differ from production.',
      );
    }
    if (encryptionKey) {
      vault = new SecretsService(pool, encryptionKey, logger);
      // Resolve onto a throwaway copy and keep only what the stack uses: the LLM keys
      // and the Signal and SMS numbers for the prompt. Nylas, Slack, SMS credentials and
      // API tokens are dropped here, so nothing downstream can build a transport client
      // from them.
      const resolved: Config = { ...config };
      await applyVaultSecrets(resolved, vault, logger);
      await applyChannelVaultSecrets(resolved, vault, process.env, logger);
      anthropicApiKey = resolved.anthropicApiKey;
      openrouterApiKey = resolved.openrouterApiKey;
      awsAccessKeyId = resolved.awsAccessKeyId;
      awsSecretAccessKey = resolved.awsSecretAccessKey;
      openaiApiKey = resolved.openaiApiKey;
      embeddingApiKey = resolved.embeddingApiKey;
      signalPhoneNumber = resolved.signalPhoneNumber;
      smsFromNumber = resolved.smsFromNumber;
      if (resolved.nylasApiKey) {
        try {
          calendarConfigured = (await resolvePrincipalCalendarGrant(vault)) !== undefined;
        } catch (err) {
          // Production logs this and boots without calendar; mirror that rather than fail.
          logger.error({ err }, 'test-mode: failed to read ceo_nylas_grant_id; treating calendar as unconfigured');
          warnings.push('Could not read ceo_nylas_grant_id from the vault — calendar tools not yet enrolled stay off.');
        }
      }
    }

    // Gating as production resolves it, so a deployment overlay's `gating: band` reaches the
    // prompt block, and the recording gateway and review layer, which read it per call (#2312;
    // the layer agents call keeps tier unless the caller says otherwise, agentLayerAutonomy). A
    // fixture service even with no default fixture: a case can enter its own per attempt.
    const autonomyService = new FixtureAutonomyService(pool, logger, {
      gating: resolveAutonomyGating(yamlConfig.autonomy),
      ...(options.autonomy ? { fixture: options.autonomy } : {}),
    });
    officeIdentityService = options.officeIdentity
      ? new FixtureOfficeIdentityService(pool, logger, bus, options.officeIdentity)
      : new OfficeIdentityService(pool, logger, bus);
    await officeIdentityService.initialize();

    // ── LLM providers ──────────────────────────────────────────────────────
    const modelRegistry = new ModelRegistry(logger);
    const routing = routingFor(yamlConfig, options.model, options.reasoning, modelRegistry);
    const modelRouter = new ModelRouter(routing, modelRegistry, logger);
    const estimateCostUsd = createEstimateCostUsd(modelRegistry, routing.tiers.standard.model);
    const providerRegistry = new Map<string, LLMProvider>();
    if (llmMode === 'offline') {
      providerRegistry.set('anthropic', offlineProvider('anthropic'));
      providerRegistry.set('openrouter', offlineProvider('openrouter'));
      providerRegistry.set('bedrock', offlineProvider('bedrock'));
    } else {
      const wrapProvider = options.wrapLlmProvider ?? ((p: LLMProvider) => p);
      // The reasoning watchdog wraps each concrete provider as in src/index.ts, so the
      // suites run production's provider stack; the harness's wrapper sits outside it.
      if (anthropicApiKey) {
        providerRegistry.set('anthropic', wrapProvider(watchProvider(new AnthropicProvider(anthropicApiKey, logger, modelRegistry), logger)));
      }
      if (openrouterApiKey) {
        providerRegistry.set('openrouter', wrapProvider(watchProvider(new OpenRouterProvider(openrouterApiKey, logger, modelRegistry), logger)));
      }
      if (awsAccessKeyId && awsSecretAccessKey && config.awsRegion) {
        providerRegistry.set('bedrock', wrapProvider(watchProvider(new BedrockProvider(
          awsAccessKeyId, awsSecretAccessKey, config.awsRegion, config.awsBedrockTimeoutMs, logger, modelRegistry,
        ), logger)));
      }
    }

    // ── Memory, contacts, identity ─────────────────────────────────────────
    const baseMemory = WorkingMemory.createWithPostgres(pool, logger);
    const memory = options.wrapWorkingMemory ? options.wrapWorkingMemory(baseMemory) : baseMemory;
    let entityMemory: EntityMemory | undefined;
    // The same gate as production boot, so the suites never run the knowledge graph on a
    // database production would refuse.
    const embedding = await resolveKnowledgeGraphEmbedding(
      pool, { ...config, openaiApiKey, embeddingApiKey }, yamlConfig.embedding?.profiles, logger,
    );
    if (!embedding.ok && embedding.gate === 'schema') {
      warnings.push(`Entity memory is off: ${embedding.message}`);
    }
    if (embedding.ok) {
      const embeddingService = EmbeddingService.createWithEndpoint(embedding.endpoint, embedding.profile, logger, bus, modelRegistry);
      const kgStore = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, logger);
      entityMemory = new EntityMemory(kgStore, new MemoryValidator(kgStore, embeddingService), embeddingService, logger);
    }
    const bullpenService = BullpenService.createWithPostgres(pool, logger);
    const principalIdentities: ChannelIdentity[] = [];
    const principalPrimaryEmail: PrincipalPrimaryEmailRef = { current: null };
    const principalProfile: PrincipalProfileRef = { current: null };
    let principalContactId: string | null = null;
    // Production reloads these after a write to the principal's identities or profile,
    // so a later turn of a multi-turn case sees what contact-update saved. The
    // generation drops a slower, older read, as in src/index.ts (#1514).
    let refreshGeneration = 0;
    const contactService = ContactService.createWithPostgres(pool, entityMemory, logger, {
      onIdentitiesChanged: async (contactId: string) => {
        if (contactId !== principalContactId) return;
        const myGeneration = ++refreshGeneration;
        const snapshot = await readPrincipalIdentitySnapshot(contactService, contactId);
        if (myGeneration !== refreshGeneration) return;
        principalIdentities.length = 0;
        principalIdentities.push(...snapshot.identities);
        principalPrimaryEmail.current = snapshot.primaryEmail;
        principalProfile.current = snapshot.profile;
      },
    });
    // Production's permission model (#2227): without it every known contact reached the
    // coordinator with no AUTHORIZATION section, unlike production. Fatal on a bad file, as
    // in production.
    const authConfig = loadAuthConfig(configDir);
    const contactResolver = new ContactResolver(contactService, entityMemory, new AuthorizationService(authConfig), logger);
    const entityContextAssembler = new EntityContextAssembler(pool, logger);

    const agentIdentity = await bootstrapAgentIdentity(officeIdentityService.get().assistant.name, pool, logger);
    const agentContactId = agentIdentity.contactId;

    const principalContact = await contactService.findContactBySystemRole('principal');
    if (principalContact) {
      principalContactId = principalContact.id;
      const snapshot = await readPrincipalIdentitySnapshot(contactService, principalContact.id);
      principalIdentities.push(...snapshot.identities);
      principalPrimaryEmail.current = snapshot.primaryEmail;
      principalProfile.current = snapshot.profile;
      // The same gaps production logs at boot, so a smoke, scenario or snapshot run on
      // a prompt without them says why (shared helper; see agent-assembly.ts).
      warnings.push(...principalIdentitySnapshotGaps(snapshot));
    } else if (llmMode === 'live') {
      // Production refuses to serve without a principal (setup-required mode), so a
      // live run without one would test a path production never takes.
      throw new Error(
        'No principal contact (system_role=principal) in this database. Production does not run agents ' +
        'until onboarding creates one; complete onboarding at /setup first.',
      );
    } else {
      warnings.push(
        'No principal contact (system_role=principal): the Who you serve section is absent and ' +
        '${principal_contact_id} renders empty. Production would not serve this prompt until onboarding.',
      );
    }
    const principalNames = [principalContact?.displayName, principalContact?.preferredName]
      .filter((n): n is string => typeof n === 'string' && n.trim().length > 0);
    const conversationEntities = ConversationEntityState.createWithPostgres(pool, logger, principalNames);

    // Own mailboxes for "## Your Contact Details" — production's resolution (enabled
    // + a vault grant) when the vault is available. The grants are read, never used.
    const emailAccountsRepo = new EmailAccountsRepo(pool);
    const emailAccounts: Array<{ name: string; selfEmail: string }> = (vault
      ? await resolveEmailAccounts(emailAccountsRepo, vault, logger)
      : (await emailAccountsRepo.list()).filter(a => a.enabled)
    ).map(a => ({ name: a.name, selfEmail: a.selfEmail }));
    const selfEmails = emailAccounts.map(a => a.selfEmail);

    // What agents get: reads only (see header). The real services stay on the
    // returned stack so tests can seed state through them.
    const agentAutonomy = readOnlyView(autonomyService, AUTONOMY_READS, 'autonomyService');
    const agentOfficeIdentity = readOnlyView(officeIdentityService, OFFICE_IDENTITY_READS, 'officeIdentityService');

    // ── Tools, skills, agents ──────────────────────────────────────────────
    const toolDiscovery = discoverToolManifests(skillsDir, logger);
    const skillDiscovery = discoverSkillManifests(skillsDir, logger);
    const agentDiscovery = discoverAgentManifests(agentsDir);
    const discovered = {
      tools: new Set(toolDiscovery.map(d => d.name)),
      skills: new Set(skillDiscovery.map(d => d.name)),
      agents: new Set(agentDiscovery.map(d => d.name)),
    };
    const enabled = (options.enablement ?? 'registry') === 'registry'
      ? await productionEnabledNames(
        pool, discovered, { tools: toolDiscovery, skills: skillDiscovery }, vault, calendarConfigured, configDir, logger,
      )
      : { tool: discovered.tools, skill: discovered.skills, agent: discovered.agents };

    const toolRegistry = new ToolRegistry(config.timezone);
    const skillRegistry = new SkillRegistry();
    await loadToolsFromDirectory(toolDiscovery, toolRegistry, logger, enabled.tool);
    loadSkillsFromDiscovery(skillDiscovery, skillRegistry, logger, enabled.skill);
    // Boot's order: MCP tools after local ones, projected before synthetic singletons.
    const snapshotMcp = registerSnapshotMcpServers({
      configDir,
      snapshotDir: MCP_SNAPSHOT_DIR,
      ...(options.mcpSnapshotDirs ? { extraSnapshotDirs: options.mcpSnapshotDirs } : {}),
      toolRegistry,
      skillRegistry,
      skillsDir,
      logger,
    });
    for (const server of snapshotMcp.serversWithoutSnapshot) {
      warnings.push(`MCP server '${server}' has no tools/list snapshot in tests/fixtures/mcp, so its tools are absent here.`);
    }
    warnings.push(...snapshotMcp.problems);
    registerSyntheticSingletonSkills(toolRegistry, skillRegistry, logger);

    const enabledAgents = enabled.agent;
    const agentConfigs: AgentYamlConfig[] = [];
    for (const disc of agentDiscovery) {
      if (!enabledAgents.has(disc.name)) continue;
      if (!disc.config) {
        throw new Error(`Agent '${disc.name}' has an invalid config: ${disc.error ?? 'unknown error'}`);
      }
      agentConfigs.push(disc.config);
    }

    const agentRegistry = new AgentRegistry();
    registerAgentRoster(agentRegistry, agentConfigs);
    bus.setAgentOwner((agentId) => agentRegistry.has(agentId));

    // ── Execution layer ────────────────────────────────────────────────────
    // Task outreach (#2312), as src/index.ts wires it, so sends and record-outreach behave as
    // in production. With no taskRepo here, rows carry no task title and nothing closes them;
    // a recording stack reads titles through its read-only task repo.
    const taskOutreachRepo = new TaskOutreachRepo(pool);
    const outreachNonOrgDomains = principalOrgDomainSet(yamlConfig.security?.principal_org_domains ?? []);
    const recording = options.recordSends
      ? buildRecordingSends({
          recorder: options.recordSends,
          ...(options.wrapActionLog ? { wrapActionLog: options.wrapActionLog } : {}),
          pool, bus, logger, config, yamlConfig, configDir,
          modelRegistry, providerRegistry,
          contactService, principalIdentities, principalPrimaryEmail, principalProfile,
          officeIdentity: officeIdentityService.get(),
          coordinatorPrompt: agentConfigs.find(c => c.name === 'coordinator')?.system_prompt,
          emailAccounts, selfEmails,
          signalPhoneNumber,
          autonomyService: agentAutonomy,
          conversationEntities,
          taskOutreachRepo,
          outreachNonOrgDomains,
          warnings,
          ...(options.requireBandReviewJudge ? { requireBandReviewJudge: true } : {}),
        })
      : undefined;
    // The layer agents call always gets the no-send gateway. A recording stack builds a
    // second layer for the sends it reviews (below), so everything else runs as before.
    const outboundGateway = createNoSendOutboundGateway({
      contactService, bus, logger, principalIdentities, autonomyService: agentAutonomy,
    });
    const lateDelivery = resolveLateDeliveryConfig(yamlConfig.delegate);
    // Deliberately absent (see header — deferred work a real instance would act on):
    // schedulerService, taskRepo, bullpenService, workingDocsRepo, approvalTrigger,
    // nylasCalendarClient, browserService; and, unless the caller opts in,
    // outboundContextService, openDelegationLookup, and (recordSends) the action log,
    // approval delivery, disclosure decisions and the escalation judge.
    const outboundContextService = options.wrapOutboundContext
      ? options.wrapOutboundContext(new OutboundContextService(pool, logger))
      : undefined;
    // The same lookup src/index.ts builds.
    const openDelegationLookup: OpenDelegationLookup | undefined = options.delegationClaims
      ? {
          findInFlight: (targetAgent, originConversationId) =>
            findInFlightPendingDelegation(pool, { targetAgent, originConversationId }),
          acquireRunning: (params) => acquireRunningDelegation(pool, params),
          releaseRunning: (delegateEventId) => releaseRunningDelegation(pool, delegateEventId),
        }
      : undefined;
    // Delegated sign-in verification (#2017), wired like src/index.ts so the default-deny
    // scrub runs under test. No channel adapters start in this stack, so no channel is
    // enabled and askChannel() is always null; nothing here asks the principal anything.
    const baseVerification = createVerificationRuntime(
      pool, logger, resolveVerificationConfig(yamlConfig.verification), principalIdentities, new Set<string>(),
    );
    const verification = options.wrapVerification ? options.wrapVerification(baseVerification) : baseVerification;
    const outreachDeps = {
      principalIdentities,
      selfEmails,
      selfPhones: [signalPhoneNumber, smsFromNumber].filter((n): n is string => typeof n === 'string' && n !== ''),
      nonOrgDomains: outreachNonOrgDomains,
      log: logger,
    };
    const taskOutreach = new TaskOutreachService(taskOutreachRepo, outreachDeps);
    const layerOptions: NonNullable<ConstructorParameters<typeof ExecutionLayer>[2]> = {
      bus,
      agentRegistry,
      contactService,
      outboundGateway,
      entityMemory,
      entityContextAssembler,
      agentContactId,
      // The fixture's score, the constructed (tier) gating: Gate C as before #2312, except in
      // the work the caller says follows the fixture's gating (see agentLayerAutonomy).
      autonomyService: agentLayerAutonomy(agentAutonomy, options.agentLayerFollowsFixtureGating ?? (() => false)),
      secretsService: createTestModeSecrets(),
      officeIdentityService: agentOfficeIdentity,
      auditLogRepo: new AuditLogRepo(pool, logger),
      // A synchronous write to the contact row, like contact-create, not deferred work.
      // Without it contact-register (which declares the capability) fails closed, so
      // ceo-inbox could never record a sender or a resolved recipient in a test (#2014).
      confidencePipeline: new ConfidencePipeline(contactService, logger),
      timezone: config.timezone,
      selfEmail: selfEmails[0],
      selfEmails,
      skillOutputMaxLength: yamlConfig.skillOutput?.maxLength,
      defaultDelegateTimeoutMs: yamlConfig.delegate?.defaultTimeoutMs,
      bypassLadder: resolveBypassLadder(yamlConfig.autonomy?.bypass_ladder),
      resumableCeilings: resolveTasksConfig(yamlConfig.tasks).resumableCeilings,
      principalIdentities,
      skillRegistry,
      verification,
      taskOutreach,
      ...(outboundContextService ? { outboundContextService } : {}),
      ...(openDelegationLookup ? { openDelegationLookup } : {}),
    };
    const baseExecutionLayer = new ExecutionLayer(toolRegistry, logger, layerOptions);
    // A recording stack's review layer (#2312): the same layer with what production's gets for
    // sends and approvals — the recording gateway, the action log, approval delivery,
    // disclosure decisions, the escalation judge and band evidence — so a held send can be
    // delivered to the principal and approved on a later live turn. Only calls the wrapper
    // routes here see any of it; approve-action's replay runs here too (it re-invokes the
    // layer it was called on).
    const reviewExecutionLayer = recording
      ? new ExecutionLayer(toolRegistry, logger, {
          ...layerOptions,
          // Per-call gating, as production's: the case's fixture decides Gate C here.
          autonomyService: agentAutonomy,
          outboundGateway: recording.gateway,
          taskOutreach: new TaskOutreachService(taskOutreachRepo, {
            ...outreachDeps, lookupTask: taskLookupFrom(recording.taskReads),
          }),
          ...recording.executionOptions,
        })
      : undefined;
    const executionLayer = options.wrapExecutionLayer
      ? options.wrapExecutionLayer(baseExecutionLayer, reviewExecutionLayer)
      : baseExecutionLayer;
    // Catch a wrapper that forwards only invoke() at boot, not mid-task on a wake path.
    const missingMethods = EXECUTION_LAYER_METHODS.filter(
      m => typeof (executionLayer as unknown as Record<string, unknown>)[m] !== 'function',
    );
    if (missingMethods.length > 0) {
      throw new Error(`wrapExecutionLayer returned a layer without ${missingMethods.join(', ')} — delegate them to the real layer`);
    }

    // ── Agents (same builder as src/index.ts) ──────────────────────────────
    const turnInjection = resolveTurnInjectionConfig(yamlConfig.dispatch);
    // Throw on a bad pattern. Production warns and continues; a suite that did
    // the same would score runs against a weaker scanner than the one it ships.
    const injectionScanner = createInboundScanner(yamlConfig, logger, { onParseError: 'throw' });
    const turnLanes = new TurnLanes({
      enabled: turnInjection.enabled,
      maxInjectionsPerTurn: turnInjection.maxInjectionsPerTurn,
      extraRoundsPerInjection: turnInjection.extraRoundsPerInjection,
      laneWaitTimeoutMs: turnInjection.laneWaitTimeoutMs,
      logger,
    });
    const agents = assembleAgents(agentConfigs, {
      logger,
      bus,
      toolRegistry,
      skillRegistry,
      agentRegistry,
      models: { modelRouter, modelRegistry, providerRegistry },
      executionLayer,
      memory,
      entityMemory,
      estimateCostUsd,
      autonomyService: agentAutonomy,
      officeIdentityService: agentOfficeIdentity,
      securityContextBlock,
      timezone: config.timezone,
      // Not gated on the channel registry as production is (see the header).
      channelAccounts: { email: selfEmails[0], signal: signalPhoneNumber, sms: smsFromNumber },
      selfEmails,
      principalIdentities,
      principalPrimaryEmail,
      principalProfile,
      agentContactId,
      principalContactId: principalContact?.id,
      // The per-turn sign-in verification block (#2017), same gating as production.
      verification,
      browserSessionAlive: options.browserSessionAlive,
      // Reads only, so it creates no deferred work: the same per-turn block production
      // renders (#2338). Writes still have no repo here (see header).
      pinnedContextReader: createPinnedContextReader({
        workingDocsRepo: new WorkingDocsRepo(pool, logger),
        entityMemory,
        logger,
        warnChars: yamlConfig.documentWorkspace?.pinnedContextWarnChars,
      }),
      defaultDelegateTimeoutMs: yamlConfig.delegate?.defaultTimeoutMs,
      lateDelivery: {
        enabled: lateDelivery.enabled,
        ttlMinutes: lateDelivery.ttlMinutes,
        sweepIntervalMinutes: lateDelivery.sweepIntervalMinutes,
      },
      bullpenService: readOnlyBullpen(
        options.wrapBullpenService ? options.wrapBullpenService(bullpenService) : bullpenService,
      ),
      conversationEntities,
      // No taskRepo or workingDocsRepo — see header.
      turnLanes,
    });
    for (const assembled of agents) {
      new AgentRuntime(assembled.runtimeConfig).register();
    }

    // Unresolved pins drop tools and SKILL.md bodies; resolvePinnedSkills only logs
    // them, and the stack's logger is usually silent. A pin on an MCP server without
    // a snapshot appears here.
    for (const assembled of agents) {
      for (const pin of assembled.pinResolution.unresolvedPins) {
        warnings.push(
          `${assembled.agentConfig.name}: pin '${pin.pin}' unresolved (${pin.reason}` +
          `${pin.missingTools ? `: ${pin.missingTools.join(', ')}` : ''})`,
        );
      }
    }

    const disabledTools: TestModeStack['disabledTools'] = {};
    for (const assembled of agents) {
      const disabled = assembled.toolDefs
        .map(def => ({ tool: def.name, missing: baseExecutionLayer.unavailableCapabilities(def.name) }))
        .filter(entry => entry.missing.length > 0);
      if (disabled.length > 0) disabledTools[assembled.agentConfig.name] = disabled;
    }

    const identityService = officeIdentityService;
    const agent = (name: string): AssembledAgent => {
      const found = agents.find(a => a.agentConfig.name === name);
      if (!found) throw new Error(`Agent '${name}' is not loaded in this stack`);
      return found;
    };

    return {
      config,
      yamlConfig,
      logger,
      pool,
      bus,
      agentRegistry,
      toolRegistry,
      skillRegistry,
      executionLayer,
      outboundGateway,
      contactService,
      contactResolver,
      officeIdentityService: identityService,
      autonomyService,
      bullpenService,
      verification,
      agentContactId,
      principalContactId: principalContact?.id,
      principalIdentities,
      trustScoring: {
        channelPolicies: authConfig.channelPolicies,
        // As src/index.ts reads security.trust_score.
        weights: yamlConfig.security?.trust_score
          ? {
              channelWeight: yamlConfig.security.trust_score.channel_weight ?? 0.4,
              contactWeight: yamlConfig.security.trust_score.contact_weight ?? 0.4,
              maxRiskPenalty: yamlConfig.security.trust_score.max_risk_penalty ?? 0.2,
            }
          : undefined,
        confidencePipeline: new ConfidencePipeline(contactService, logger),
      },
      llmProviders: providerRegistry,
      turnLanes,
      injectionScanner,
      agents,
      disabledTools,
      snapshotMcpTools: snapshotMcp.tools,
      warnings,
      ...(recording?.bandReviewJudgeMissing ? { bandReviewJudgeMissing: recording.bandReviewJudgeMissing } : {}),
      agent,
      renderSystemPrompt: async (agentName = 'coordinator', renderOpts = {}) => {
        const assembled = agent(agentName);
        // An ordinary chat turn: no intent anchor, not a scheduler run, so the task
        // tail is empty and the task-bound harness blocks never apply.
        return (await buildBaseSystemPrompt(assembled.runtimeConfig, {
          now: renderOpts.now ?? new Date(),
          logger,
          onBlockError: 'throw',
        }))
          + formatTaskTailBlocks({ channelId: 'cli', conversationId: 'render', hasToolAllowlist: false });
      },
      shutdown: async () => {
        // End the pool even if the identity watcher fails to stop — a leaked pool
        // keeps the process alive.
        try {
          await identityService.stop();
        } finally {
          await pool.end();
        }
      },
    };
  } catch (err) {
    // Release what we opened so a failed boot does not hang the process.
    try {
      await officeIdentityService?.stop();
    } catch (stopErr) {
      logger.error({ err: stopErr }, 'test-mode stack: identity service stop failed during boot cleanup');
    }
    try {
      await pool.end();
    } catch (endErr) {
      logger.error({ err: endErr }, 'test-mode stack: pool.end() failed during boot cleanup');
    }
    throw err;
  }
}
