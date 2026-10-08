// Always-on context budget per agent (#1961, ADR-046).
//
// The coordinator prompt was cut to ~32KB in June (#957) and had grown back to 56KB
// by October, because each incident fix appended a paragraph and nothing pushed back.
// This test is the push-back: it fails when an agent's fixed per-call payload grows
// past its budget, and the failure names the placement rule a fix should follow.
//
// Two numbers per agent, both measured from the same assembly production uses
// (assembleAgent, src/startup/agent-assembly.ts) over the real agents/ and skills/:
//   - always-on prompt: the YAML system_prompt plus the pinned SKILL.md bodies,
//     estimated at 4 chars/token. Runtime blocks (identity, security, roster,
//     autonomy, time, contact details, turn budget) are code-owned and not counted.
//   - local tool-definition bytes: the JSON of every local tool definition the agent
//     is sent, including the discovery tools. MCP tools (google-workspace) are not
//     loaded here, so they are excluded; their list comes from the upstream server.
//
// To opt another agent in, add a row to AGENT_BUDGETS. Set each budget from the
// agent's measured numbers with small headroom, and raise one only in a PR that says
// why the addition could not go higher up the ladder in ADR-046.

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { discoverAgentManifests, loadAgentConfig, type AgentYamlConfig } from '../../../src/agents/loader.js';
import { AgentRegistry } from '../../../src/agents/agent-registry.js';
import type { LLMProvider } from '../../../src/agents/llm/provider.js';
import { ModelRegistry } from '../../../src/agents/llm/model-registry.js';
import { ModelRouter } from '../../../src/agents/llm/model-router.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createLogger } from '../../../src/logger.js';
import type { ExecutionLayer } from '../../../src/skills/execution.js';
import { discoverToolManifests } from '../../../src/skills/loader.js';
import { loadSkillsConfig } from '../../../src/skills/mcp-loader.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import { SkillRegistry } from '../../../src/skills/skill-registry.js';
import {
  discoverSkillManifests,
  loadSkillsFromDiscovery,
  registerSyntheticSingletonSkills,
} from '../../../src/skills/skill-loader.js';
import { assembleAgent, registerAgentRoster } from '../../../src/startup/agent-assembly.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const AGENTS_DIR = resolve(REPO_ROOT, 'agents');
const SKILLS_DIR = resolve(REPO_ROOT, 'skills');
const CONFIG_DIR = resolve(REPO_ROOT, 'config');
const ADR = 'docs/adr/046-agent-behavior-fix-placement.md';

/** Same ratio the epic (#1954) uses for its ≤ 4k-token target. */
const CHARS_PER_TOKEN = 4;

/** A UUID-length stand-in, so ${principal_contact_id} renders at production length. */
const PRINCIPAL_CONTACT_ID = '00000000-0000-4000-8000-000000000000';

interface AgentBudget {
  agent: string;
  /** YAML system_prompt + pinned SKILL.md bodies, in estimated tokens. */
  alwaysOnPromptTokens: number;
  /** JSON bytes of the local tool definitions (MCP excluded). */
  localToolDefinitionBytes: number;
  /**
   * Whether the agent may pin an MCP server. Its tools cannot be measured here (they
   * come from the upstream server), so an agent under budget must not pin one: the
   * coordinator activates google-workspace on demand instead (#2024). Default true.
   */
  allowMcpPins?: boolean;
}

// Coordinator, measured 2026-10-06 after #1958, #1959 and #1960: ~6,777 tokens
// (YAML 20,951 chars + SKILL.md 6,157) and 74,856 bytes over 66 local tools. After
// #2024 (google-workspace unpinned, its prompt section rewritten): YAML 20,532 chars.
// Prompt trim PR 1 (docs/wip/2026-10-06-coordinator-prompt-trim.md): YAML 18,561 chars,
// ~6,180 tokens with SKILL.md 6,157; 74,651 bytes over 65 local tools.
// Prompt trim PR 2 (one section each for voice and contact resolution): YAML 15,709
// chars (~3,927 tokens, under #1954's 4k target), ~5,467 tokens with SKILL.md.
// Prompt trim PR 3 (second person, positive phrasing, tighter direct-capability
// sections): YAML 12,560 chars, ~4,680 tokens with SKILL.md; 76,898 bytes over 66 local
// tools, after task-create's owner values moved into its description.
const AGENT_BUDGETS: AgentBudget[] = [
  { agent: 'coordinator', alwaysOnPromptTokens: 4_800, localToolDefinitionBytes: 77_000, allowMcpPins: false },
];

