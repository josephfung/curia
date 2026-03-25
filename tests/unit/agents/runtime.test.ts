import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createAgentTask, type AgentResponseEvent } from '../../../src/bus/events.js';
import type { LLMProvider, ToolResult } from '../../../src/agents/llm/provider.js';
import type { ExecutionLayer } from '../../../src/skills/execution.js';
import { createLogger } from '../../../src/logger.js';
import { WorkingMemory } from '../../../src/memory/working-memory.js';

function createMockProvider(response: string): LLMProvider {
  return {
    id: 'mock',
    chat: vi.fn().mockResolvedValue({
      type: 'text' as const,
      content: response,
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
  };
}

describe('AgentRuntime', () => {
  let bus: EventBus;
  let responses: AgentResponseEvent[];

  beforeEach(() => {
    const logger = createLogger('error');
    bus = new EventBus(logger);
    responses = [];

    // Capture agent.response events published by the agent
    bus.subscribe('agent.response', 'dispatch', (event) => {
      responses.push(event as AgentResponseEvent);
    });
  });

  it('publishes agent.response when receiving agent.task', async () => {
    const provider = createMockProvider('Hello back!');
    const runtime = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a helpful assistant.',
      provider,
      bus,
      logger: createLogger('error'),
    });
    runtime.register();

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
      parentEventId: 'parent-1',
    });
    await bus.publish('dispatch', task);

    expect(responses).toHaveLength(1);
    expect(responses[0]?.payload.content).toBe('Hello back!');
    expect(responses[0]?.parentEventId).toBe(task.id);
    expect(provider.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hello' },
        ],
      }),
    );
  });

  it('publishes error response when LLM fails', async () => {
    const provider: LLMProvider = {
      id: 'mock',
      chat: vi.fn().mockResolvedValue({
        type: 'error' as const,
        error: 'API failed',
      }),
    };
    const runtime = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a helpful assistant.',
      provider,
      bus,
      logger: createLogger('error'),
    });
    runtime.register();

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
      parentEventId: 'parent-1',
    });
    await bus.publish('dispatch', task);

    expect(responses).toHaveLength(1);
    expect(responses[0]?.payload.content).toContain('unable to process');
  });

  it('includes conversation history in LLM context', async () => {
    const provider = createMockProvider('Response 2');
    const memory = WorkingMemory.createInMemory();

    // Seed conversation history
    await memory.addTurn('conv-1', 'coordinator', { role: 'user', content: 'First message' });
    await memory.addTurn('conv-1', 'coordinator', { role: 'assistant', content: 'First response' });

    const runtime = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are helpful.',
      provider,
      bus,
      logger: createLogger('error'),
      memory,
    });
    runtime.register();

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Second message',
      parentEventId: 'parent-1',
    });
    await bus.publish('dispatch', task);

    // LLM should receive system + history + new message
    expect(provider.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'First message' },
          { role: 'assistant', content: 'First response' },
          { role: 'user', content: 'Second message' },
        ],
      }),
    );
  });

  it('saves both user message and assistant response to memory', async () => {
    const provider = createMockProvider('Bot reply');
    const memory = WorkingMemory.createInMemory();

    const runtime = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are helpful.',
      provider,
      bus,
      logger: createLogger('error'),
      memory,
    });
    runtime.register();

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
      parentEventId: 'parent-1',
    });
    await bus.publish('dispatch', task);

    const history = await memory.getHistory('conv-1', 'coordinator');
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: 'user', content: 'Hello' });
    expect(history[1]).toEqual({ role: 'assistant', content: 'Bot reply' });
  });
});

