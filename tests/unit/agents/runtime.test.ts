import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createAgentTask, type AgentResponseEvent, type AgentErrorEvent } from '../../../src/bus/events.js';
import type { LLMProvider, ToolResult } from '../../../src/agents/llm/provider.js';
import type { ExecutionLayer } from '../../../src/skills/execution.js';
import { createLogger } from '../../../src/logger.js';
import { WorkingMemory } from '../../../src/memory/working-memory.js';
import type { AgentError } from '../../../src/errors/types.js';

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
    const nonRetryableError: AgentError = {
      type: 'AUTH_FAILURE',
      source: 'anthropic',
      message: 'API failed',
      retryable: false,
      context: {},
      timestamp: new Date(),
    };
    const provider: LLMProvider = {
      id: 'mock',
      chat: vi.fn().mockResolvedValue({
        type: 'error' as const,
        error: nonRetryableError,
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
    chat: async ({ toolResults: _toolResults }: { toolResults?: ToolResult[] }) => {
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

    // caller is undefined because the task payload has no senderContext
    expect(mockExecution.invoke).toHaveBeenCalledWith('web-fetch', { url: 'https://example.com' }, undefined);
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

  it('stops after budget maxTurns is exceeded to prevent infinite loops', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);

    let callId = 0;
    const infiniteToolProvider: LLMProvider = {
      id: 'mock',
      chat: async () => ({
        type: 'tool_use' as const,
        toolCalls: [{ id: `call-${callId++}`, name: 'web-fetch', input: { url: 'https://example.com' } }],
        content: 'Still trying...',
        usage: { inputTokens: 50, outputTokens: 20 },
      }),
    };

    const mockExecution = {
      invoke: vi.fn().mockResolvedValue({ success: true, data: 'result' }),
    } as unknown as ExecutionLayer;

    // Use a small budget to keep the test fast
    const agent = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are an assistant.',
      provider: infiniteToolProvider,
      bus,
      logger,
      executionLayer: mockExecution,
      pinnedSkills: ['web-fetch'],
      skillToolDefs: [{ name: 'web-fetch', description: 'Fetch', input_schema: { type: 'object' as const, properties: {}, required: [] } }],
      errorBudget: { maxTurns: 5, maxConsecutiveErrors: 10 },
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

    // Budget maxTurns=5: turnsUsed increments BEFORE skill invocation.
    // Turns 1-4 proceed to invoke; turn 5 hits the budget check and bails.
    expect(mockExecution.invoke).toHaveBeenCalledTimes(4);
    expect(responseContent).toBeTruthy();
  });
});

// -- Error budget enforcement tests --

