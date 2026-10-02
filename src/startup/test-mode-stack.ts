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
//     `disabledTools` lists them per agent. Runtimes see pending bullpen threads but
//     never write read watermarks, which would hide threads from the real agent.
//   - No shared-setting writes. Smoke turns run with principal standing, so agents get
//     read-only views of the autonomy score and office identity (a real instance would
//     send under a changed score), and no working-docs repo (ceo-inbox shadow drafts
//     feed the real instance's learning signal).
//   - No calendar client, MCP servers, browser, scheduler loop or heartbeat.
//
// The real vault IS read, the way boot reads it (#911): LLM API keys, the Signal
// number and the email-account grants come from it, so the prompt's contact-details
// block matches production. That needs SECRET_ENCRYPTION_KEY. The vault service and
// the values it returns stay inside createTestModeStack: the ExecutionLayer never sees
// the vault, and the returned `config` carries no vault value.
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
import { loadRegistryDefaults, reconcileRegistries } from '../registry/reconcile.js';
import { RegistryRepo } from '../registry/registry-repo.js';
import type { IRegistryRepo, RegistryRow } from '../registry/types.js';
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
  /** The real service. Agents only read it (see header); seed threads through it. */
  bullpenService: BullpenService;
  agentContactId: string | undefined;
  principalContactId: string | undefined;
  /**
   * The LLM providers agents use, keyed by provider id ('anthropic', 'openrouter').
   * For test infrastructure that needs its own model calls — the scenario judge (#1956)
   * — without the stack handing out the raw vault key. (The provider's SDK client still
   * holds it in-process, as it does for the agents; this is not an isolation boundary.)
   * Offline stacks hold providers that throw.
   */
  llmProviders: ReadonlyMap<string, LLMProvider>;
  /** Every assembled agent, already registered on the bus. */
  agents: AssembledAgent[];
  /**
   * Per agent: tools it is offered that the test-mode ExecutionLayer will refuse
   * (missing capability), with the capabilities each lacks. Empty agents omitted.
   * Measured on the unwrapped layer — a stub wrapper may answer some of these.
   */
  disabledTools: Record<string, Array<{ tool: string; missing: string[] }>>;
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
  discovered: { tools: Set<string>; skills: Set<string>; agents: Set<string> },
  logger: Logger,
): Promise<{ tool: Set<string>; skill: Set<string>; agent: Set<string> }> {
  const toolRepo = new DryRunRegistryRepo(new RegistryRepo(pool, 'tool_registry'));
  const skillRepo = new DryRunRegistryRepo(new RegistryRepo(pool, 'skill_registry'));
  const agentRepo = new DryRunRegistryRepo(new RegistryRepo(pool, 'agent_registry'));
  await reconcileRegistries({
    toolRepo,
    agentRepo,
    skillRepo,
    toolDiscoveryNames: discovered.tools,
    agentDiscoveryNames: discovered.agents,
    skillDiscoveryNames: discovered.skills,
    defaults: loadRegistryDefaults(path.join(REPO_ROOT, 'config', 'registry-defaults.yaml')),
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
const OFFICE_IDENTITY_READS = ['get', 'compileSystemPromptBlock', 'history'] as const;

/** Methods AgentRuntime calls on its ExecutionLayer. A wrapper must keep all of them. */
const EXECUTION_LAYER_METHODS = [
  'invoke',
  'getToolDefinitions',
  'resolveSkillActivationForAgent',
] as const;

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
  // Returned to the caller, so it never receives vault values (those stay in locals).
  const config: Config = { ...(options.config ?? loadConfig()) };
  let anthropicApiKey = config.anthropicApiKey;
  let openrouterApiKey = config.openrouterApiKey;
  let openaiApiKey = config.openaiApiKey;
  let signalPhoneNumber = config.signalPhoneNumber;
  const llmMode = options.llm ?? 'live';
  const warnings: string[] = [];
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
    // Only an UNSET key is tolerated (offline). A malformed one is a config bug and
    // loadEncryptionKey() throws for it in every mode.
    let vault: SecretsService | undefined;
    let encryptionKey: Buffer | undefined;
    if (process.env.SECRET_ENCRYPTION_KEY) {
      encryptionKey = loadEncryptionKey();
    } else if (llmMode === 'live') {
      throw new Error('SECRET_ENCRYPTION_KEY is required: LLM API keys are read from the vault (#911)');
    } else {
      warnings.push(
        'SECRET_ENCRYPTION_KEY is not set — no vault: the Signal number is missing from Your Contact ' +
        'Details and email addresses skip the grant check, so the prompt may differ from production.',
      );
    }
    if (encryptionKey) {
      vault = new SecretsService(pool, encryptionKey, logger);
      // Resolve onto a throwaway copy and keep only what the stack uses: the LLM keys
      // and the Signal number for the prompt. Nylas, Slack, SMS and API tokens are
      // dropped here, so nothing downstream can build a transport client from them.
      const resolved: Config = { ...config };
      await applyVaultSecrets(resolved, vault, logger);
      await applyChannelVaultSecrets(resolved, vault, process.env, logger);
      anthropicApiKey = resolved.anthropicApiKey;
      openrouterApiKey = resolved.openrouterApiKey;
      openaiApiKey = resolved.openaiApiKey;
      signalPhoneNumber = resolved.signalPhoneNumber;
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
      if (anthropicApiKey) {
        providerRegistry.set('anthropic', new AnthropicProvider(anthropicApiKey, logger, modelRegistry));
      }
      if (openrouterApiKey) {
        providerRegistry.set('openrouter', new OpenRouterProvider(openrouterApiKey, logger, modelRegistry));
      }
    }

    // ── Memory, contacts, identity ─────────────────────────────────────────
    const baseMemory = WorkingMemory.createWithPostgres(pool, logger);
    const memory = options.wrapWorkingMemory ? options.wrapWorkingMemory(baseMemory) : baseMemory;
    let entityMemory: EntityMemory | undefined;
    if (openaiApiKey) {
      const embeddingService = EmbeddingService.createWithOpenAI(openaiApiKey, logger, bus, modelRegistry);
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
    } else if (llmMode === 'live') {
      // Production refuses to serve without a principal (setup-required mode), so a
      // live run without one would test a path production never takes.
      throw new Error(
        'No principal contact (system_role=principal) in this database. Production does not run agents ' +
        'until onboarding creates one; complete onboarding at /setup first.',
      );
    } else {
      warnings.push(
        'No principal contact (system_role=principal): the Principal Contact Details block is absent and ' +
        '${principal_contact_id} renders empty. Production would not serve this prompt until onboarding.',
      );
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
      ? await productionEnabledNames(pool, discovered, logger)
      : { tool: discovered.tools, skill: discovered.skills, agent: discovered.agents };

    const toolRegistry = new ToolRegistry(config.timezone);
    const skillRegistry = new SkillRegistry();
    await loadToolsFromDirectory(toolDiscovery, toolRegistry, logger, enabled.tool);
    loadSkillsFromDiscovery(skillDiscovery, skillRegistry, logger, enabled.skill);
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
    const outboundGateway = createNoSendOutboundGateway({
      contactService, bus, logger, principalIdentities, autonomyService: agentAutonomy,
    });
    const lateDelivery = resolveLateDeliveryConfig(yamlConfig.delegate);
    // Deliberately absent (see header — deferred work a real instance would act on):
    // schedulerService, taskRepo, actionLogRepo, outboundContextService, bullpenService,
    // workingDocsRepo, approvalTrigger, nylasCalendarClient, browserService.
    const baseExecutionLayer = new ExecutionLayer(toolRegistry, logger, {
      bus,
      agentRegistry,
      contactService,
      outboundGateway,
      entityMemory,
      entityContextAssembler,
      agentContactId,
      autonomyService: agentAutonomy,
      secretsService: createTestModeSecrets(),
      officeIdentityService: agentOfficeIdentity,
      auditLogRepo: new AuditLogRepo(pool, logger),
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
    // Catch a wrapper that forwards only invoke() at boot, not mid-task on a wake path.
    const missingMethods = EXECUTION_LAYER_METHODS.filter(
      m => typeof (executionLayer as unknown as Record<string, unknown>)[m] !== 'function',
    );
    if (missingMethods.length > 0) {
      throw new Error(`wrapExecutionLayer returned a layer without ${missingMethods.join(', ')} — delegate them to the real layer`);
    }

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
      autonomyService: agentAutonomy,
      officeIdentityService: agentOfficeIdentity,
      securityContextBlock,
      timezone: config.timezone,
      channelAccounts: { email: selfEmails[0], phone: signalPhoneNumber },
      selfEmails,
      principalIdentities,
      principalPrimaryEmail,
      agentContactId,
      principalContactId: principalContact?.id,
      defaultDelegateTimeoutMs: yamlConfig.delegate?.defaultTimeoutMs,
      lateDelivery: { ttlMinutes: lateDelivery.ttlMinutes, sweepIntervalMinutes: lateDelivery.sweepIntervalMinutes },
      bullpenService: readOnlyBullpen(
        options.wrapBullpenService ? options.wrapBullpenService(bullpenService) : bullpenService,
      ),
      conversationEntities,
      // No taskRepo or workingDocsRepo — see header.
    });
    for (const assembled of agents) {
      new AgentRuntime(assembled.runtimeConfig).register();
    }

    // Unresolved pins drop tools and SKILL.md bodies; resolvePinnedSkills only logs
    // them, and the stack's logger is usually silent. MCP servers are never loaded
    // here, so an MCP-projected pin (google-workspace) always appears.
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
      agentContactId,
      principalContactId: principalContact?.id,
      llmProviders: providerRegistry,
      agents,
      disabledTools,
      warnings,
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
