// agent-assembly.ts — turns agent YAML + resolved services into AgentRuntime configs.
//
// This is the one place an agent's final shape is decided: pin resolution, SKILL.md
// appends, ${...} interpolation, discovery tools, model/provider binding and the
// coordinator-only blocks. src/index.ts, the test-mode stack (smoke, scenarios) and
// scripts/render-coordinator-prompt.ts all go through it (#1966). Before this, the
// smoke harness and the render script each rebuilt agents by hand and each drifted
// from production in its own way, so they tested a prompt production never sent.
//
// If you add a new block or AgentRuntime option, add it HERE. A copy elsewhere is
// exactly the drift this module exists to stop.
//
// The module is pure assembly: it constructs no services, opens no connections and
// never calls process.exit. Failures throw AgentAssemblyError; the caller decides
// whether that is a fatal boot error (index.ts) or a thrown test error (stack).

import type { Logger } from '../logger.js';
import type { EventBus } from '../bus/bus.js';
import type { AgentConfig } from '../agents/runtime.js';
import type { SystemPromptSources } from '../agents/system-prompt.js';
import type { AgentYamlConfig } from '../agents/loader.js';
import { interpolateRuntimeContext } from '../agents/loader.js';
import type { AgentRegistry } from '../agents/agent-registry.js';
import type { LLMProvider, LLMUsage, ToolDefinition } from '../agents/llm/provider.js';
import type { ModelRouter, Tier } from '../agents/llm/model-router.js';
import type { ModelRegistry } from '../agents/llm/model-registry.js';
import { AutonomyService } from '../autonomy/autonomy-service.js';
import type { OfficeIdentityService } from '../identity/service.js';
import type { WorkingMemory } from '../memory/working-memory.js';
import type { EntityMemory } from '../memory/entity-memory.js';
import { BULLPEN_PENDING_WINDOW_MINUTES, type BullpenService } from '../memory/bullpen.js';
import type { ExecutionLayer } from '../skills/execution.js';
import type { ToolRegistry } from '../skills/registry.js';
import type { SkillRegistry } from '../skills/skill-registry.js';
import {
  appendSkillInstructions,
  reportScheduledPinGaps,
  resolvePinnedSkills,
  type PinResolution,
} from '../skills/pin-resolution.js';
import type { ChannelIdentity, PrincipalPrimaryEmailRef } from '../contacts/types.js';
import type { ContactService } from '../contacts/contact-service.js';
import type { ConversationEntityState } from '../entity-context/conversation-entities.js';
import type { WorkingDocsRepo } from '../db/working-docs-repo.js';
import type { TaskRepo } from '../db/task-repo.js';
import { DEFAULT_ERROR_BUDGET } from '../errors/types.js';

/** Discovery tools injected for agents with `allow_discovery: true`. */
const DISCOVERY_TOOLS = ['tool-registry', 'skill-activate'] as const;

/**
 * An agent could not be assembled. `agentName` and `details` carry the structured
 * context the caller logs; the message is human-readable on its own.
 */
export class AgentAssemblyError extends Error {
  constructor(
    message: string,
    readonly agentName: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AgentAssemblyError';
  }
}

/**
 * Pass 1: register every agent so the specialist roster is complete before any
 * prompt is interpolated. Without the split the coordinator (alphabetically first)
 * would be interpolated before any specialist was registered and see an empty list.
 */
export function registerAgentRoster(agentRegistry: AgentRegistry, agentConfigs: readonly AgentYamlConfig[]): void {
  for (const agentConfig of agentConfigs) {
    agentRegistry.register(agentConfig.name, {
      role: agentConfig.role ?? 'specialist',
      description: agentConfig.description ?? agentConfig.name,
      displayName: agentConfig.display_name,
      expectedDurationSeconds: agentConfig.expected_duration_seconds,
    });
  }
}

export interface ModelBindingDeps {
  modelRouter: ModelRouter;
  modelRegistry: ModelRegistry;
  providerRegistry: ReadonlyMap<string, LLMProvider>;
}