describe('AgentRuntime error budget', () => {
  // Reusable tool definition for budget tests
  const toolDef = {
    name: 'web-fetch',
    description: 'Fetch',
    input_schema: { type: 'object' as const, properties: {}, required: [] as string[] },
  };

  it('stops after maxTurns is exceeded and publishes agent.error', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);

    let callId = 0;
    const alwaysToolUseProvider: LLMProvider = {
      id: 'mock',
      chat: vi.fn(async () => ({
        type: 'tool_use' as const,
        toolCalls: [{ id: `call-${callId++}`, name: 'web-fetch', input: {} }],
        usage: { inputTokens: 50, outputTokens: 20 },
      })),
    };

    const mockExecution = {
      invoke: vi.fn().mockResolvedValue({ success: true, data: 'ok' }),
    } as unknown as ExecutionLayer;

    const agentErrors: AgentErrorEvent[] = [];
    bus.subscribe('agent.error', 'system', (event) => {
      agentErrors.push(event as AgentErrorEvent);
    });
    // Need a dispatch subscriber for agent.response so the bus allows it
    bus.subscribe('agent.response', 'dispatch', () => {});

    const agent = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are an assistant.',
      provider: alwaysToolUseProvider,
      bus,
      logger,
      executionLayer: mockExecution,
      skillToolDefs: [toolDef],
      errorBudget: { maxTurns: 3, maxConsecutiveErrors: 10 },
    });
    agent.register();

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-budget-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Do something',
      parentEventId: 'parent-1',
    });
    await bus.publish('dispatch', task);

    // maxTurns=3: turnsUsed increments BEFORE skill invocation.
    // Turns 1-2 proceed to invoke; turn 3 hits the budget check and bails.
    expect(mockExecution.invoke).toHaveBeenCalledTimes(2);

    // An agent.error event with BUDGET_EXCEEDED should have been published
    expect(agentErrors).toHaveLength(1);
    expect(agentErrors[0]?.payload.errorType).toBe('BUDGET_EXCEEDED');
    expect(agentErrors[0]?.payload.message).toContain('turn budget');
  });

  it('stops after maxConsecutiveErrors is exceeded', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);

    // Each LLM turn returns TWO failing tool calls, so consecutiveErrors
    // increments twice per turn (once per failing skill invocation).
    let callId = 0;
    const alwaysToolUseProvider: LLMProvider = {
      id: 'mock',
      chat: vi.fn(async () => ({
        type: 'tool_use' as const,
        toolCalls: [
          { id: `call-${callId++}`, name: 'web-fetch', input: {} },
          { id: `call-${callId++}`, name: 'web-fetch', input: {} },
        ],
        usage: { inputTokens: 50, outputTokens: 20 },
      })),
    };

    // Skill always fails
    const mockExecution = {
      invoke: vi.fn().mockResolvedValue({ success: false, error: 'connection refused' }),
    } as unknown as ExecutionLayer;

    const agentErrors: AgentErrorEvent[] = [];
    bus.subscribe('agent.error', 'system', (event) => {
      agentErrors.push(event as AgentErrorEvent);
    });
    bus.subscribe('agent.response', 'dispatch', () => {});

    const agent = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are an assistant.',
      provider: alwaysToolUseProvider,
      bus,
      logger,
      executionLayer: mockExecution,
      skillToolDefs: [toolDef],
      // chatWithRetry resets consecutiveErrors on each successful LLM call,
      // so we need multiple failing tool calls per turn to accumulate errors.
      // 2 failing tool calls per turn → consecutiveErrors=2 after first turn.
      errorBudget: { maxTurns: 20, maxConsecutiveErrors: 2 },
    });
    agent.register();

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-budget-2',
      channelId: 'cli',
      senderId: 'user',
      content: 'Do something',
      parentEventId: 'parent-2',
    });
    await bus.publish('dispatch', task);

    // First turn: chatWithRetry succeeds (resets to 0), then 2 tool calls fail
    // → consecutiveErrors=2 which equals maxConsecutiveErrors → budget exceeded.
    // Both tool calls in the turn are invoked before the budget check.
    expect(mockExecution.invoke).toHaveBeenCalledTimes(2);

    expect(agentErrors).toHaveLength(1);
    expect(agentErrors[0]?.payload.errorType).toBe('BUDGET_EXCEEDED');
    expect(agentErrors[0]?.payload.message).toContain('consecutive error');
  });

  it('resets consecutiveErrors on successful skill invocation', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);

    // Provider returns tool_use for the first 4 calls, then text on the 5th
    let chatCallCount = 0;
    let callId = 0;
    const provider: LLMProvider = {
      id: 'mock',
      chat: vi.fn(async () => {
        chatCallCount++;
        if (chatCallCount <= 4) {
          return {
            type: 'tool_use' as const,
            toolCalls: [{ id: `call-${callId++}`, name: 'web-fetch', input: {} }],
            usage: { inputTokens: 50, outputTokens: 20 },
          };
        }
        return {
          type: 'text' as const,
          content: 'Done!',
          usage: { inputTokens: 50, outputTokens: 20 },
        };
      }),
    };

    // Alternate fail/success: fail, success, fail, success
    let invokeCount = 0;
    const mockExecution = {
      invoke: vi.fn(async () => {
        invokeCount++;
        if (invokeCount % 2 === 1) {
          return { success: false, error: 'transient failure' };
        }
        return { success: true, data: 'ok' };
      }),
    } as unknown as ExecutionLayer;

    const agentErrors: AgentErrorEvent[] = [];
    bus.subscribe('agent.error', 'system', (event) => {
      agentErrors.push(event as AgentErrorEvent);
    });
    bus.subscribe('agent.response', 'dispatch', () => {});

    const agent = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are an assistant.',
      provider,
      bus,
      logger,
      executionLayer: mockExecution,
      skillToolDefs: [toolDef],
      // maxConsecutiveErrors=2: with alternating fail/success, the counter
      // resets on each success so it should never reach 2.
      errorBudget: { maxTurns: 20, maxConsecutiveErrors: 2 },
    });
    agent.register();

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-budget-3',
      channelId: 'cli',
      senderId: 'user',
      content: 'Do something',
      parentEventId: 'parent-3',
    });
    await bus.publish('dispatch', task);

    // All 4 tool invocations should have run (no early budget exit)
    expect(mockExecution.invoke).toHaveBeenCalledTimes(4);
    // No BUDGET_EXCEEDED error should have been published
    expect(agentErrors).toHaveLength(0);
  });

  it('uses default budget when none configured', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);

    let callId = 0;
    const alwaysToolUseProvider: LLMProvider = {
      id: 'mock',
      chat: vi.fn(async () => ({
        type: 'tool_use' as const,
        toolCalls: [{ id: `call-${callId++}`, name: 'web-fetch', input: {} }],
        usage: { inputTokens: 50, outputTokens: 20 },
      })),
    };

    const mockExecution = {
      invoke: vi.fn().mockResolvedValue({ success: true, data: 'ok' }),
    } as unknown as ExecutionLayer;

    const agentErrors: AgentErrorEvent[] = [];
    bus.subscribe('agent.error', 'system', (event) => {
      agentErrors.push(event as AgentErrorEvent);
    });
    bus.subscribe('agent.response', 'dispatch', () => {});

    // No errorBudget configured — should use DEFAULT_ERROR_BUDGET (maxTurns=20)
    const agent = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are an assistant.',
      provider: alwaysToolUseProvider,
      bus,
      logger,
      executionLayer: mockExecution,
      skillToolDefs: [toolDef],
    });
    agent.register();

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-budget-4',
      channelId: 'cli',
      senderId: 'user',
      content: 'Do something',
      parentEventId: 'parent-4',
    });
    await bus.publish('dispatch', task);

    // Default maxTurns=20: turnsUsed increments before check, so turns 1-19
    // proceed to invoke; turn 20 hits the budget and bails.
    expect(mockExecution.invoke).toHaveBeenCalledTimes(19);
    expect(agentErrors).toHaveLength(1);
    expect(agentErrors[0]?.payload.errorType).toBe('BUDGET_EXCEEDED');
  });
});