const noopHandler = { execute: async () => ({ success: true as const, data: {} }) };

/** The on-disk tool and skill catalog, every entry enabled. No handlers are imported. */
function loadCatalog(): { toolRegistry: ToolRegistry; skillRegistry: SkillRegistry } {
  const logger = createLogger('silent');
  // Production renders timestamp input descriptions in the configured zone; the
  // length differs by a few bytes per zone, so pin one.
  const toolRegistry = new ToolRegistry('America/Toronto');
  for (const disc of discoverToolManifests(SKILLS_DIR, logger)) {
    if (!disc.manifest) throw new Error(`tool '${disc.name}' has an invalid manifest: ${disc.error ?? 'unknown'}`);
    toolRegistry.register(disc.manifest, noopHandler);
  }
  const skillRegistry = new SkillRegistry();
  const skillDiscovery = discoverSkillManifests(SKILLS_DIR, logger);
  loadSkillsFromDiscovery(skillDiscovery, skillRegistry, logger, new Set(skillDiscovery.map(d => d.name)));
  registerSyntheticSingletonSkills(toolRegistry, skillRegistry, logger);
  return { toolRegistry, skillRegistry };
}

/** Every agent YAML on disk, so the specialist roster matches production. */
function loadAgentConfigs(): AgentYamlConfig[] {
  return discoverAgentManifests(AGENTS_DIR).flatMap(d => (d.config ? [d.config] : []));
}

/** MCP server names from config/skills.yaml. Their pins cannot resolve here. */
function mcpServerNames(): Set<string> {
  return new Set((loadSkillsConfig(CONFIG_DIR).servers ?? []).map(s => s.name));
}

interface Measurement {
  yamlChars: number;
  skillMdChars: number;
  alwaysOnPromptTokens: number;
  localToolDefinitionBytes: number;
  localToolCount: number;
  unresolvedPins: string[];
  allowDiscovery: boolean;
  localToolNames: string[];
}

function measure(agentName: string): Measurement {
  const logger = createLogger('silent');
  const { toolRegistry, skillRegistry } = loadCatalog();
  const configs = loadAgentConfigs();
  const agentConfig = loadAgentConfig(resolve(AGENTS_DIR, `${agentName}.yaml`));
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
  };
}

describe.each(AGENT_BUDGETS)('always-on context budget: $agent', (budget) => {
  const m = measure(budget.agent);
  const { yamlChars, skillMdChars, alwaysOnPromptTokens, localToolDefinitionBytes, localToolCount } = m;
  const detail = JSON.stringify({ yamlChars, skillMdChars, alwaysOnPromptTokens, localToolDefinitionBytes, localToolCount });

  it('measures the whole local pin set', () => {
    // A pin that silently failed to load would shrink both numbers and pass the
    // budget for the wrong reason. Only MCP servers may be absent here, and only for
    // an agent allowed to pin them.
    const mcp = budget.allowMcpPins === false ? new Set<string>() : mcpServerNames();
    expect(m.unresolvedPins.filter(p => !mcp.has(p))).toEqual([]);
    expect(m.localToolCount).toBeGreaterThan(0);
    // Discovery tools are not pins, so a missing one is only logged by assembleAgent.
    if (m.allowDiscovery) {
      expect(m.localToolNames).toEqual(expect.arrayContaining(['tool-registry', 'skill-activate']));
    }
  });

  it('always-on prompt (YAML system_prompt + pinned SKILL.md) is within budget', () => {
    expect(
      m.alwaysOnPromptTokens,
      `${budget.agent} always-on prompt is ~${m.alwaysOnPromptTokens} tokens, over its budget of ` +
      `${budget.alwaysOnPromptTokens} (${detail}). Before raising the budget, place the rule on the ` +
      `highest rung that works — code enforcement, injection with its trigger, tool description, ` +
      `lazy playbook — and only then the always-on prompt. See ${ADR}.`,
    ).toBeLessThanOrEqual(budget.alwaysOnPromptTokens);
  });

  it('local tool definitions are within budget', () => {
    expect(
      m.localToolDefinitionBytes,
      `${budget.agent} local tool definitions are ${m.localToolDefinitionBytes} bytes, over its budget of ` +
      `${budget.localToolDefinitionBytes} (${detail}). Every pinned tool's description and schema is sent ` +
      `on every call. Unpin tools the agent does not call, move rare procedures to a lazy playbook, and ` +
      `keep descriptions to how to call the tool. See ${ADR}.`,
    ).toBeLessThanOrEqual(budget.localToolDefinitionBytes);
  });
});
