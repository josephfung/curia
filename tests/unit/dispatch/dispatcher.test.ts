import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import { EventBus } from '../../../src/bus/bus.js';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import { createInboundMessage, createAgentError, type OutboundMessageEvent, type MessageRejectedEvent } from '../../../src/bus/events.js';
import type { LLMProvider } from '../../../src/agents/llm/provider.js';
import type { ContactResolver } from '../../../src/contacts/contact-resolver.js';
import type { InboundSenderContext } from '../../../src/contacts/types.js';
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

describe('Dispatcher unknown_sender: reject policy', () => {
  it('publishes message.rejected for unknown sender with reject policy', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);

    // Resolver returns unknown sender
    const mockResolver = {
      resolve: vi.fn().mockResolvedValue({
        resolved: false,
        channel: 'http',
        senderId: 'stranger',
      } satisfies InboundSenderContext),
    } as unknown as ContactResolver;

    const dispatcher = new Dispatcher({
      bus,
      logger,
      contactResolver: mockResolver,
      channelPolicies: { http: { trust: 'low', unknownSender: 'reject' } },
    });
    dispatcher.register();

    const rejected: MessageRejectedEvent[] = [];
    bus.subscribe('message.rejected', 'channel', (event) => {
      rejected.push(event as MessageRejectedEvent);
    });

    const event = createInboundMessage({
      conversationId: 'conv-reject-1',
      channelId: 'http',
      senderId: 'stranger',
      content: 'Hello',
    });
    await bus.publish('channel', event);

    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.payload.conversationId).toBe('conv-reject-1');
    expect(rejected[0]?.payload.reason).toBe('unknown_sender');
    expect(rejected[0]?.payload.channelId).toBe('http');
  });

  it('publishes message.rejected for blocked sender', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);

    // Resolver returns a blocked contact
    const mockResolver = {
      resolve: vi.fn().mockResolvedValue({
        resolved: true,
        contactId: 'blocked-contact-id',
        displayName: 'Bad Actor',
        role: null,
        status: 'blocked',
        verified: false,
        kgNodeId: null,
        knowledgeSummary: '',
        authorization: null,
      } satisfies InboundSenderContext),
    } as unknown as ContactResolver;

    const dispatcher = new Dispatcher({
      bus,
      logger,
      contactResolver: mockResolver,
    });
    dispatcher.register();

    const rejected: MessageRejectedEvent[] = [];
    bus.subscribe('message.rejected', 'channel', (event) => {
      rejected.push(event as MessageRejectedEvent);
    });

    const event = createInboundMessage({
      conversationId: 'conv-blocked-1',
      channelId: 'http',
      senderId: 'bad-actor',
      content: 'Hello',
    });
    await bus.publish('channel', event);

    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.payload.conversationId).toBe('conv-blocked-1');
    expect(rejected[0]?.payload.reason).toBe('blocked_sender');
  });

  it('does not publish message.rejected when policy is allow', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);

    const mockResolver = {
      resolve: vi.fn().mockResolvedValue({
        resolved: false,
        channel: 'http',
        senderId: 'stranger',
      } satisfies InboundSenderContext),
    } as unknown as ContactResolver;

    const mockProvider: LLMProvider = {
      id: 'mock',
      chat: vi.fn().mockResolvedValue({
        type: 'text' as const,
        content: 'OK',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };

    const coordinator = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are a helpful assistant.',
      provider: mockProvider,
      bus,
      logger,
    });
    coordinator.register();

    const dispatcher = new Dispatcher({
      bus,
      logger,
      contactResolver: mockResolver,
      channelPolicies: { http: { trust: 'low', unknownSender: 'allow' } },
    });
    dispatcher.register();

    const rejected: MessageRejectedEvent[] = [];
    bus.subscribe('message.rejected', 'channel', (event) => {
      rejected.push(event as MessageRejectedEvent);
    });

    const event = createInboundMessage({
      conversationId: 'conv-allow-1',
      channelId: 'http',
      senderId: 'stranger',
      content: 'Hello',
    });
    await bus.publish('channel', event);

    // Unknown sender with 'allow' policy — message routes through, no rejection
    expect(rejected).toHaveLength(0);
  });
});

describe('Dispatcher agent.error handling', () => {
  it('subscribes to agent.error without crashing', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);

    const dispatcher = new Dispatcher({ bus, logger });
    dispatcher.register();

    // Publish an agent.error — dispatcher should handle it without throwing
    const errorEvent = createAgentError({
      agentId: 'coordinator',
      conversationId: 'conv-err',
      errorType: 'PROVIDER_ERROR',
      source: 'anthropic',
      message: 'Server error',
      retryable: true,
      context: { status: 500 },
      parentEventId: 'task-1',
    });
    await bus.publish('agent', errorEvent);

    // If we reach here without throwing, the dispatcher handled the error event
    expect(true).toBe(true);
  });
});