// -- Structured error injection test --

describe('AgentRuntime structured error injection', () => {
  it('formats skill errors as <task_error> blocks in tool results', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);

    // Provider returns tool_use on first call, text on second
    let chatCallCount = 0;
    const provider: LLMProvider = {
      id: 'mock',
      chat: vi.fn(async () => {
        chatCallCount++;
        if (chatCallCount === 1) {
          return {
            type: 'tool_use' as const,
            toolCalls: [{ id: 'call-err-1', name: 'email-send', input: { to: 'test@example.com' } }],
            usage: { inputTokens: 50, outputTokens: 20 },
          };
        }
        return {
          type: 'text' as const,
          content: 'I see the error, let me try differently.',
          usage: { inputTokens: 100, outputTokens: 30 },
        };
      }),
    };

    // Skill fails with an error message
    const mockExecution = {
      invoke: vi.fn().mockResolvedValue({ success: false, error: 'SMTP connection refused' }),
    } as unknown as ExecutionLayer;

    bus.subscribe('agent.response', 'dispatch', () => {});

    const agent = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are an assistant.',
      provider,
      bus,
      logger,
      executionLayer: mockExecution,
      skillToolDefs: [{
        name: 'email-send',
        description: 'Send email',
        input_schema: { type: 'object' as const, properties: {}, required: [] as string[] },
      }],
      errorBudget: { maxTurns: 10, maxConsecutiveErrors: 5 },
    });
    agent.register();

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-error-format',
      channelId: 'cli',
      senderId: 'user',
      content: 'Send an email',
      parentEventId: 'parent-err',
    });
    await bus.publish('dispatch', task);

    // The second chat() call should receive the tool_result with <task_error> XML
    expect(provider.chat).toHaveBeenCalledTimes(2);
    const secondCallArgs = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[1]?.[0];
    const messages = secondCallArgs?.messages;

    // The last message should be a user turn with tool_result content blocks
    const lastMessage = messages?.[messages.length - 1];
    expect(lastMessage?.role).toBe('user');

    // Content should be an array of content blocks
    const contentBlocks = lastMessage?.content as Array<{ type: string; content?: string; is_error?: boolean; tool_use_id?: string }>;
    expect(Array.isArray(contentBlocks)).toBe(true);

    const toolResultBlock = contentBlocks?.find((b) => b.type === 'tool_result');
    expect(toolResultBlock).toBeDefined();
    expect(toolResultBlock?.is_error).toBe(true);
    expect(toolResultBlock?.tool_use_id).toBe('call-err-1');

    // The content should be a <task_error> XML block with the right fields
    const errorContent = toolResultBlock?.content as string;
    expect(errorContent).toContain('<task_error>');
    expect(errorContent).toContain('</task_error>');
    expect(errorContent).toContain('<tool>email-send</tool>');
    expect(errorContent).toContain('<error_type>SKILL_ERROR</error_type>');
    expect(errorContent).toContain('SMTP connection refused');
  });
});

