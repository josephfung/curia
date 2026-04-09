import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import { EventBus } from '../../../src/bus/bus.js';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import { createInboundMessage, createAgentError, type OutboundMessageEvent, type MessageRejectedEvent, type AgentTaskEvent, type MessageHeldEvent } from '../../../src/bus/events.js';
import type { LLMProvider } from '../../../src/agents/llm/provider.js';
import type { ContactResolver } from '../../../src/contacts/contact-resolver.js';
import type { InboundSenderContext, ContactStatus, TrustLevel } from '../../../src/contacts/types.js';
import { HeldMessageService } from '../../../src/contacts/held-messages.js';
import { createLogger } from '../../../src/logger.js';

// -- Test helpers --

/**
 * Creates a mock ContactResolver that returns a resolved contact with the given trust inputs.
 * Used to exercise trust scoring paths without a real database.
 */
function makeResolverWithContact(opts: { contactConfidence: number; trustLevel: TrustLevel | null; status: ContactStatus }): ContactResolver {
  return {
    resolve: async (_channel, _senderId) => ({
      resolved: true,
      contactId: 'test-contact-id',
      displayName: 'Test Contact',
      role: null,
      status: opts.status,
      verified: true,
      kgNodeId: null,
      knowledgeSummary: '',
      authorization: null,
      contactConfidence: opts.contactConfidence,
      trustLevel: opts.trustLevel,
    }),
  } as unknown as ContactResolver;
}

/**
 * Creates a mock ContactResolver that returns an unresolved (unknown) sender.
 * contactConfidence defaults to 0.0 in the trust scorer for unknown senders.
 */
function makeResolverWithNoContact(): ContactResolver {
  return {
    resolve: async (channel, senderId) => ({ resolved: false, channel, senderId }),
  } as unknown as ContactResolver;
}

/**
 * Creates an in-memory HeldMessageService for tests that need to inspect held messages.
 */
function makeInMemoryHeldMessages(): HeldMessageService {
  return HeldMessageService.createInMemory();
}

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

