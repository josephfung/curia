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

const logger = pino({ level: 'silent' });

describe('Multi-agent delegation integration', () => {
  it('Coordinator delegates to specialist and synthesizes response', async () => {
    // 1. Set up registries
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('coordinator', { role: 'coordinator', description: 'Main coordinator' });
    agentRegistry.register('research-analyst', { role: 'specialist', description: 'Research and analysis' });

    const skillRegistry = new SkillRegistry();
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
    skillRegistry.register(delegateManifest, new DelegateHandler());

    // 2. Set up bus and execution layer
    const bus = new EventBus(logger);
    const executionLayer = new ExecutionLayer(skillRegistry, logger, { bus, agentRegistry });

    // 3. Mock Coordinator LLM: first call delegates, second synthesizes
    let coordinatorCalls = 0;
    const coordinatorProvider: LLMProvider = {
      id: 'mock-coordinator',
      chat: async ({ messages }: { messages: Message[] }) => {
        coordinatorCalls++;
        if (coordinatorCalls === 1) {
          // Coordinator decides to delegate
          return {
            type: 'tool_use' as const,
            toolCalls: [{
              id: 'call-1',
              name: 'delegate',
              input: { agent: 'research-analyst', task: 'Research the latest AI trends', conversation_id: 'test-conv' },
            }],
            usage: { inputTokens: 100, outputTokens: 50 },
          };
        }
        // After getting delegation result, synthesize
        const hasToolResult = messages.some(m =>
          Array.isArray(m.content) && m.content.some((b: ContentBlock) => b.type === 'tool_result'),
        );
        return {
          type: 'text' as const,
          content: `Based on my research team's findings${hasToolResult ? ' (delegation successful)' : ''}: AI is advancing rapidly.`,
          usage: { inputTokens: 200, outputTokens: 60 },
        };
      },
    };

    // 4. Mock Specialist LLM: simple text response (track calls to verify delegation)
    let specialistCalls = 0;
    const specialistProvider: LLMProvider = {
      id: 'mock-specialist',
      chat: async () => {
        specialistCalls++;
        return {
          type: 'text' as const,
          content: 'Key AI trends: LLMs are becoming multimodal, agents are emerging as a paradigm.',
          usage: { inputTokens: 50, outputTokens: 30 },
        };
      },
    };

    // 5. Create both agent runtimes
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

    const specialist = new AgentRuntime({
      agentId: 'research-analyst',
      systemPrompt: 'You are a research analyst.',
      provider: specialistProvider,
      bus,
      logger,
    });
    specialist.register();

    // 6. Capture the final response
    let finalResponse = '';
    bus.subscribe('agent.response', 'system', async (event) => {
      if (event.type === 'agent.response' && event.payload.agentId === 'coordinator') {
        finalResponse = event.payload.content;
      }
    });

    // 7. Send a task to the coordinator
    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'test-conv',
      channelId: 'test',
      senderId: 'test-user',
      content: 'What are the latest AI trends?',
      parentEventId: 'test-inbound-1',
    });
    await bus.publish('dispatch', task);

    // 8. Verify the full delegation loop
    expect(coordinatorCalls).toBe(2);
    expect(specialistCalls).toBe(1); // Specialist was actually called
    expect(finalResponse).toContain('delegation successful');
  });
});
