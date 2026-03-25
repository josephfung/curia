import { describe, it, expect } from 'vitest';
import { EventBus } from '../../src/bus/bus.js';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { SkillRegistry } from '../../src/skills/registry.js';
import { ExecutionLayer } from '../../src/skills/execution.js';
import type { LLMProvider, ToolResult } from '../../src/agents/llm/provider.js';
import type { SkillManifest, SkillHandler, SkillContext } from '../../src/skills/types.js';
import { createAgentTask } from '../../src/bus/events.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

/**
 * Integration test: full path from inbound task → LLM tool_use → skill execution → response.
 * Uses a mock LLM provider to simulate tool-use behavior without API calls.
 */
describe('Skill invocation integration', () => {
  it('completes the full tool-use loop: task → LLM → skill → result → response', async () => {
    // 1. Set up the skill registry with a simple test skill
    const registry = new SkillRegistry();
    const manifest: SkillManifest = {
      name: 'echo',
      description: 'Echoes input back as output',
      version: '1.0.0',
      sensitivity: 'normal',
      inputs: { message: 'string' },
      outputs: { echo: 'string' },
      permissions: [],
      secrets: [],
      timeout: 5000,
    };
    const echoHandler: SkillHandler = {
      execute: async (ctx: SkillContext) => ({
        success: true,
        data: `Echo: ${ctx.input.message}`,
      }),
    };
    registry.register(manifest, echoHandler);

    // 2. Set up the execution layer
    const executionLayer = new ExecutionLayer(registry, logger);

    // 3. Mock LLM provider: first call returns tool_use, second returns text
    let llmCallCount = 0;
    const mockProvider: LLMProvider = {
      id: 'mock',
      chat: async ({ toolResults }: { toolResults?: ToolResult[] }) => {
        llmCallCount++;
        if (llmCallCount === 1) {
          return {
            type: 'tool_use' as const,
            toolCalls: [{ id: 'call-1', name: 'echo', input: { message: 'Hello from integration test' } }],
            usage: { inputTokens: 50, outputTokens: 20 },
          };
        }
        return {
          type: 'text' as const,
          content: `The echo skill responded. Tool results were provided: ${toolResults ? 'yes' : 'no'}`,
          usage: { inputTokens: 100, outputTokens: 30 },
        };
      },
    };

    // 4. Set up the bus and agent
    const bus = new EventBus(logger);
    const toolDefs = registry.toToolDefinitions(['echo']);

    const agent = new AgentRuntime({
      agentId: 'test-agent',
      systemPrompt: 'You are a test agent.',
      provider: mockProvider,
      bus,
      logger,
      executionLayer,
      pinnedSkills: ['echo'],
      skillToolDefs: toolDefs,
    });
    agent.register();

    // 5. Capture the final response
    let finalResponse = '';
    bus.subscribe('agent.response', 'system', async (event) => {
      if (event.type === 'agent.response') {
        finalResponse = event.payload.content;
      }
    });

    // 6. Publish a task
    const task = createAgentTask({
      agentId: 'test-agent',
      conversationId: 'integration-conv-1',
      channelId: 'test',
      senderId: 'test-user',
      content: 'Please echo something',
      parentEventId: 'test-inbound-1',
    });
    await bus.publish('dispatch', task);

    // 7. Verify the full loop completed
    expect(llmCallCount).toBe(2);
    expect(finalResponse).toContain('Tool results were provided: yes');
  });

  it('handles skill failure in the loop gracefully', async () => {
    const registry = new SkillRegistry();
    const manifest: SkillManifest = {
      name: 'fail-skill',
      description: 'Always fails',
      version: '1.0.0',
      sensitivity: 'normal',
      inputs: {},
      outputs: {},
      permissions: [],
      secrets: [],
      timeout: 5000,
    };
    registry.register(manifest, {
      execute: async () => ({ success: false, error: 'intentional failure' }),
    });

    const executionLayer = new ExecutionLayer(registry, logger);
    const bus = new EventBus(logger);
    const toolDefs = registry.toToolDefinitions(['fail-skill']);

    let llmCallCount = 0;
    const mockProvider: LLMProvider = {
      id: 'mock',
      chat: async ({ toolResults }: { toolResults?: ToolResult[] }) => {
        llmCallCount++;
        if (llmCallCount === 1) {
          return {
            type: 'tool_use' as const,
            toolCalls: [{ id: 'call-1', name: 'fail-skill', input: {} }],
            usage: { inputTokens: 50, outputTokens: 20 },
          };
        }
        const errorInfo = toolResults?.[0]?.is_error ? 'got error' : 'no error';
        return {
          type: 'text' as const,
          content: `Handled the failure: ${errorInfo}`,
          usage: { inputTokens: 100, outputTokens: 30 },
        };
      },
    };

    const agent = new AgentRuntime({
      agentId: 'test-agent',
      systemPrompt: 'You are a test agent.',
      provider: mockProvider,
      bus,
      logger,
      executionLayer,
      pinnedSkills: ['fail-skill'],
      skillToolDefs: toolDefs,
    });
    agent.register();

    let finalResponse = '';
    bus.subscribe('agent.response', 'system', async (event) => {
      if (event.type === 'agent.response') {
        finalResponse = event.payload.content;
      }
    });

    const task = createAgentTask({
      agentId: 'test-agent',
      conversationId: 'integration-conv-2',
      channelId: 'test',
      senderId: 'test-user',
      content: 'Try the failing skill',
      parentEventId: 'test-inbound-2',
    });
    await bus.publish('dispatch', task);

    expect(finalResponse).toContain('got error');
  });
});
