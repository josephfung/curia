// Agent assembly (#1966): the one path from agent YAML to AgentRuntime config,
// shared by src/index.ts, the test-mode stack and the render script.
//
// The key test is "rendered string equals what the runtime sends": it drives a real
// AgentRuntime with the builder's runtimeConfig and compares the system message the
// provider receives against buildBaseSystemPrompt(runtimeConfig). If someone adds a
// block to the runtime without going through system-prompt.ts, it fails.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import { AgentRegistry } from '../../../src/agents/agent-registry.js';
import type { AgentYamlConfig } from '../../../src/agents/loader.js';
import type { LLMProvider } from '../../../src/agents/llm/provider.js';
import { ModelRegistry } from '../../../src/agents/llm/model-registry.js';
import { ModelRouter } from '../../../src/agents/llm/model-router.js';
import { buildBaseSystemPrompt, formatTaskTailBlocks } from '../../../src/agents/system-prompt.js';
import { DATE_RESOLVE_GUARDRAIL } from '../../../src/agents/prompts/date-resolve-guardrail.js';
import type { AutonomyService } from '../../../src/autonomy/autonomy-service.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createAgentTask } from '../../../src/bus/events.js';
import type { ChannelIdentity } from '../../../src/contacts/types.js';
import type { OfficeIdentityService } from '../../../src/identity/service.js';
import { createLogger } from '../../../src/logger.js';
import type { ExecutionLayer } from '../../../src/skills/execution.js';
import { ToolRegistry } from '../../../src/skills/registry.js';
import { SkillRegistry } from '../../../src/skills/skill-registry.js';
import type { ToolManifest } from '../../../src/skills/types.js';
import {
  AgentAssemblyError,
  assembleAgent,
  assembleAgents,
  registerAgentRoster,
  resolveAgentModelBinding,
  type AgentAssemblyContext,
} from '../../../src/startup/agent-assembly.js';

const AGENT_CONTACT_ID = '11111111-1111-4111-8111-111111111111';
const PRINCIPAL_CONTACT_ID = '22222222-2222-4222-8222-222222222222';
const FIXED_NOW = new Date('2026-10-01T14:30:00Z');

const MOCK_PROVENANCE = {
  requestedModel: 'claude-sonnet-4-6',
  actualModel: 'claude-sonnet-4-6',
  providerRequestId: 'msg_mock',
} as const;

function toolManifest(name: string): ToolManifest {
  return {
    name,
    description: name,
    version: '0.1.0',
    action_risk: 'none',
    sensitivity: 'normal',
    permissions: [],
    secrets: [],
    timeout: 30000,
    inputs: {},
    outputs: {},
  };
}

const noopHandler = { execute: async () => ({ success: true as const, data: {} }) };

function coordinatorYaml(overrides: Partial<AgentYamlConfig> = {}): AgentYamlConfig {
  return {
    name: 'coordinator',
    role: 'coordinator',
    description: 'Routes work',
    model: { tier: 'standard' },
    system_prompt: 'You are the coordinator. Principal: ${principal_contact_id}.',
    pinned_skills: ['notes'],
    allow_discovery: true,
    ...overrides,
  };
}

function specialistYaml(overrides: Partial<AgentYamlConfig> = {}): AgentYamlConfig {
  return {
    name: 'researcher',
    description: 'Looks things up',
    model: { tier: 'fast' },
    system_prompt: 'Me: ${agent_contact_id}. Principal: ${principal_contact_id}. Team: ${available_specialists}',
    pinned_skills: ['lookup'],
    ...overrides,
  };
}

function principalIdentity(): ChannelIdentity {
  return {
    id: 'ident-1',
    contactId: PRINCIPAL_CONTACT_ID,
    channel: 'email',
    channelIdentifier: 'principal@example.com',
    label: null,
    verified: true,
    status: 'active',
  } as unknown as ChannelIdentity;
}

function textProvider(): LLMProvider & { chat: ReturnType<typeof vi.fn> } {
  return {
    id: 'anthropic',
    chat: vi.fn(async () => ({
      type: 'text' as const,
      content: 'OK',
      usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      provenance: MOCK_PROVENANCE,
    })),
  };
}

