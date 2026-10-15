// src/agents/prompt-budget.ts — measure an agent's fixed per-call context (#1961, ADR-046).
//
// tests/unit/agents/prompt-budget.test.ts holds core's agents to their budgets with this.
// A deployment holds its own agents to theirs with the same function, run inside its
// image against the merged core + custom tree (curia-deploy#276), so the numbers are the
// ones production assembles. Nothing here runs at boot.
//
// Two numbers per agent, both from the assembly production uses (assembleAgent,
// src/startup/agent-assembly.ts):
//   - always-on prompt: the YAML system_prompt plus the pinned SKILL.md bodies,
//     estimated at 4 chars/token. Runtime blocks (identity, security, roster,
//     autonomy, time, contact details, turn budget) are code-owned and not counted.
//   - local tool-definition bytes: the JSON of every local tool definition the agent
//     is sent, including the discovery tools. MCP tools are not loaded here, so they are
//     excluded; their list comes from the upstream server.
import { resolve } from 'node:path';
import type { ExecutionLayer } from '../skills/execution.js';
import { discoverToolManifests } from '../skills/loader.js';
import { loadSkillsConfig } from '../skills/mcp-loader.js';
import { ToolRegistry } from '../skills/registry.js';
import { SkillRegistry } from '../skills/skill-registry.js';
import {
  discoverSkillManifests,
  loadSkillsFromDiscovery,
  registerSyntheticSingletonSkills,
} from '../skills/skill-loader.js';
import { assembleAgent, registerAgentRoster } from '../startup/agent-assembly.js';
import { EventBus } from '../bus/bus.js';
import { createLogger } from '../logger.js';
import { AgentRegistry } from './agent-registry.js';
import type { LLMProvider } from './llm/provider.js';
import { ModelRegistry } from './llm/model-registry.js';
import { ModelRouter } from './llm/model-router.js';
import { discoverAgentManifests, loadAgentConfig, type AgentYamlConfig } from './loader.js';

/** Same ratio the epic (#1954) uses for its ≤ 4k-token target. */
export const CHARS_PER_TOKEN = 4;

/** A UUID-length stand-in, so ${principal_contact_id} renders at production length. */
const PRINCIPAL_CONTACT_ID = '00000000-0000-4000-8000-000000000000';

/** Where the agents, skills and config come from: a checkout, or a deployment image's merged tree. */
export interface AgentSources {
  agentsDir: string;
  skillsDir: string;
  configDir: string;
}

export interface AgentContextMeasurement {
  yamlChars: number;
  skillMdChars: number;
  alwaysOnPromptTokens: number;
  localToolDefinitionBytes: number;
  localToolCount: number;
  /** Pins that resolved to nothing (an MCP server's pins always do here). */
  unresolvedPins: string[];
  allowDiscovery: boolean;
  localToolNames: string[];
  /** The `## Available Specialists` roster this agent is given, in chars (0 when it gets none). */
  rosterChars: number;
}

const noopHandler = { execute: async () => ({ success: true as const, data: {} }) };

/** The on-disk tool and skill catalog, every entry enabled. No handlers are imported. */
function loadCatalog(skillsDir: string): { toolRegistry: ToolRegistry; skillRegistry: SkillRegistry } {
  const logger = createLogger('silent');
  // Production renders timestamp input descriptions in the configured zone; the
  // length differs by a few bytes per zone, so pin one.
  const toolRegistry = new ToolRegistry('America/Toronto');
  for (const disc of discoverToolManifests(skillsDir, logger)) {
    if (!disc.manifest) throw new Error(`tool '${disc.name}' has an invalid manifest: ${disc.error ?? 'unknown'}`);
    toolRegistry.register(disc.manifest, noopHandler);
  }
  const skillRegistry = new SkillRegistry();
  const skillDiscovery = discoverSkillManifests(skillsDir, logger);
  loadSkillsFromDiscovery(skillDiscovery, skillRegistry, logger, new Set(skillDiscovery.map(d => d.name)));
  registerSyntheticSingletonSkills(toolRegistry, skillRegistry, logger);
  return { toolRegistry, skillRegistry };
}

/** MCP server names from the config dir's skills.yaml. Their pins cannot resolve here. */
export function mcpServerNames(configDir: string): Set<string> {
  return new Set((loadSkillsConfig(configDir).servers ?? []).map(s => s.name));
}

/** Measure one agent, with the roster built from every agent YAML in `agentsDir`. */
export function measureAgentContext(agentName: string, sources: AgentSources): AgentContextMeasurement {
  const logger = createLogger('silent');
  const { toolRegistry, skillRegistry } = loadCatalog(sources.skillsDir);
  const configs: AgentYamlConfig[] = discoverAgentManifests(sources.agentsDir).flatMap(d => (d.config ? [d.config] : []));
  const agentConfig = loadAgentConfig(resolve(sources.agentsDir, `${agentName}.yaml`));
  const agentRegistry = new AgentRegistry();
  registerAgentRoster(agentRegistry, configs);

  // Model binding is required by assembleAgent but irrelevant to size: any tier
  // resolves to a model the stub provider serves.
  const modelRegistry = new ModelRegistry(logger);
  const modelRouter = new ModelRouter(
    {
      tiers: {
        fast: { model: 'claude-haiku-4-5' },
        standard: { model: 'claude-sonnet-4-6' },
        powerful: { model: 'claude-opus-4-6' },
      },
      default_tier: 'standard',
    },
    modelRegistry,
    logger,
  );
  const provider = { id: 'anthropic', chat: async () => { throw new Error('not called'); } } as unknown as LLMProvider;

  const assembled = assembleAgent(agentConfig, {
    logger,
    bus: new EventBus(logger),
    toolRegistry,
    skillRegistry,
    agentRegistry,
    models: { modelRouter, modelRegistry, providerRegistry: new Map([['anthropic', provider]]) },
    executionLayer: {} as ExecutionLayer,
    timezone: 'America/Toronto',
    channelAccounts: {},
    selfEmails: [],
    principalIdentities: [],
    principalPrimaryEmail: { current: null },
    principalContactId: PRINCIPAL_CONTACT_ID,
    lateDelivery: { ttlMinutes: 60, sweepIntervalMinutes: 5 },
  });

  const yamlChars = agentConfig.system_prompt.length;
  const alwaysOnChars = assembled.systemPrompt.length;
  return {
    yamlChars,
    skillMdChars: alwaysOnChars - yamlChars,
    alwaysOnPromptTokens: Math.ceil(alwaysOnChars / CHARS_PER_TOKEN),
    localToolDefinitionBytes: assembled.toolDefs.reduce(
      (sum, def) => sum + Buffer.byteLength(JSON.stringify(def), 'utf8'),
      0,
    ),
    localToolCount: assembled.toolDefs.length,
    unresolvedPins: assembled.pinResolution.unresolvedPins.map(p => p.pin),
    allowDiscovery: agentConfig.allow_discovery === true,
    localToolNames: assembled.toolDefs.map(d => d.name),
    rosterChars: assembled.runtimeConfig.availableSpecialists?.length ?? 0,
  };
}