describe('Dispatcher unknown_sender: ignore policy', () => {
  it('publishes message.rejected for unknown sender with ignore policy', async () => {
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
      channelPolicies: { http: { trust: 'low', unknownSender: 'ignore' } },
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

describe('Dispatcher — messageTrustScore', () => {
  it('attaches messageTrustScore to agent.task for known sender', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    const resolver = makeResolverWithContact({
      contactConfidence: 0.8,
      trustLevel: null,
      status: 'confirmed',
    });
    const dispatcher = new Dispatcher({
      bus,
      logger,
      contactResolver: resolver,
      channelPolicies: { email: { trust: 'low', unknownSender: 'hold_and_notify' } },
    });
    dispatcher.register();

    const tasks: AgentTaskEvent[] = [];
    bus.subscribe('agent.task', 'agent', (e) => { tasks.push(e as AgentTaskEvent); });

    await bus.publish('channel', createInboundMessage({
      conversationId: 'conv-trust-1',
      channelId: 'email',
      senderId: 'sender@example.com',
      content: 'Hello',
    }));

    expect(tasks).toHaveLength(1);
    // email low=0.3, contactConfidence=0.8 → (0.3*0.4)+(0.8*0.4) = 0.12+0.32 = 0.44
    expect(tasks[0]!.payload.messageTrustScore).toBeCloseTo(0.44);
  });

  it('attaches messageTrustScore for unknown sender via email', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    const resolver = makeResolverWithNoContact();
    const dispatcher = new Dispatcher({
      bus,
      logger,
      contactResolver: resolver,
      channelPolicies: { email: { trust: 'low', unknownSender: 'allow' } },
    });
    dispatcher.register();

    const tasks: AgentTaskEvent[] = [];
    bus.subscribe('agent.task', 'agent', (e) => { tasks.push(e as AgentTaskEvent); });

    await bus.publish('channel', createInboundMessage({
      conversationId: 'conv-trust-2',
      channelId: 'email',
      senderId: 'unknown@example.com',
      content: 'Hello',
    }));

    expect(tasks).toHaveLength(1);
    // email low=0.3, unknown=0.0 → 0.3*0.4 = 0.12
    expect(tasks[0]!.payload.messageTrustScore).toBeCloseTo(0.12);
  });

  it('trust floor triggers hold_and_notify for low-scoring known sender', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    const heldMessages = makeInMemoryHeldMessages();
    const resolver = makeResolverWithContact({
      contactConfidence: 0.0,
      trustLevel: null,
      status: 'confirmed',
    });
    const dispatcher = new Dispatcher({
      bus,
      logger,
      contactResolver: resolver,
      heldMessages,
      channelPolicies: { email: { trust: 'low', unknownSender: 'allow' } },
      trustScoreFloor: 0.2,
    });
    dispatcher.register();

    const held: MessageHeldEvent[] = [];
    const tasks: AgentTaskEvent[] = [];
    bus.subscribe('message.held', 'channel', (e) => { held.push(e as MessageHeldEvent); });
    bus.subscribe('agent.task', 'agent', (e) => { tasks.push(e as AgentTaskEvent); });

    await bus.publish('channel', createInboundMessage({
      conversationId: 'conv-floor-1',
      channelId: 'email',
      senderId: 'lowscore@example.com',
      content: 'Hello',
    }));

    // email low=0.3, contactConfidence=0.0 → 0.3*0.4=0.12, below floor of 0.2 → held
    expect(held).toHaveLength(1);
    expect(tasks).toHaveLength(0);
  });

  it('trust floor does not hold messages on ignore channels', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    const heldMessages = makeInMemoryHeldMessages();
    const resolver = makeResolverWithContact({
      contactConfidence: 0.0,
      trustLevel: null,
      status: 'confirmed',
    });
    const dispatcher = new Dispatcher({
      bus,
      logger,
      contactResolver: resolver,
      heldMessages,
      channelPolicies: { http: { trust: 'medium', unknownSender: 'ignore' } },
      trustScoreFloor: 0.5,
    });
    dispatcher.register();

    const held: MessageHeldEvent[] = [];
    const tasks: AgentTaskEvent[] = [];
    bus.subscribe('message.held', 'channel', (e) => { held.push(e as MessageHeldEvent); });
    bus.subscribe('agent.task', 'agent', (e) => { tasks.push(e as AgentTaskEvent); });

    await bus.publish('channel', createInboundMessage({
      conversationId: 'conv-floor-2',
      channelId: 'http',
      senderId: 'api-caller',
      content: 'Hello',
    }));

    // Even though score < floor, 'ignore' channel skips the hold
    expect(held).toHaveLength(0);
    expect(tasks).toHaveLength(1);
  });

  it('trust floor holds unknown sender on allow channel (score below floor)', async () => {
    // Regression: unknown senders on 'allow' channels must still be subject to the trust floor.
    // Previously, the senderContext?.resolved !== false guard incorrectly exempted them.
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    const heldMessages = makeInMemoryHeldMessages();
    const resolver = makeResolverWithNoContact(); // unknown sender → contactConfidence = 0.0
    const dispatcher = new Dispatcher({
      bus,
      logger,
      contactResolver: resolver,
      heldMessages,
      channelPolicies: { email: { trust: 'low', unknownSender: 'allow' } },
      trustScoreFloor: 0.2,
    });
    dispatcher.register();

    const held: MessageHeldEvent[] = [];
    const tasks: AgentTaskEvent[] = [];
    bus.subscribe('message.held', 'channel', (e) => { held.push(e as MessageHeldEvent); });
    bus.subscribe('agent.task', 'agent', (e) => { tasks.push(e as AgentTaskEvent); });

    await bus.publish('channel', createInboundMessage({
      conversationId: 'conv-floor-unknown-allow',
      channelId: 'email',
      senderId: 'stranger@example.com',
      content: 'Hello',
    }));

    // email low=0.3*0.4=0.12, below floor of 0.2 → should be held even though channel is 'allow'
    expect(held).toHaveLength(1);
    expect(tasks).toHaveLength(0);
  });
});