function buildContext(provider: LLMProvider, configs: AgentYamlConfig[]): AgentAssemblyContext {
  const logger = createLogger('error');
  const bus = new EventBus(logger);
  const toolRegistry = new ToolRegistry();
  for (const name of ['notes-add', 'lookup-run', 'tool-registry', 'skill-activate']) {
    toolRegistry.register(toolManifest(name), noopHandler);
  }
  const skillRegistry = new SkillRegistry();
  skillRegistry.register(
    { name: 'notes', description: 'notes', tools: ['notes-add'], instructions: 'NOTES SKILL BODY' },
    '/fixture/notes',
  );
  skillRegistry.register(
    { name: 'lookup', description: 'lookup', tools: ['lookup-run'], instructions: 'LOOKUP SKILL BODY' },
    '/fixture/lookup',
  );
  const agentRegistry = new AgentRegistry();
  registerAgentRoster(agentRegistry, configs);

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

  const executionLayer = {
    invoke: vi.fn(),
    getToolDefinitions: vi.fn(() => []),
  } as unknown as ExecutionLayer;

  return {
    logger,
    bus,
    toolRegistry,
    skillRegistry,
    agentRegistry,
    models: { modelRouter, modelRegistry, providerRegistry: new Map([['anthropic', provider]]) },
    executionLayer,
    autonomyService: {
      getConfig: async () => ({ score: 75, band: 'spot-check', updatedAt: FIXED_NOW, updatedBy: 'test' }),
    } as unknown as AutonomyService,
    officeIdentityService: {
      compileSystemPromptBlock: () => '## Identity\nYou are Curia.',
    } as unknown as OfficeIdentityService,
    securityContextBlock: '## Security\nPolicy here.',
    timezone: 'America/Toronto',
    channelAccounts: { email: 'curia@example.com', phone: '+15550001111' },
    selfEmails: ['curia@example.com'],
    principalIdentities: [principalIdentity()],
    principalPrimaryEmail: { current: 'principal@example.com' },
    agentContactId: AGENT_CONTACT_ID,
    principalContactId: PRINCIPAL_CONTACT_ID,
    lateDelivery: { ttlMinutes: 60, sweepIntervalMinutes: 5 },
  };
}

describe('registerAgentRoster', () => {
  it('registers every agent with its role, description and duration hint', () => {
    const registry = new AgentRegistry();
    registerAgentRoster(registry, [
      coordinatorYaml(),
      specialistYaml({ expected_duration_seconds: 90, display_name: 'Research' }),
    ]);
    expect(registry.get('coordinator')?.role).toBe('coordinator');
    expect(registry.get('researcher')).toMatchObject({
      role: 'specialist',
      description: 'Looks things up',
      displayName: 'Research',
      expectedDurationSeconds: 90,
    });
  });
});

describe('assembleAgent', () => {
  it('gives the coordinator its SKILL.md bodies, discovery tools and coordinator-only blocks', () => {
    const configs = [coordinatorYaml(), specialistYaml()];
    const ctx = buildContext(textProvider(), configs);
    const coordinator = assembleAgent(configs[0]!, ctx);

    expect(coordinator.systemPrompt).toContain(`Principal: ${PRINCIPAL_CONTACT_ID}.`);
    expect(coordinator.systemPrompt).toContain('NOTES SKILL BODY');
    expect(coordinator.pinnedToolNames).toEqual(['notes-add']);
    expect(coordinator.toolDefs.map(t => t.name)).toEqual(['notes-add', 'tool-registry', 'skill-activate']);

    const rc = coordinator.runtimeConfig;
    expect(rc.officeIdentityService).toBe(ctx.officeIdentityService);
    expect(rc.securityContextBlock).toBe('## Security\nPolicy here.');
    expect(rc.autonomyService).toBe(ctx.autonomyService);
    expect(rc.agentContactId).toBe(AGENT_CONTACT_ID);
    expect(rc.availableSpecialists).toContain('researcher');
    expect(rc.resolvedModel).toBe('claude-sonnet-4-6');
    expect(rc.fallbackModel).toBe('claude-opus-4-6');
    // Shared hot-reload array, by reference (#1514).
    expect(rc.principalIdentities).toBe(ctx.principalIdentities);
  });

  it('withholds coordinator-only blocks from specialists and resolves their placeholders', () => {
    const configs = [coordinatorYaml(), specialistYaml({ inject_specialists: true })];
    const ctx = buildContext(textProvider(), configs);
    const specialist = assembleAgent(configs[1]!, ctx);

    expect(specialist.systemPrompt).toContain(`Me: ${AGENT_CONTACT_ID}.`);
    expect(specialist.systemPrompt).toContain(`Principal: ${PRINCIPAL_CONTACT_ID}.`);
    expect(specialist.systemPrompt).toContain('researcher');
    expect(specialist.systemPrompt).toContain('LOOKUP SKILL BODY');

    const rc = specialist.runtimeConfig;
    expect(rc.officeIdentityService).toBeUndefined();
    expect(rc.securityContextBlock).toBeUndefined();
    expect(rc.autonomyService).toBeUndefined();
    expect(rc.availableSpecialists).toBeUndefined();
    expect(rc.agentContactId).toBeUndefined();
    expect(rc.resolvedModel).toBe('claude-haiku-4-5');
    // Every agent still gets time, own and principal contact details.
    expect(rc.timezone).toBe('America/Toronto');
    expect(rc.channelAccounts).toEqual({ email: 'curia@example.com', phone: '+15550001111' });
    expect(rc.principalIdentities).toHaveLength(1);
  });

  it('maps error_budget from YAML snake_case', () => {
    const configs = [coordinatorYaml({ error_budget: { max_turns: 7 } })];
    const ctx = buildContext(textProvider(), configs);
    const [coordinator] = assembleAgents(configs, ctx);
    expect(coordinator!.runtimeConfig.errorBudget?.maxTurns).toBe(7);
  });
});

