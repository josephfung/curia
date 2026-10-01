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
//     fails inside the gateway before it reaches a network call.
//   - No channel adapters. outbound.message events stay on the in-process bus.
//   - Withheld credentials. Skills that call a provider directly with a declared
//     secret (e.g. ceo-inbox → Nylas) get a "withheld in test mode" error. Only the
//     read-only secrets in TEST_MODE_PASSTHROUGH_SECRETS fall back to env as usual.
//   - No deferred work. The stack usually shares a database with a real instance
//     (smoke reads DATABASE_URL from .env), and anything a real process acts on
//     later would send with real transports. So the ExecutionLayer gets no
//     scheduler service, task repo, action log (pending approvals), outbound-context
//     service or bullpen service, and the gateway gets no outbound queue. Tools that
//     need them fail with a missing-capability error; scenario tests stub them.
//   - No calendar client, MCP servers, browser, scheduler loop or heartbeat.
//
// The real vault IS read, the way boot reads it (#911): LLM API keys, the Signal
// number and the email-account grants come from it, so the prompt's contact-details
// block matches production. That needs SECRET_ENCRYPTION_KEY. The vault service is
// used here only; the ExecutionLayer never sees it.
//
// Known differences from production (none of them change the system prompt):
//   - The tools above fail closed instead of running.
//   - MCP-projected tools (google-workspace) are absent from the tool list.
//   - No Dispatcher: the caller wires its own (the smoke harness does).
//   - Offline mode without SECRET_ENCRYPTION_KEY: no Signal number, and email
//     self-addresses come from email_accounts without the vault grant check.

import * as path from 'node:path';
import { loadConfig, loadYamlConfig, resolveLateDeliveryConfig, resolveTasksConfig, type Config, type YamlConfig } from '../config.js';
import { createLogger, type Logger } from '../logger.js';
import { createPool, type DbPool } from '../db/connection.js';
import { EventBus } from '../bus/bus.js';
import { AuditLogger } from '../audit/logger.js';
import { AuditLogRepo } from '../audit/audit-log-repo.js';
import { AgentRuntime } from '../agents/runtime.js';
import { AgentRegistry } from '../agents/agent-registry.js';
import { discoverAgentManifests, type AgentYamlConfig } from '../agents/loader.js';
import { AnthropicProvider } from '../agents/llm/anthropic.js';
import { OpenRouterProvider } from '../agents/llm/openrouter.js';
import { ModelRegistry } from '../agents/llm/model-registry.js';
import { ModelRouter, type ModelRoutingConfig } from '../agents/llm/model-router.js';
import { createEstimateCostUsd } from '../agents/llm/pricing.js';
import type { LLMProvider } from '../agents/llm/provider.js';
import { buildBaseSystemPrompt, formatTaskTailBlocks } from '../agents/system-prompt.js';
import { AutonomyService } from '../autonomy/autonomy-service.js';
import { resolveBypassLadder } from '../autonomy/effective-standing.js';
import { applyChannelVaultSecrets } from '../channels/apply-channel-vault-secrets.js';
import { EmailAccountsRepo } from '../channels/email/email-accounts-repo.js';
import { resolveEmailAccounts } from '../channels/email/resolve-email-accounts.js';
import { ContactService } from '../contacts/contact-service.js';
import { ContactResolver } from '../contacts/contact-resolver.js';
import type { ChannelIdentity, PrincipalPrimaryEmailRef } from '../contacts/types.js';
import { WorkingDocsRepo } from '../db/working-docs-repo.js';
import { OutboundContentFilter } from '../dispatch/outbound-filter.js';
import { bootstrapAgentIdentity } from '../entity-context/bootstrap.js';
import { EntityContextAssembler } from '../entity-context/assembler.js';
import { ConversationEntityState } from '../entity-context/conversation-entities.js';
import { OfficeIdentityService } from '../identity/service.js';
import { BullpenService } from '../memory/bullpen.js';
import { EmbeddingService } from '../memory/embedding.js';
import { EntityMemory } from '../memory/entity-memory.js';
import { KnowledgeGraphStore } from '../memory/knowledge-graph.js';
import { MemoryValidator } from '../memory/validation.js';
import { WorkingMemory } from '../memory/working-memory.js';
import { RegistryRepo } from '../registry/registry-repo.js';
import { applyVaultSecrets } from '../secrets/apply-vault-secrets.js';
import { loadEncryptionKey } from '../secrets/crypto.js';
import { SecretsService } from '../secrets/secrets-service.js';
import { compileSecurityContextBlock, resolveSecurityThresholds } from '../security/security-context.js';
import { ExecutionLayer } from '../skills/execution.js';
import { discoverToolManifests, loadToolsFromDirectory } from '../skills/loader.js';
import { OutboundGateway } from '../skills/outbound-gateway.js';
import { ToolRegistry } from '../skills/registry.js';
import { SkillRegistry } from '../skills/skill-registry.js';
import {
  discoverSkillManifests,
  loadSkillsFromDiscovery,
  registerSyntheticSingletonSkills,
} from '../skills/skill-loader.js';
import {
  assembleAgents,
  readPrincipalIdentitySnapshot,
  registerAgentRoster,
  type AssembledAgent,
} from './agent-assembly.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

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
 */