// Helper: mock LLM that returns tool_use on first call, text on second
function createToolUseProvider(toolCallName: string, toolCallInput: Record<string, unknown>): LLMProvider {
  let callCount = 0;
  return {
    id: 'mock',
    chat: async ({ toolResults }: { toolResults?: ToolResult[] }) => {
      callCount++;
      if (callCount === 1) {
        return {
          type: 'tool_use' as const,
          toolCalls: [{ id: 'call-1', name: toolCallName, input: toolCallInput }],
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      }
      return {
        type: 'text' as const,
        content: `Tool result was processed. Call count: ${callCount}`,
        usage: { inputTokens: 200, outputTokens: 60 },
      };
    },
  };
}

describe('AgentRuntime tool-use loop', () => {
  it('invokes skill when LLM returns tool_use and feeds result back', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    const provider = createToolUseProvider('web-fetch', { url: 'https://example.com' });

    const mockExecution = {
      invoke: vi.fn().mockResolvedValue({ success: true, data: 'page content here' }),
    } as unknown as ExecutionLayer;

    const agent = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are an assistant.',
      provider,
      bus,
      logger,
      executionLayer: mockExecution,
      pinnedSkills: ['web-fetch'],
      skillToolDefs: [{ name: 'web-fetch', description: 'Fetch web page', input_schema: { type: 'object' as const, properties: { url: { type: 'string' } }, required: ['url'] } }],
    });
    agent.register();

    let responseContent = '';
    bus.subscribe('agent.response', 'dispatch', async (event) => {
      if (event.type === 'agent.response') {
        responseContent = event.payload.content;
      }
    });

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Fetch example.com',
      parentEventId: 'inbound-1',
    });
    await bus.publish('dispatch', task);

    expect(mockExecution.invoke).toHaveBeenCalledWith('web-fetch', { url: 'https://example.com' });
    expect(responseContent).toContain('Call count: 2');
  });

  it('handles skill failure gracefully in the tool loop', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    const provider = createToolUseProvider('web-fetch', { url: 'https://example.com' });

    const mockExecution = {
      invoke: vi.fn().mockResolvedValue({ success: false, error: 'connection refused' }),
    } as unknown as ExecutionLayer;

    const agent = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are an assistant.',
      provider,
      bus,
      logger,
      executionLayer: mockExecution,
      pinnedSkills: ['web-fetch'],
      skillToolDefs: [{ name: 'web-fetch', description: 'Fetch web page', input_schema: { type: 'object' as const, properties: { url: { type: 'string' } }, required: ['url'] } }],
    });
    agent.register();

    let responseContent = '';
    bus.subscribe('agent.response', 'dispatch', async (event) => {
      if (event.type === 'agent.response') {
        responseContent = event.payload.content;
      }
    });

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Fetch example.com',
      parentEventId: 'inbound-1',
    });
    await bus.publish('dispatch', task);

    expect(responseContent).toBeTruthy();
  });

  it('stops after MAX_TOOL_ITERATIONS to prevent infinite loops', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);

    const infiniteToolProvider: LLMProvider = {
      id: 'mock',
      chat: async () => ({
        type: 'tool_use' as const,
        toolCalls: [{ id: `call-${Date.now()}`, name: 'web-fetch', input: { url: 'https://example.com' } }],
        content: 'Still trying...',
        usage: { inputTokens: 50, outputTokens: 20 },
      }),
    };

    const mockExecution = {
      invoke: vi.fn().mockResolvedValue({ success: true, data: 'result' }),
    } as unknown as ExecutionLayer;

    const agent = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are an assistant.',
      provider: infiniteToolProvider,
      bus,
      logger,
      executionLayer: mockExecution,
      pinnedSkills: ['web-fetch'],
      skillToolDefs: [{ name: 'web-fetch', description: 'Fetch', input_schema: { type: 'object' as const, properties: {}, required: [] } }],
    });
    agent.register();

    let responseContent = '';
    bus.subscribe('agent.response', 'dispatch', async (event) => {
      if (event.type === 'agent.response') {
        responseContent = event.payload.content;
      }
    });

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-3',
      channelId: 'cli',
      senderId: 'user',
      content: 'Do something',
      parentEventId: 'inbound-3',
    });
    await bus.publish('dispatch', task);

    expect(mockExecution.invoke).toHaveBeenCalledTimes(10);
    expect(responseContent).toBeTruthy();
  });
});