describe('resolveAgentModelBinding', () => {
  it('throws AgentAssemblyError naming the agent when the provider is not registered', () => {
    const configs = [coordinatorYaml()];
    const ctx = buildContext(textProvider(), configs);
    const models = { ...ctx.models, providerRegistry: new Map<string, LLMProvider>() };
    expect(() => resolveAgentModelBinding(configs[0]!, models)).toThrow(AgentAssemblyError);
    try {
      resolveAgentModelBinding(configs[0]!, models);
    } catch (err) {
      expect((err as AgentAssemblyError).agentName).toBe('coordinator');
      expect((err as AgentAssemblyError).details).toMatchObject({ provider: 'anthropic' });
    }
  });
});

describe('rendered coordinator system string', () => {
  beforeEach(() => {
    // Freeze the clock so the runtime's per-turn time block and the render match.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('equals the system message AgentRuntime sends for a principal chat turn', async () => {
    const provider = textProvider();
    const configs = [coordinatorYaml(), specialistYaml()];
    const ctx = buildContext(provider, configs);
    const coordinator = assembleAgent(configs[0]!, ctx);

    const rendered = await buildBaseSystemPrompt(coordinator.runtimeConfig, { now: FIXED_NOW, logger: ctx.logger })
      + formatTaskTailBlocks({ channelId: 'cli', conversationId: 'conv-fixture', hasToolAllowlist: false });

    ctx.bus.subscribe('agent.response', 'dispatch', () => {});
    new AgentRuntime(coordinator.runtimeConfig).register();
    await ctx.bus.publish('dispatch', createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-fixture',
      channelId: 'cli',
      senderId: 'principal',
      content: 'What is on my plate today?',
      parentEventId: 'parent-fixture',
    }));

    expect(provider.chat).toHaveBeenCalled();
    const sent = provider.chat.mock.calls[0]![0].messages[0]!;
    expect(sent.role).toBe('system');
    expect(sent.content).toBe(rendered);

    // And it carries every block production sends, in order.
    const order = [
      '## Identity',
      '## Security',
      'You are the coordinator.',
      'NOTES SKILL BODY',
      '## Available Specialists',
      'Spot', // autonomy band label
      DATE_RESOLVE_GUARDRAIL.split('\n')[0]!,
      '## Your Contact Details',
      '## Principal Contact Details',
    ];
    let cursor = -1;
    for (const marker of order) {
      const at = rendered.indexOf(marker);
      expect(at, `missing or out of order: ${marker}`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });
});

describe('buildBaseSystemPrompt block failures', () => {
  const sources = {
    agentId: 'coordinator',
    systemPrompt: 'Body.',
    officeIdentityService: {
      compileSystemPromptBlock: () => { throw new Error('identity table unreadable'); },
    } as unknown as OfficeIdentityService,
  };
  const logger = createLogger('silent');

  it('omits the failed block on a live turn', async () => {
    const prompt = await buildBaseSystemPrompt(sources, { now: FIXED_NOW, logger });
    expect(prompt.startsWith('Body.')).toBe(true);
  });

  it('throws for a render, so a partial prompt is never printed', async () => {
    await expect(buildBaseSystemPrompt(sources, { now: FIXED_NOW, logger, onBlockError: 'throw' }))
      .rejects.toThrow(/block 'identity' failed for agent 'coordinator'/);
  });
});