export type ExecutionLayerWrapper = (layer: ExecutionLayer) => ExecutionLayer;

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
   * Which agents/tools/skills load. 'registry' (default) honours the enabled flags in
   * agent_registry / tool_registry / skill_registry, like production; a table with no
   * rows (a fresh DB that has never booted) enables everything on disk for that kind.
   * 'all' ignores the tables.
   */
  enablement?: 'registry' | 'all';
  /** See ExecutionLayerWrapper. */
  wrapExecutionLayer?: ExecutionLayerWrapper;
  /** Override for fixtures. Default <repo>/agents and <repo>/skills. */
  agentsDir?: string;
  skillsDir?: string;
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
  /** No transport clients: every send fails before any network call. */
  outboundGateway: OutboundGateway;
  contactService: ContactService;
  contactResolver: ContactResolver;
  officeIdentityService: OfficeIdentityService;
  autonomyService: AutonomyService;
  /** Read-only here: agents see pending threads, but cannot post (see header). */
  bullpenService: BullpenService;
  agentContactId: string | undefined;
  principalContactId: string | undefined;
  /** Every assembled agent, already registered on the bus. */
  agents: AssembledAgent[];
  /** Look up an assembled agent by name. Throws if it is not loaded. */
  agent(name: string): AssembledAgent;
  /**
   * The exact system string the runtime sends this agent for an ordinary
   * (non-scheduler, non-task-bound) turn at `now`. Same functions AgentRuntime calls.
   */
  renderSystemPrompt(agentName?: string, opts?: { now?: Date }): Promise<string>;
  shutdown(): Promise<void>;
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
    listUserNames: async (): Promise<string[]> => [],
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

/**
 * Names enabled in a registry table, or null when the table is empty (never booted)
 * and everything on disk should load.
 */
async function enabledNamesFrom(
  pool: DbPool,
  table: 'agent_registry' | 'tool_registry' | 'skill_registry',
  logger: Logger,
): Promise<Set<string> | null> {
  const rows = await new RegistryRepo(pool, table).listRows();
  if (rows.length === 0) {
    logger.warn({ table }, 'test-mode stack: registry table is empty — enabling everything on disk');
    return null;
  }
  return new Set(rows.filter(r => r.enabled).map(r => r.name));
}

function routingFor(yamlConfig: YamlConfig, model: string | undefined, modelRegistry: ModelRegistry): ModelRoutingConfig {
  const configured = yamlConfig.model_routing;
  if (!configured) {
    throw new Error('model_routing config section is required in config/default.yaml');
  }
  if (!model) return configured;
  if (!modelRegistry.isKnownModel(model)) {
    throw new Error(
      `Unknown model '${model}'. Known models: ${Object.keys(modelRegistry.getAllModels()).sort().join(', ')}`,
    );
  }
  return {
    ...configured,
    tiers: { fast: { model }, standard: { model }, powerful: { model } },
  };
}

/**
 * Build the test-mode stack against `config.databaseUrl`. The database must be
 * migrated. Writes the same idempotent bootstrap rows a real boot writes (office
 * identity, agent contact), and whatever the agents do while it runs.
 */
