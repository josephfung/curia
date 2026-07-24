import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import { EventBus } from '../../../src/bus/bus.js';
import {
  createAgentTask,
  type AgentResponseEvent,
  type AgentErrorEvent,
} from '../../../src/bus/events.js';
import type { LLMProvider } from '../../../src/agents/llm/provider.js';
import { createLogger } from '../../../src/logger.js';
import type { WorkingMemory } from '../../../src/memory/working-memory.js';
import type { AgentError } from '../../../src/errors/types.js';
import type { ExecutionLayer } from '../../../src/skills/execution.js';

/**
 * Mid-task DB unavailability (#1381).
 *
 * When working memory (critical path) fails with a connection error after
 * dispatch, the runtime must fail gracefully with a retryable
 * DATABASE_UNAVAILABLE agent.error / agent.response — not hang or swallow.
 */

const MOCK_PROVENANCE = {
  requestedModel: 'mock-model',
  actualModel: 'mock-model',
  providerRequestId: 'msg_mock_000',
} as const;

const CONFIRMED_SENDER_CONTEXT = {
  resolved: true as const,
  contactId: 'test-contact-id',
  displayName: 'Test User',
  role: null,
  systemRole: null,
  tier: 'known' as const,
  kind: 'person' as const,
  verified: true,
  kgNodeId: null,
  knowledgeSummary: '',
  authorization: {
    allowed: [] as string[],
    denied: [] as string[],
    escalate: [] as string[],
    channelTrust: 'high' as const,
    trustBlocked: [] as string[],
  },
  contactConfidence: 1.0,
};

describe('AgentRuntime — database unavailable mid-task (#1381)', () => {
  let bus: EventBus;
  let responses: AgentResponseEvent[];
  let errors: AgentErrorEvent[];

  beforeEach(() => {
    const logger = createLogger('error');
    bus = new EventBus(logger);
    responses = [];
    errors = [];
    bus.subscribe('agent.response', 'dispatch', (event) => {
      responses.push(event as AgentResponseEvent);
    });
    bus.subscribe('agent.error', 'system', (event) => {
      errors.push(event as AgentErrorEvent);
    });
  });

  it('fails gracefully with retryable DATABASE_UNAVAILABLE when memory.getHistory throws ECONNREFUSED', async () => {
    const provider: LLMProvider = {
      id: 'mock',
      chat: vi.fn().mockResolvedValue({
        type: 'text' as const,
        content: 'should not be reached',
        usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        provenance: MOCK_PROVENANCE,
      }),
    };

    const dbErr = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    const memory = {
      getHistory: vi.fn().mockRejectedValue(dbErr),
      addTurn: vi.fn(),
      purgeExpired: vi.fn(),
    } as unknown as WorkingMemory;

    const runtime = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a helpful assistant.',
      provider,
      resolvedModel: 'mock-model',
      bus,
      logger: createLogger('error'),
      memory,
    });
    runtime.register();

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-db-down',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
      senderContext: CONFIRMED_SENDER_CONTEXT,
      parentEventId: 'parent-db',
    });
    await bus.publish('dispatch', task);

    expect(provider.chat).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    expect(errors[0]!.payload.errorType).toBe('DATABASE_UNAVAILABLE');
    expect(errors[0]!.payload.retryable).toBe(true);
    expect(responses).toHaveLength(1);
    expect(responses[0]!.payload.isError).toBe(true);
    expect(responses[0]!.payload.errorType).toBe('DATABASE_UNAVAILABLE');
    expect(responses[0]!.payload.retryable).toBe(true);
  });

  it('does not burn consecutiveErrors when a skill returns DATABASE_UNAVAILABLE', async () => {
    // LLM returns a tool call; skill fails with DATABASE_UNAVAILABLE; LLM then
    // replies with text. Budget.consecutiveErrors must stay 0.
    let chatCalls = 0;
    const provider: LLMProvider = {
      id: 'mock',
      chat: vi.fn().mockImplementation(async () => {
        chatCalls += 1;
        if (chatCalls === 1) {
          return {
            type: 'tool_use' as const,
            toolCalls: [{ id: 'tu_1', name: 'contact-lookup', input: { query: 'x' } }],
            usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
            provenance: MOCK_PROVENANCE,
          };
        }
        return {
          type: 'text' as const,
          content: 'Recovered after DB blip',
          usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          provenance: MOCK_PROVENANCE,
        };
      }),
    };

    const executionLayer = {
      invoke: vi.fn().mockResolvedValue({
        success: false,
        error: 'connect ECONNREFUSED',
        errorType: 'DATABASE_UNAVAILABLE' satisfies AgentError['type'],
      }),
      getToolDefinitions: vi.fn().mockReturnValue([
        { name: 'contact-lookup', description: 'lookup', input_schema: { type: 'object', properties: {} } },
      ]),
    } as unknown as ExecutionLayer;

    const runtime = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a helpful assistant.',
      provider,
      resolvedModel: 'mock-model',
      bus,
      logger: createLogger('error'),
      executionLayer,
      pinnedTools: ['contact-lookup'],
      skillToolDefs: [
        {
          name: 'contact-lookup',
          description: 'lookup',
          input_schema: { type: 'object' as const, properties: {}, required: [] },
        },
      ],
      errorBudget: { maxTurns: 5, maxConsecutiveErrors: 2 },
    });
    runtime.register();

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-skill-db',
      channelId: 'cli',
      senderId: 'user',
      content: 'Find Alice',
      senderContext: CONFIRMED_SENDER_CONTEXT,
      parentEventId: 'parent-skill-db',
    });
    await bus.publish('dispatch', task);

    // Task completed with text — did not abort on consecutiveErrors budget.
    expect(responses).toHaveLength(1);
    expect(responses[0]!.payload.content).toBe('Recovered after DB blip');
    expect(responses[0]!.payload.isError).toBeFalsy();
    expect(chatCalls).toBe(2);
  });
});