export interface AgentModelBinding {
  provider: LLMProvider;
  resolvedModel: string;
  tier: Tier;
  fallbackModel: string;
  fallbackProvider: LLMProvider;
}

/**
 * Resolve the agent's capability tier to a concrete model, then look up the
 * provider from the model registry. This decouples tier→model from model→provider:
 * the registry is the single source of truth for which provider serves each model.
 * Also pre-resolves the fallback tier's model and provider (#813).
 */
export function resolveAgentModelBinding(agentConfig: AgentYamlConfig, deps: ModelBindingDeps): AgentModelBinding {
  const { modelRouter, modelRegistry, providerRegistry } = deps;
  const resolved = modelRouter.resolve(agentConfig.model.tier, agentConfig.model.needs);
  const providerName = modelRegistry.getProvider(resolved.model);
  if (!providerName) {
    throw new AgentAssemblyError(
      `Model '${resolved.model}' not found in registry — cannot resolve provider for agent '${agentConfig.name}'`,
      agentConfig.name,
      { model: resolved.model, tier: resolved.tier },
    );
  }
  const provider = providerRegistry.get(providerName);
  if (!provider) {
    throw new AgentAssemblyError(
      `No provider registered for '${providerName}' (model '${resolved.model}', agent '${agentConfig.name}') — set its API key or remap the tier`,
      agentConfig.name,
      { provider: providerName, model: resolved.model, tier: resolved.tier },
    );
  }

  // The fallback tier rules are fixed: fast→standard, standard→powerful, powerful→standard.
  // All tier models are validated when the ModelRouter is built, so a miss here means the
  // model registry and the provider registry disagree.
  const fallbackTier = modelRouter.getFallbackTier(resolved.tier);
  const fallbackResolved = modelRouter.resolve(fallbackTier);
  const fallbackProviderName = modelRegistry.getProvider(fallbackResolved.model);
  if (!fallbackProviderName) {
    throw new AgentAssemblyError(
      `Fallback model '${fallbackResolved.model}' has no registered provider — check model-registry.ts`,
      agentConfig.name,
      { fallbackModel: fallbackResolved.model },
    );
  }
  const fallbackProvider = providerRegistry.get(fallbackProviderName);
  if (!fallbackProvider) {
    throw new AgentAssemblyError(
      `Fallback provider '${fallbackProviderName}' not found in provider registry — check provider setup`,
      agentConfig.name,
      { fallbackModel: fallbackResolved.model, fallbackProviderName },
    );
  }

  return {
    provider,
    resolvedModel: resolved.model,
    tier: resolved.tier,
    fallbackModel: fallbackResolved.model,
    fallbackProvider,
  };
}

/**
 * Resolve the bootstrap-time ${...} placeholders in an agent's YAML prompt.
 *
 * - Coordinator: only ${principal_contact_id}. The identity block, specialist roster,
 *   own contact ID, date and timezone are injected per turn by AgentRuntime, so
 *   identity hot-reloads take effect without a restart.
 * - inject_specialists agents: roster + both contact IDs.
 * - Everyone else: both contact IDs. interpolateRuntimeContext runs its full replace
 *   chain unconditionally — a value not passed here would be blanked to '' by the
 *   UUID-format check, so every contact ID a prompt could reference MUST be passed.
 */
export function interpolateAgentSystemPrompt(
  agentConfig: AgentYamlConfig,
  ctx: { agentRegistry: AgentRegistry; agentContactId?: string; principalContactId?: string },
): string {
  if (agentConfig.role === 'coordinator') {
    // Do NOT pass officeIdentityBlock here — it is prepended per turn by AgentRuntime.
    return interpolateRuntimeContext(agentConfig.system_prompt, {
      principalContactId: ctx.principalContactId,
    });
  }
  if (agentConfig.inject_specialists) {
    return interpolateRuntimeContext(agentConfig.system_prompt, {
      availableSpecialists: ctx.agentRegistry.specialistSummary(),
      agentContactId: ctx.agentContactId,
      principalContactId: ctx.principalContactId,
    });
  }
  return interpolateRuntimeContext(agentConfig.system_prompt, {
    agentContactId: ctx.agentContactId,
    principalContactId: ctx.principalContactId,
  });
}

