// runtime.compose-reply.test.ts — tests for the compose-reply short-circuit
// in AgentRuntime. When the LLM calls compose-reply with {external, internal},
// the runtime must emit agent.response with content=external and
// sidebar={audience:'principal', content:internal} without making an extra
// LLM round-trip. Free-text responses and external-only compose-reply calls
// must produce no sidebar (back-compat).

import { describe, it, expect, vi } from 'vitest';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createAgentTask, type AgentResponseEvent } from '../../../src/bus/events.js';
import type { LLMProvider } from '../../../src/agents/llm/provider.js';
import type { ExecutionLayer } from '../../../src/skills/execution.js';
import { createLogger } from '../../../src/logger.js';

const MOCK_PROVENANCE = {
  requestedModel: 'mock-model',
  actualModel: 'mock-model',
  providerRequestId: 'msg_mock_000',
} as const;

/** LLM that returns a single tool_use for compose-reply, then never called again. */
function makeComposeReplyProvider(input: Record<string, unknown>): LLMProvider {
  return {
    id: 'mock',
    chat: vi.fn().mockResolvedValueOnce({
      type: 'tool_use' as const,
      toolCalls: [{ id: 'cr-1', name: 'compose-reply', input }],
      usage: { inputTokens: 50, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      provenance: MOCK_PROVENANCE,
    }),
  };
}

/** Execution layer that returns compose-reply skill result matching its input. */
function makeComposeReplyExecution(data: { external: string; internal?: string }): ExecutionLayer {
  return {
    invoke: vi.fn().mockResolvedValue({ success: true, data }),
    getToolDefinitions: vi.fn().mockReturnValue([]),
  } as unknown as ExecutionLayer;
}

async function runComposeReplyTask(
  provider: LLMProvider,
  execution: ExecutionLayer,
): Promise<AgentResponseEvent[]> {
  const logger = createLogger('silent');
  const bus = new EventBus(logger);
  const responses: AgentResponseEvent[] = [];

  bus.subscribe('agent.response', 'dispatch', (ev) => {
    responses.push(ev as AgentResponseEvent);
  });

  const agent = new AgentRuntime({
    agentId: 'coordinator',
    systemPrompt: 'You are an assistant.',
    provider,
    resolvedModel: 'mock-model',
    bus,
    logger,
    executionLayer: execution,
    pinnedSkills: ['compose-reply'],
    skillToolDefs: [
      {
        name: 'compose-reply',
        description: 'Compose a two-audience reply',
        input_schema: {
          type: 'object' as const,
          properties: {
            external: { type: 'string' },
            internal: { type: 'string' },
          },
          required: ['external'],
        },
      },
    ],
  });
  agent.register();

  const task = createAgentTask({
    agentId: 'coordinator',
    conversationId: 'conv-1',
    channelId: 'email',
    senderId: 'armin@example.com',
    content: 'Can we meet Friday?',
    parentEventId: 'inbound-1',
  });
  await bus.publish('dispatch', task);

  return responses;
}

describe('AgentRuntime compose-reply detection', () => {
  it('emits agent.response with content=external and sidebar when compose-reply returns both fields', async () => {
    const input = { external: 'Friday at 2 PM works.', internal: 'Confirmed Fri 2 PM with Armin; invite pending.' };
    const provider = makeComposeReplyProvider(input);
    const execution = makeComposeReplyExecution({ external: input.external, internal: input.internal });

    const responses = await runComposeReplyTask(provider, execution);

    expect(responses).toHaveLength(1);
    const resp = responses[0]!;
    expect(resp.payload.content).toBe('Friday at 2 PM works.');
    expect(resp.payload.sidebar).toEqual({ audience: 'principal', content: 'Confirmed Fri 2 PM with Armin; invite pending.' });
  });

  it('does not make a second LLM call when compose-reply short-circuits', async () => {
    const input = { external: 'Friday at 2 PM works.', internal: 'Status for CEO.' };
    const provider = makeComposeReplyProvider(input);
    const execution = makeComposeReplyExecution({ external: input.external, internal: input.internal });

    await runComposeReplyTask(provider, execution);

    // LLM should only be called once (the initial tool_use), not again for a text response
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it('emits agent.response with content=external and no sidebar when compose-reply has no internal', async () => {
    const input = { external: 'See you then.' };
    const provider = makeComposeReplyProvider(input);
    const execution = makeComposeReplyExecution({ external: input.external });

    const responses = await runComposeReplyTask(provider, execution);

    expect(responses).toHaveLength(1);
    const resp = responses[0]!;
    expect(resp.payload.content).toBe('See you then.');
    expect(resp.payload.sidebar).toBeUndefined();
  });

  it('falls back to free-text response without sidebar when compose-reply is not called', async () => {
    const logger = createLogger('silent');
    const bus = new EventBus(logger);
    const responses: AgentResponseEvent[] = [];

    bus.subscribe('agent.response', 'dispatch', (ev) => {
      responses.push(ev as AgentResponseEvent);
    });

    const provider: LLMProvider = {
      id: 'mock',
      chat: vi.fn().mockResolvedValue({
        type: 'text' as const,
        content: 'Friday works for me!',
        usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        provenance: MOCK_PROVENANCE,
      }),
    };

    const agent = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are an assistant.',
      provider,
      resolvedModel: 'mock-model',
      bus,
      logger,
    });
    agent.register();

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-2',
      channelId: 'email',
      senderId: 'armin@example.com',
      content: 'Can we meet Friday?',
      parentEventId: 'inbound-2',
    });
    await bus.publish('dispatch', task);

    expect(responses).toHaveLength(1);
    expect(responses[0]!.payload.content).toBe('Friday works for me!');
    expect(responses[0]!.payload.sidebar).toBeUndefined();
  });

  it('continues the tool loop normally when compose-reply returns a failure', async () => {
    // If compose-reply fails validation, the error is fed back to the LLM
    // and the loop continues — the runtime should NOT short-circuit on failure.
    const logger = createLogger('silent');
    const bus = new EventBus(logger);
    const responses: AgentResponseEvent[] = [];

    bus.subscribe('agent.response', 'dispatch', (ev) => {
      responses.push(ev as AgentResponseEvent);
    });

    let callCount = 0;
    const provider: LLMProvider = {
      id: 'mock',
      chat: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            type: 'tool_use' as const,
            toolCalls: [{ id: 'cr-1', name: 'compose-reply', input: { external: '' } }],
            usage: { inputTokens: 50, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
            provenance: MOCK_PROVENANCE,
          };
        }
        return {
          type: 'text' as const,
          content: 'Let me try again.',
          usage: { inputTokens: 100, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          provenance: MOCK_PROVENANCE,
        };
      }),
    };

    const execution: ExecutionLayer = {
      invoke: vi.fn().mockResolvedValue({ success: false, error: 'external must not be empty' }),
      getToolDefinitions: vi.fn().mockReturnValue([]),
    } as unknown as ExecutionLayer;

    const agent = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are an assistant.',
      provider,
      resolvedModel: 'mock-model',
      bus,
      logger,
      executionLayer: execution,
      pinnedSkills: ['compose-reply'],
      skillToolDefs: [
        {
          name: 'compose-reply',
          description: 'Compose reply',
          input_schema: { type: 'object' as const, properties: { external: { type: 'string' } }, required: ['external'] },
        },
      ],
    });
    agent.register();

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-3',
      channelId: 'email',
      senderId: 'armin@example.com',
      content: 'What time works?',
      parentEventId: 'inbound-3',
    });
    await bus.publish('dispatch', task);

    // Loop continued; LLM was called twice
    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(responses).toHaveLength(1);
    // No sidebar — compose-reply failed so no short-circuit
    expect(responses[0]!.payload.sidebar).toBeUndefined();
  });
});
