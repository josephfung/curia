import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import { EventBus } from '../../../src/bus/bus.js';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import { createInboundMessage, type OutboundMessageEvent } from '../../../src/bus/events.js';
import type { LLMProvider } from '../../../src/agents/llm/provider.js';
import { createLogger } from '../../../src/logger.js';

describe('Dispatcher', () => {
  let bus: EventBus;
  let outbound: OutboundMessageEvent[];

  beforeEach(() => {
    const logger = createLogger('error');
    bus = new EventBus(logger);
    outbound = [];

    const mockProvider: LLMProvider = {
      id: 'mock',
      chat: vi.fn().mockResolvedValue({
        type: 'text' as const,
        content: 'Response from Coordinator',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    };

    // Register coordinator agent (subscribes to agent.task, publishes agent.response)
    const coordinator = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a helpful assistant.',
      provider: mockProvider,
      bus,
      logger,
    });
    coordinator.register();

    // Register dispatcher (subscribes to inbound.message + agent.response)
    const dispatcher = new Dispatcher({ bus, logger });
    dispatcher.register();

    // Capture outbound messages
    bus.subscribe('outbound.message', 'channel', (event) => {
      outbound.push(event as OutboundMessageEvent);
    });
  });

  it('routes inbound message through coordinator and publishes outbound response', async () => {
    const event = createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
    });

    // Bus awaits all handlers synchronously — no setTimeout needed
    await bus.publish('channel', event);

    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.payload.content).toBe('Response from Coordinator');
    expect(outbound[0]?.payload.channelId).toBe('cli');
  });
});
