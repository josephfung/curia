import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../src/bus/bus.js';
import { Dispatcher } from '../../src/dispatch/dispatcher.js';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { WorkingMemory } from '../../src/memory/working-memory.js';
import { createInboundMessage, type OutboundMessageEvent } from '../../src/bus/events.js';
import type { LLMProvider } from '../../src/agents/llm/provider.js';
import { createLogger } from '../../src/logger.js';

describe('Multi-turn conversation with working memory', () => {
  it('includes prior conversation turns in LLM context on second message', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    const memory = WorkingMemory.createInMemory();

    // Track what messages the LLM receives on each call
    const llmCalls: Array<{ messages: unknown[] }> = [];
    let callCount = 0;
    const mockProvider: LLMProvider = {
      id: 'mock',
      chat: vi.fn().mockImplementation((params) => {
        llmCalls.push(params);
        callCount++;
        return Promise.resolve({
          type: 'text' as const,
          content: `Response ${callCount}`,
          usage: { inputTokens: 10, outputTokens: 5 },
        });
      }),
    };

    const coordinator = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are helpful.',
      provider: mockProvider,
      bus,
      logger,
      memory,
    });
    coordinator.register();

    const dispatcher = new Dispatcher({ bus, logger });
    dispatcher.register();

    const outbound: OutboundMessageEvent[] = [];
    bus.subscribe('outbound.message', 'channel', (event) => {
      outbound.push(event as OutboundMessageEvent);
    });

    // --- First message ---
    await bus.publish('channel', createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
    }));

    // First LLM call: system + user message only (no history yet)
    expect(llmCalls[0]?.messages).toHaveLength(2);

    // --- Second message (same conversation) ---
    await bus.publish('channel', createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Follow-up question',
    }));

    // Second LLM call: system + first user + first assistant + second user
    expect(llmCalls[1]?.messages).toHaveLength(4);

    // Verify both responses arrived
    expect(outbound).toHaveLength(2);
    expect(outbound[0]?.payload.content).toBe('Response 1');
    expect(outbound[1]?.payload.content).toBe('Response 2');

    // Verify memory has all 4 turns
    const history = await memory.getHistory('conv-1', 'coordinator');
    expect(history).toHaveLength(4);
    expect(history.map(t => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('keeps separate conversations isolated', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    const memory = WorkingMemory.createInMemory();

    const mockProvider: LLMProvider = {
      id: 'mock',
      chat: vi.fn().mockResolvedValue({
        type: 'text' as const,
        content: 'Reply',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    };

    const coordinator = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are helpful.',
      provider: mockProvider,
      bus,
      logger,
      memory,
    });
    coordinator.register();

    const dispatcher = new Dispatcher({ bus, logger });
    dispatcher.register();

    bus.subscribe('outbound.message', 'channel', () => {});

    // Message in conversation 1
    await bus.publish('channel', createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Conv 1 message',
    }));

    // Message in conversation 2
    await bus.publish('channel', createInboundMessage({
      conversationId: 'conv-2',
      channelId: 'cli',
      senderId: 'user',
      content: 'Conv 2 message',
    }));

    // Each conversation should have its own isolated history
    const h1 = await memory.getHistory('conv-1', 'coordinator');
    const h2 = await memory.getHistory('conv-2', 'coordinator');
    expect(h1).toHaveLength(2); // user + assistant
    expect(h2).toHaveLength(2);
    expect(h1[0]?.content).toBe('Conv 1 message');
    expect(h2[0]?.content).toBe('Conv 2 message');
  });
});