/**
 * What resolveSystemPromptSources() reads: the deployment-wide prompt inputs, before
 * they are narrowed to one agent. A full AgentAssemblyContext satisfies it.
 */
export type SystemPromptSourceContext = Pick<
  AgentAssemblyContext,
  | 'agentRegistry'
  | 'autonomyService'
  | 'officeIdentityService'
  | 'securityContextBlock'
  | 'timezone'
  | 'channelAccounts'
  | 'principalIdentities'
  | 'principalPrimaryEmail'
  | 'agentContactId'
>;

/**
 * Decide which prompt inputs one agent receives: the half of its runtime config that
 * buildBaseSystemPrompt() reads. `systemPrompt` is the bootstrap body —
 * interpolateAgentSystemPrompt() plus the pinned SKILL.md appends.
 *
 * The per-agent rules live here so they are written once: identity, security, the
 * specialist roster and the own contact ID are coordinator-only; autonomy follows
 * AutonomyService.receivesInjection(); time and both contact-details blocks go to
 * every agent. assembleAgent() spreads this into the runtime config, and the
 * curia-deploy eval harness calls it with snapshot-backed inputs (curia-deploy#261),
 * so a renderer outside this repo never re-derives who gets which block.
 */
export function resolveSystemPromptSources(
  agentConfig: AgentYamlConfig,
  systemPrompt: string,
  ctx: SystemPromptSourceContext,
): SystemPromptSources {
  const isCoordinator = agentConfig.role === 'coordinator';
  return {
    agentId: agentConfig.name,
    systemPrompt,
    // Coordinator + ceo-inbox receive autonomyService for per-task band injection
    // (spec 14 checklist / ADR-029). ceo-inbox's draft-vs-punt aggressiveness
    // tracks the live band; it must never write the global score itself.
    autonomyService: AutonomyService.receivesInjection(agentConfig) ? ctx.autonomyService : undefined,
    // All agents receive the per-turn time block. Specialists need a reliable "now"
    // too — scheduled agents make time-sensitive decisions (backoff gates, date math).
    timezone: ctx.timezone,
    // Coordinator-only: the identity block is prepended per turn, so identity
    // hot-reloads (file watcher or API PUT) apply on the next turn without a restart.
    officeIdentityService: isCoordinator ? ctx.officeIdentityService : undefined,
    // Coordinator-only: specialists operate in a trust-elevated context (tasks arrive
    // from the coordinator after the security layer has evaluated the sender). The
    // runtime states that contract on delegated tasks (#1871); withholding this
    // block is not itself the signal.
    securityContextBlock: isCoordinator ? ctx.securityContextBlock : undefined,
    // Curia's own contact details — injected into ALL agents (#387) so specialists
    // like essay-editor don't hallucinate account identifiers.
    channelAccounts: {
      email: ctx.channelAccounts.email || undefined,
      phone: ctx.channelAccounts.phone || undefined,
    },
    // Principal's verified channel identities — injected into ALL agents (#786, #1950).
    principalIdentities: ctx.principalIdentities,
    principalPrimaryEmail: ctx.principalPrimaryEmail,
    // Coordinator-only roster block. Specialists that opt in via inject_specialists
    // keep the bootstrap ${available_specialists} placeholder instead.
    availableSpecialists: isCoordinator ? ctx.agentRegistry.specialistSummary() : undefined,
    // Coordinator-only own contact ID in "## Your Contact Details". Specialists keep
    // the ${agent_contact_id} bootstrap placeholder.
    agentContactId: isCoordinator ? ctx.agentContactId : undefined,
    // Map YAML snake_case to AgentConfig camelCase, defaulting omitted fields.
    errorBudget: agentConfig.error_budget ? {
      maxTurns: agentConfig.error_budget.max_turns ?? DEFAULT_ERROR_BUDGET.maxTurns,
      maxConsecutiveErrors: agentConfig.error_budget.max_errors ?? DEFAULT_ERROR_BUDGET.maxConsecutiveErrors,
    } : undefined,
  };
}