export async function createTestModeStack(options: TestModeStackOptions = {}): Promise<TestModeStack> {
  // A copy: vault values are written onto it below.
  const config: Config = { ...(options.config ?? loadConfig()) };
  const llmMode = options.llm ?? 'live';
  const yamlConfig = options.yamlConfig ?? loadYamlConfig(path.join(REPO_ROOT, 'config'));
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

    // ── Vault (boot's view of it) ──────────────────────────────────────────
    // Same resolution as src/index.ts: bootstrap secrets (LLM keys) and channel secrets
    // (Signal number) onto config. Only provider construction and the prompt's own
    // contact details read them; no transport client is ever built from them.
    let vault: SecretsService | undefined;
    let encryptionKey: Buffer | undefined;
    try {
      encryptionKey = loadEncryptionKey();
    } catch (err) {
      if (llmMode === 'live') {
        throw new Error(
          'SECRET_ENCRYPTION_KEY is required: LLM API keys are read from the vault (#911). ' +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      logger.warn({ err }, 'test-mode stack: no vault key — rendering without vault-held contact details');
    }
    if (encryptionKey) {
      vault = new SecretsService(pool, encryptionKey, logger);
      await applyVaultSecrets(config, vault, logger);
      await applyChannelVaultSecrets(config, vault, process.env, logger);
    }

    const autonomyService = new AutonomyService(pool, logger);
    officeIdentityService = new OfficeIdentityService(pool, logger, bus);
    await officeIdentityService.initialize();

    // ── LLM providers ──────────────────────────────────────────────────────
    const modelRegistry = new ModelRegistry(logger);
    const routing = routingFor(yamlConfig, options.model, modelRegistry);
    const modelRouter = new ModelRouter(routing, modelRegistry, logger);
    const estimateCostUsd = createEstimateCostUsd(modelRegistry, routing.tiers.standard.model);
    const providerRegistry = new Map<string, LLMProvider>();
    if (llmMode === 'offline') {
      providerRegistry.set('anthropic', offlineProvider('anthropic'));
      providerRegistry.set('openrouter', offlineProvider('openrouter'));
    } else {
      if (config.anthropicApiKey) {
        providerRegistry.set('anthropic', new AnthropicProvider(config.anthropicApiKey, logger, modelRegistry));
      }
      if (config.openrouterApiKey) {
        providerRegistry.set('openrouter', new OpenRouterProvider(config.openrouterApiKey, logger, modelRegistry));
      }
    }

    // ── Memory, contacts, identity ─────────────────────────────────────────
    const memory = WorkingMemory.createWithPostgres(pool, logger);
    let entityMemory: EntityMemory | undefined;
    if (config.openaiApiKey) {
      const embeddingService = EmbeddingService.createWithOpenAI(config.openaiApiKey, logger, bus, modelRegistry);
      const kgStore = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, logger);
      entityMemory = new EntityMemory(kgStore, new MemoryValidator(kgStore, embeddingService), embeddingService, logger);
    }
    const bullpenService = BullpenService.createWithPostgres(pool, logger);
    const contactService = ContactService.createWithPostgres(pool, entityMemory, logger);
    const contactResolver = new ContactResolver(contactService, entityMemory, undefined, logger);
    const entityContextAssembler = new EntityContextAssembler(pool, logger);

    const agentIdentity = await bootstrapAgentIdentity(officeIdentityService.get().assistant.name, pool, logger);
    const agentContactId = agentIdentity.contactId;

    const principalContact = await contactService.findContactBySystemRole('principal');
    const principalIdentities: ChannelIdentity[] = [];
    const principalPrimaryEmail: PrincipalPrimaryEmailRef = { current: null };
    if (principalContact) {
      const snapshot = await readPrincipalIdentitySnapshot(contactService, principalContact.id);
      principalIdentities.push(...snapshot.identities);
      principalPrimaryEmail.current = snapshot.primaryEmail;
    } else {
      logger.warn('test-mode stack: no principal contact — the Principal Contact Details block will be absent');
    }
    const principalNames = [principalContact?.displayName, principalContact?.preferredName]
      .filter((n): n is string => typeof n === 'string' && n.trim().length > 0);
    const conversationEntities = ConversationEntityState.createWithPostgres(pool, logger, principalNames);

    // Own mailboxes for "## Your Contact Details" — production's resolution (enabled
    // + a vault grant) when the vault is available. The grants are read, never used.
    const emailAccountsRepo = new EmailAccountsRepo(pool);
    const selfEmails = vault
      ? (await resolveEmailAccounts(emailAccountsRepo, vault, logger)).map(a => a.selfEmail)
      : (await emailAccountsRepo.list()).filter(a => a.enabled).map(a => a.selfEmail);

    // Documents are inert rows — nothing outside this process acts on them.
    const workingDocsRepo = new WorkingDocsRepo(pool, logger);

    // ── Tools, skills, agents ──────────────────────────────────────────────
    const byRegistry = (options.enablement ?? 'registry') === 'registry';
    const toolRegistry = new ToolRegistry(config.timezone);
    const skillRegistry = new SkillRegistry();
    const toolDiscovery = discoverToolManifests(skillsDir, logger);
    const enabledTools = (byRegistry ? await enabledNamesFrom(pool, 'tool_registry', logger) : null)
      ?? new Set(toolDiscovery.map(d => d.name));
    await loadToolsFromDirectory(toolDiscovery, toolRegistry, logger, enabledTools);
    const skillDiscovery = discoverSkillManifests(skillsDir, logger);
    const enabledSkills = (byRegistry ? await enabledNamesFrom(pool, 'skill_registry', logger) : null)
      ?? new Set(skillDiscovery.map(d => d.name));
    loadSkillsFromDiscovery(skillDiscovery, skillRegistry, logger, enabledSkills);
    registerSyntheticSingletonSkills(toolRegistry, skillRegistry, logger);

    const agentDiscovery = discoverAgentManifests(agentsDir);
    const enabledAgents = byRegistry ? await enabledNamesFrom(pool, 'agent_registry', logger) : null;
    const agentConfigs: AgentYamlConfig[] = [];
    for (const disc of agentDiscovery) {
      if (enabledAgents && !enabledAgents.has(disc.name)) continue;
      if (!disc.config) {
        throw new Error(`Agent '${disc.name}' has an invalid config: ${disc.error ?? 'unknown error'}`);
      }
      agentConfigs.push(disc.config);
    }

    const agentRegistry = new AgentRegistry();
    registerAgentRoster(agentRegistry, agentConfigs);
    bus.setAgentOwner((agentId) => agentRegistry.has(agentId));

    // ── Execution layer ────────────────────────────────────────────────────
    const outboundGateway = createNoSendOutboundGateway({
      contactService, bus, logger, principalIdentities, autonomyService,
    });
    const lateDelivery = resolveLateDeliveryConfig(yamlConfig.delegate);
    // Deliberately absent (see header — deferred work a real instance would act on):
    // schedulerService, taskRepo, actionLogRepo, outboundContextService, bullpenService,
    // approvalTrigger, nylasCalendarClient, browserService.
    const baseExecutionLayer = new ExecutionLayer(toolRegistry, logger, {
      bus,
      agentRegistry,
      contactService,
      outboundGateway,
      entityMemory,
      entityContextAssembler,
      agentContactId,
      autonomyService,
      secretsService: createTestModeSecrets(),
      officeIdentityService,
      auditLogRepo: new AuditLogRepo(pool, logger),
      workingDocsRepo,
      timezone: config.timezone,
      selfEmail: selfEmails[0],
      selfEmails,
      skillOutputMaxLength: yamlConfig.skillOutput?.maxLength,
      defaultDelegateTimeoutMs: yamlConfig.delegate?.defaultTimeoutMs,
      bypassLadder: resolveBypassLadder(yamlConfig.autonomy?.bypass_ladder),
      resumableCeilings: resolveTasksConfig(yamlConfig.tasks).resumableCeilings,
      principalIdentities,
      skillRegistry,
    });
    const executionLayer = options.wrapExecutionLayer
      ? options.wrapExecutionLayer(baseExecutionLayer)
      : baseExecutionLayer;

    // ── Agents (same builder as src/index.ts) ──────────────────────────────
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
      autonomyService,
      officeIdentityService,
      securityContextBlock,
      timezone: config.timezone,
      channelAccounts: { email: selfEmails[0], phone: config.signalPhoneNumber },
      selfEmails,
      principalIdentities,
      principalPrimaryEmail,
      agentContactId,
      principalContactId: principalContact?.id,
      defaultDelegateTimeoutMs: yamlConfig.delegate?.defaultTimeoutMs,
      lateDelivery: { ttlMinutes: lateDelivery.ttlMinutes, sweepIntervalMinutes: lateDelivery.sweepIntervalMinutes },
      bullpenService,
      conversationEntities,
      workingDocsRepo,
      // No taskRepo: task-wake progress writes belong to a real instance.
    });
    for (const assembled of agents) {
      new AgentRuntime(assembled.runtimeConfig).register();
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
      agentContactId,
      principalContactId: principalContact?.id,
      agents,
      agent,
      renderSystemPrompt: async (agentName = 'coordinator', renderOpts = {}) => {
        const assembled = agent(agentName);
        // An ordinary chat turn: no intent anchor, not a scheduler run, so the task
        // tail is empty and the task-bound harness blocks never apply.
        return (await buildBaseSystemPrompt(assembled.runtimeConfig, { now: renderOpts.now ?? new Date(), logger }))
          + formatTaskTailBlocks({ channelId: 'cli', conversationId: 'render', hasToolAllowlist: false });
      },
      shutdown: async () => {
        await identityService.stop();
        await pool.end();
      },
    };
  } catch (err) {
    // Release what we opened so a failed boot does not hang the process.
    try {
      await officeIdentityService?.stop();
    } catch (stopErr) {
      logger.warn({ err: stopErr }, 'test-mode stack: identity service stop failed during boot cleanup');
    }
    try {
      await pool.end();
    } catch (endErr) {
      logger.warn({ err: endErr }, 'test-mode stack: pool.end() failed during boot cleanup');
    }
    throw err;
  }
}