// -- Retry logic tests --

function makeRetryableError(): AgentError {
  return {
    type: 'RATE_LIMIT',
    source: 'mock',
    message: 'rate limited',
    retryable: true,
    context: { status: 429 },
    timestamp: new Date(),
  };
}

describe('AgentRuntime chatWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries retryable errors and succeeds on later attempt', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);

    let callCount = 0;
    const provider: LLMProvider = {
      id: 'mock',
      chat: vi.fn(async () => {
        callCount++;
        if (callCount <= 2) {
          // First two calls fail with retryable error
          return { type: 'error' as const, error: makeRetryableError() };
        }
        // Third call succeeds
        return {
          type: 'text' as const,
          content: 'Success after retry!',
          usage: { inputTokens: 50, outputTokens: 20 },
        };
      }),
    };

    bus.subscribe('agent.response', 'dispatch', () => {});

    const agent = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are an assistant.',
      provider,
      bus,
      logger,
    });
    agent.register();

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-retry-ok',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
      parentEventId: 'parent-retry-1',
    });

    // Start task processing (don't await yet — timers need advancing)
    const taskPromise = bus.publish('dispatch', task);

    // Advance past first backoff (1000ms)
    await vi.advanceTimersByTimeAsync(1100);
    // Advance past second backoff (5000ms)
    await vi.advanceTimersByTimeAsync(5100);

    await taskPromise;

    // Provider called 3 times: initial + 2 retries
    expect(provider.chat).toHaveBeenCalledTimes(3);
  });

  it('publishes agent.error after all retries exhausted', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);

    // Provider always returns retryable error
    const provider: LLMProvider = {
      id: 'mock',
      chat: vi.fn(async () => ({
        type: 'error' as const,
        error: makeRetryableError(),
      })),
    };

    const agentErrors: AgentErrorEvent[] = [];
    bus.subscribe('agent.error', 'system', (event) => {
      agentErrors.push(event as AgentErrorEvent);
    });
    bus.subscribe('agent.response', 'dispatch', () => {});

    const agent = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are an assistant.',
      provider,
      bus,
      logger,
    });
    agent.register();

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-retry-exhaust',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
      parentEventId: 'parent-retry-2',
    });

    const taskPromise = bus.publish('dispatch', task);

    // Advance past all 3 backoffs: 1s + 5s + 15s
    await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(5100);
    await vi.advanceTimersByTimeAsync(15100);

    await taskPromise;

    // 1 initial + 3 retries = 4 calls
    expect(provider.chat).toHaveBeenCalledTimes(4);
    // Should have published agent.error
    expect(agentErrors).toHaveLength(1);
    expect(agentErrors[0]?.payload.errorType).toBe('RATE_LIMIT');
  });
});