/** Everything agent assembly reads. Optional services are simply not wired when absent. */
export interface AgentAssemblyContext {
  logger: Logger;
  bus: EventBus;
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
  /** Must already hold every agent (registerAgentRoster) — the roster is read from it. */
  agentRegistry: AgentRegistry;
  models: ModelBindingDeps;
  executionLayer: ExecutionLayer;
  memory?: WorkingMemory;
  entityMemory?: EntityMemory;
  estimateCostUsd?: (actualModel: string, usage: LLMUsage, logger?: Logger) => number;
  autonomyService?: AutonomyService;
  officeIdentityService?: OfficeIdentityService;
  securityContextBlock?: string;
  timezone: string;
  /** Curia's own addresses for the "## Your Contact Details" block. */
  channelAccounts: { email?: string; phone?: string };
  selfEmails: readonly string[];
  /** Shared, hot-reloaded array (#1514) — passed by reference, never copied. */
  principalIdentities: ChannelIdentity[];
  principalPrimaryEmail: PrincipalPrimaryEmailRef;
  agentContactId?: string;
  principalContactId?: string;
  defaultDelegateTimeoutMs?: number;
  lateDelivery: { ttlMinutes: number; sweepIntervalMinutes: number };
  bullpenService?: BullpenService;
  conversationEntities?: ConversationEntityState;
  workingDocsRepo?: WorkingDocsRepo;
  taskRepo?: TaskRepo;
}

export interface AssembledAgent {
  /** The parsed YAML this agent was built from. */
  agentConfig: AgentYamlConfig;
  pinResolution: PinResolution;
  /** Bootstrap system prompt (after interpolation and SKILL.md appends) — the
   *  AgentRuntime body. The per-turn string is buildBaseSystemPrompt(runtimeConfig). */
  systemPrompt: string;
  /** Tool names after pin expansion (excludes discovery tools). */
  pinnedToolNames: string[];
  /** Tool definitions the LLM sees, including discovery tools. */
  toolDefs: ToolDefinition[];
  /** Pass to `new AgentRuntime(...)`. Also a valid SystemPromptSources. */
  runtimeConfig: AgentConfig;
}

/**
 * Pass 2: assemble one agent. Call after registerAgentRoster().
 * Throws AgentAssemblyError when the agent's model cannot be bound to a provider.
 */
