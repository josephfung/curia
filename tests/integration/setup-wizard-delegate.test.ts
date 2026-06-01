// tests/integration/setup-wizard-delegate.test.ts
//
// Verifies coordinator routing decisions for setup-wizard delegation.
// Uses mock LLM providers — no real Postgres or Anthropic API required.

import { describe, it, expect } from 'vitest';
import { EventBus } from '../../src/bus/bus.js';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { AgentRegistry } from '../../src/agents/agent-registry.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import { ExecutionLayer } from '../../src/skills/execution.js';
import { DelegateHandler } from '../../skills/delegate/handler.js';
import type { LLMProvider, Message, ContentBlock } from '../../src/agents/llm/provider.js';
import type { SkillManifest } from '../../src/skills/types.js';
import { createAgentTask } from '../../src/bus/events.js';
import pino from 'pino';

const MOCK_PROVENANCE = { requestedModel: 'mock-model', actualModel: 'mock-model', providerRequestId: 'msg_mock_000' } as const;
const logger = pino({ level: 'silent' });

const KICKOFF_TEXT = 'Just finished setup — say hi!';

// Shared delegate skill manifest — same shape as the reference test.
const delegateManifest: SkillManifest = {
  name: 'delegate',
  description: 'Delegate a task to a specialist agent',
  version: '1.0.0',
  sensitivity: 'normal',
  action_risk: 'none',
  capabilities: ['bus', 'agentRegistry'],
  inputs: { agent: 'string', task: 'string', conversation_id: 'string?' },
  outputs: { response: 'string', agent: 'string' },
  permissions: [],
  secrets: [],
  timeout: 120000,
};

function makeSetup() {
  const agentRegistry = new AgentRegistry();
  agentRegistry.register('coordinator', { role: 'coordinator', description: 'Main coordinator' });
  agentRegistry.register('setup-wizard', { role: 'specialist', description: 'Onboarding setup wizard' });

  const skillRegistry = new SkillRegistry();
  skillRegistry.register(delegateManifest, new DelegateHandler());

  const bus = new EventBus(logger);
  const executionLayer = new ExecutionLayer(skillRegistry, logger, { bus, agentRegistry });

  return { agentRegistry, skillRegistry, bus, executionLayer };
}

describe('setup-wizard delegation', () => {
  it('coordinator delegates to setup-wizard for the onboarding kickoff message', async () => {
    const { skillRegistry, bus, executionLayer } = makeSetup();

    // setup-wizard provider: tracks calls to verify the specialist was actually invoked.
    let specialistCalls = 0;
    const setupWizardProvider: LLMProvider = {
      id: 'mock-setup-wizard',
      chat: async () => {
        specialistCalls++;
        return {
          type: 'text' as const,
          content: 'Welcome! I am here to guide you through onboarding.',
          usage: { inputTokens: 50, outputTokens: 30, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          provenance: MOCK_PROVENANCE,
        };
      },
    };

    // Coordinator provider: first call → delegate to setup-wizard; second call → synthesize.
    let coordinatorCalls = 0;
    const coordinatorProvider: LLMProvider = {
      id: 'mock-coordinator',
      chat: async ({ messages }: { messages: Message[] }) => {
        coordinatorCalls++;
        if (coordinatorCalls === 1) {
          // Delegate to setup-wizard on the kickoff message
          return {
            type: 'tool_use' as const,
            toolCalls: [{
              id: 'call-sw-1',
              name: 'delegate',
              input: { agent: 'setup-wizard', task: KICKOFF_TEXT, conversation_id: 'test-conv-kickoff' },
            }],
            usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
            provenance: MOCK_PROVENANCE,
          };
        }
        // After receiving the delegation result, synthesize a final response.
        const hasToolResult = messages.some(m =>
          Array.isArray(m.content) && m.content.some((b: ContentBlock) => b.type === 'tool_result'),
        );
        return {
          type: 'text' as const,
          content: `Setup wizard says hello${hasToolResult ? ' (delegation successful)' : ''}.`,
          usage: { inputTokens: 200, outputTokens: 60, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          provenance: MOCK_PROVENANCE,
        };
      },
    };

    const toolDefs = skillRegistry.toToolDefinitions(['delegate']);

    const coordinator = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a coordinator.',
      provider: coordinatorProvider,
      bus,
      logger,
      executionLayer,
      pinnedSkills: ['delegate'],
      skillToolDefs: toolDefs,
    });
    coordinator.register();

    const setupWizard = new AgentRuntime({
      agentId: 'setup-wizard',
      systemPrompt: 'You are a setup wizard.',
      provider: setupWizardProvider,
      bus,
      logger,
    });
    setupWizard.register();

    // Capture the coordinator's final response.
    let finalResponse = '';
    bus.subscribe('agent.response', 'system', async (event) => {
      if (event.type === 'agent.response' && event.payload.agentId === 'coordinator') {
        finalResponse = event.payload.content;
      }
    });

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'test-conv-kickoff',
      channelId: 'test',
      senderId: 'test-user',
      content: KICKOFF_TEXT,
      parentEventId: 'test-inbound-kickoff',
    });
    await bus.publish('dispatch', task);

    // Coordinator should have been called twice (delegate → synthesize).
    expect(coordinatorCalls).toBe(2);
    // setup-wizard should have been invoked exactly once.
    expect(specialistCalls).toBe(1);
    // Final response should reflect the delegation round-trip.
    expect(finalResponse).toContain('delegation successful');
  });

  it('coordinator does NOT delegate to setup-wizard for a normal greeting', async () => {
    const { skillRegistry, bus, executionLayer } = makeSetup();

    // setup-wizard provider: if called, increment counter to detect erroneous delegation.
    let specialistCalls = 0;
    const setupWizardProvider: LLMProvider = {
      id: 'mock-setup-wizard',
      chat: async () => {
        specialistCalls++;
        return {
          type: 'text' as const,
          content: 'Specialist unexpectedly invoked.',
          usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          provenance: MOCK_PROVENANCE,
        };
      },
    };

    // Coordinator provider: responds to 'Hello' directly — no tool calls.
    const coordinatorProvider: LLMProvider = {
      id: 'mock-coordinator',
      chat: async () => {
        return {
          type: 'text' as const,
          content: 'Hello! How can I help you today?',
          usage: { inputTokens: 50, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          provenance: MOCK_PROVENANCE,
        };
      },
    };

    const toolDefs = skillRegistry.toToolDefinitions(['delegate']);

    const coordinator = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a coordinator.',
      provider: coordinatorProvider,
      bus,
      logger,
      executionLayer,
      pinnedSkills: ['delegate'],
      skillToolDefs: toolDefs,
    });
    coordinator.register();

    const setupWizard = new AgentRuntime({
      agentId: 'setup-wizard',
      systemPrompt: 'You are a setup wizard.',
      provider: setupWizardProvider,
      bus,
      logger,
    });
    setupWizard.register();

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'test-conv-greeting',
      channelId: 'test',
      senderId: 'test-user',
      content: 'Hello',
      parentEventId: 'test-inbound-greeting',
    });
    await bus.publish('dispatch', task);

    // setup-wizard must not have been invoked for a normal greeting.
    expect(specialistCalls).toBe(0);
  });
});