export function assembleAgent(agentConfig: AgentYamlConfig, ctx: AgentAssemblyContext): AssembledAgent {
  const { logger, toolRegistry, skillRegistry } = ctx;
  const isCoordinator = agentConfig.role === 'coordinator';

  // Expand pinned_skills (bundles) → member tools + instruction blocks + flags.
  const pinResolution = resolvePinnedSkills(
    agentConfig.pinned_skills ?? [],
    skillRegistry,
    toolRegistry,
    logger,
    agentConfig.name,
  );
  // Scheduled agents with unresolved pins still boot and keep their cron jobs
  // (#1501) — error-level log only, so monitoring can catch reduced toolsets.
  reportScheduledPinGaps(
    agentConfig.name,
    pinResolution,
    (agentConfig.schedule?.length ?? 0) > 0,
    logger,
  );

  let systemPrompt = interpolateAgentSystemPrompt(agentConfig, ctx);
  // Inject pinned skill instruction blocks (e.g. tasks / documents discipline).
  systemPrompt = appendSkillInstructions(systemPrompt, pinResolution.instructionBlocks);

  const pinnedToolNames = pinResolution.toolNames;
  const toolDefs = toolRegistry.toToolDefinitions(pinnedToolNames);

  // allow_discovery: true → inject tool-registry + skill-activate into the agent's
  // tool list. Skipped if already pinned to avoid duplicate tool definitions.
  // tool-registry discovers tools/skills; skill-activate loads a skill's tools +
  // SKILL.md instructions into the turn (Phase 3a / #1495).
  if (agentConfig.allow_discovery) {
    for (const discoveryTool of DISCOVERY_TOOLS) {
      if (pinnedToolNames.includes(discoveryTool)) continue;
      const discoveryToolDefs = toolRegistry.toToolDefinitions([discoveryTool]);
      if (discoveryToolDefs.length === 0) {
        logger.error(
          { agent: agentConfig.name, tool: discoveryTool },
          `allow_discovery is true but ${discoveryTool} is not registered — discovery/activation unavailable; check startup logs for skill load errors`,
        );
      } else {
        toolDefs.push(...discoveryToolDefs);
      }
    }
  }

  const binding = resolveAgentModelBinding(agentConfig, ctx.models);

  const runtimeConfig: AgentConfig = {
    // agentId, systemPrompt, and every field buildBaseSystemPrompt() reads — including
    // the coordinator-only gating. Decided in one place; see resolveSystemPromptSources.
    ...resolveSystemPromptSources(agentConfig, systemPrompt, ctx),
    provider: binding.provider,
    resolvedModel: binding.resolvedModel,
    tier: binding.tier,
    fallbackModel: binding.fallbackModel,
    fallbackProvider: binding.fallbackProvider,
    bus: ctx.bus,
    logger,
    memory: ctx.memory,
    entityMemory: ctx.entityMemory,
    executionLayer: ctx.executionLayer,
    pinnedTools: pinnedToolNames,
    skillToolDefs: toolDefs,
    pinnedSkillNames: pinResolution.resolvedSkills,
    skillRegistry,
    // Registry-backed context window lookups and cost estimation (DI so runtime is testable).
    modelRegistry: ctx.models.modelRegistry,
    estimateCostUsd: ctx.estimateCostUsd,
    // Every owned mailbox. Email recall requires one of these on the thread
    // so a BCC (Curia absent from To/CC) cannot look like a 1:1 (#1599).
    selfEmails: ctx.selfEmails,
    // Lets the runtime look up a delegate target's expected_duration_seconds (#387).
    agentRegistry: ctx.agentRegistry,
    defaultDelegateTimeoutMs: ctx.defaultDelegateTimeoutMs,
    lateDeliveryTtlMinutes: ctx.lateDelivery.ttlMinutes,
    lateDeliverySweepIntervalMinutes: ctx.lateDelivery.sweepIntervalMinutes,
    bullpenService: ctx.bullpenService,
    bullpenWindowMinutes: BULLPEN_PENDING_WINDOW_MINUTES,
    // Coordinator only (#1818). A specialist's delegate conversation has no stored
    // identities, and begin() on an empty set would fail closed on any person-shaped
    // send from that specialist.
    conversationEntities: isCoordinator ? ctx.conversationEntities : undefined,
    documentWorkspaceEnabled: pinResolution.documentWorkspaceEnabled,
    workingDocsRepo: ctx.workingDocsRepo,
    // taskRepo serves both task-wake scheduler refresh (tasks/heartbeat) and document
    // project-root resolution (documents). Wire whenever either skill is pinned.
    taskRepo: (pinResolution.heartbeatEligible || pinResolution.documentWorkspaceEnabled)
      ? ctx.taskRepo
      : undefined,
  };

  return { agentConfig, pinResolution, systemPrompt, pinnedToolNames, toolDefs, runtimeConfig };
}

/** Pass 2 over every agent, in config order. */
export function assembleAgents(
  agentConfigs: readonly AgentYamlConfig[],
  ctx: AgentAssemblyContext,
): AssembledAgent[] {
  return agentConfigs.map(agentConfig => assembleAgent(agentConfig, ctx));
}

/**
 * Read the principal's promptable identities: verified + active only. Shared by
 * the boot-time hot-reload in index.ts and the test-mode stack so the
 * "## Principal Contact Details" block is built from the same filter.
 */
export async function readPrincipalIdentitySnapshot(
  contactService: Pick<ContactService, 'getContactWithIdentities'>,
  principalContactId: string,
): Promise<{ identities: ChannelIdentity[]; primaryEmail: string | null }> {
  const withIdentities = await contactService.getContactWithIdentities(principalContactId);
  const identities = (withIdentities?.identities ?? []).filter((id) => id.verified && id.status === 'active');
  return { identities, primaryEmail: withIdentities?.contact.primaryEmail ?? null };
}
