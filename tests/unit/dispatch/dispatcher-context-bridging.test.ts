import { describe, it, expect, vi } from 'vitest';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import { EventBus } from '../../../src/bus/bus.js';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import { WorkingMemory } from '../../../src/memory/working-memory.js';
import { createInboundMessage, type OutboundMessageEvent, type AgentTaskEvent } from '../../../src/bus/events.js';
import type { LLMProvider } from '../../../src/agents/llm/provider.js';
import { createLogger } from '../../../src/logger.js';
import { OUTBOUND_MEMO_PREFIX } from '../../../src/dispatch/context-memo.js';

function setupTestBus() {
  const logger = createLogger('error');
  const bus = new EventBus(logger);
  const memory = WorkingMemory.createInMemory();

  const mockProvider: LLMProvider = {
    id: 'mock',
    chat: vi.fn().mockResolvedValue({
      type: 'text' as const,
      content: 'Response from Coordinator',
      usage: { inputTokens: 10, outputTokens: 5 },
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

  return { bus, logger, memory, mockProvider };
}

describe('Dispatcher context bridging — outbound memo', () => {
  it('writes an outbound context memo to working memory for non-threaded channels', async () => {
    const { bus, logger, memory } = setupTestBus();

    const dispatcher = new Dispatcher({
      bus,
      logger,
      workingMemory: memory,
      channelPolicies: { signal: { trust: 'high', unknownSender: 'hold_and_notify', threaded: false } },
    });
    dispatcher.register();

    const outbound: OutboundMessageEvent[] = [];
    bus.subscribe('outbound.message', 'channel', (event) => {
      outbound.push(event as OutboundMessageEvent);
    });

    const event = createInboundMessage({
      conversationId: 'signal:+14155552671',
      channelId: 'signal',
      senderId: '+14155552671',
      content: 'Hello',
    });
    await bus.publish('channel', event);

    expect(outbound).toHaveLength(1);

    const history = await memory.getHistory('signal:+14155552671', 'coordinator');
    const memoTurns = history.filter(t => t.role === 'system' && t.content.startsWith(OUTBOUND_MEMO_PREFIX));
    expect(memoTurns).toHaveLength(1);
    expect(memoTurns[0].content).toContain('message_preview: Response from Coordinator');
    expect(memoTurns[0].content).toContain('source_conversation: signal:+14155552671');
  });

  it('does NOT write a memo for threaded channels', async () => {
    const { bus, logger, memory } = setupTestBus();

    const dispatcher = new Dispatcher({
      bus,
      logger,
      workingMemory: memory,
      channelPolicies: { email: { trust: 'low', unknownSender: 'hold_and_notify', threaded: true } },
    });
    dispatcher.register();

    const outbound: OutboundMessageEvent[] = [];
    bus.subscribe('outbound.message', 'channel', (event) => {
      outbound.push(event as OutboundMessageEvent);
    });

    const event = createInboundMessage({
      conversationId: 'email:alice@example.com',
      channelId: 'email',
      senderId: 'alice@example.com',
      content: 'Hello',
    });
    await bus.publish('channel', event);

    expect(outbound).toHaveLength(1);

    const history = await memory.getHistory('email:alice@example.com', 'coordinator');
    const memoTurns = history.filter(t => t.role === 'system' && t.content.startsWith(OUTBOUND_MEMO_PREFIX));
    expect(memoTurns).toHaveLength(0);
  });

  it('does NOT write a memo when workingMemory is not configured', async () => {
    const { bus, logger } = setupTestBus();

    const dispatcher = new Dispatcher({
      bus,
      logger,
      channelPolicies: { signal: { trust: 'high', unknownSender: 'hold_and_notify', threaded: false } },
    });
    dispatcher.register();

    const outbound: OutboundMessageEvent[] = [];
    bus.subscribe('outbound.message', 'channel', (event) => {
      outbound.push(event as OutboundMessageEvent);
    });

    const event = createInboundMessage({
      conversationId: 'signal:+14155552671',
      channelId: 'signal',
      senderId: '+14155552671',
      content: 'Hello',
    });

    await bus.publish('channel', event);
    expect(outbound).toHaveLength(1);
  });
});

describe('Dispatcher context bridging — inbound injection', () => {
  it('prepends outbound context preamble to task content when memos exist', async () => {
    const { bus, logger, memory } = setupTestBus();

    const dispatcher = new Dispatcher({
      bus,
      logger,
      workingMemory: memory,
      channelPolicies: { signal: { trust: 'high', unknownSender: 'allow', threaded: false } },
    });
    dispatcher.register();

    const memoContent = `${OUTBOUND_MEMO_PREFIX}${new Date().toISOString()}]\nsource_conversation: signal:+14155552671\nmessage_preview: You have 3 held emails\ntask_type: coordinator-response\nexpected_reply: User may reply to this message`;
    await memory.addTurn('signal:+14155552671', 'coordinator', {
      role: 'system',
      content: memoContent,
    });

    const tasks: AgentTaskEvent[] = [];
    bus.subscribe('agent.task', 'agent', (event) => {
      tasks.push(event as AgentTaskEvent);
    });

    const event = createInboundMessage({
      conversationId: 'signal:+14155552671',
      channelId: 'signal',
      senderId: '+14155552671',
      content: 'Yes, process them',
    });
    await bus.publish('channel', event);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].payload.content).toContain('[PRIOR OUTBOUND CONTEXT');
    expect(tasks[0].payload.content).toContain('You have 3 held emails');
    expect(tasks[0].payload.content).toContain('Yes, process them');
  });

  it('does NOT inject preamble when no memos exist', async () => {
    const { bus, logger, memory } = setupTestBus();

    const dispatcher = new Dispatcher({
      bus,
      logger,
      workingMemory: memory,
      channelPolicies: { signal: { trust: 'high', unknownSender: 'allow', threaded: false } },
    });
    dispatcher.register();

    const tasks: AgentTaskEvent[] = [];
    bus.subscribe('agent.task', 'agent', (event) => {
      tasks.push(event as AgentTaskEvent);
    });

    const event = createInboundMessage({
      conversationId: 'signal:+14155552671',
      channelId: 'signal',
      senderId: '+14155552671',
      content: 'Hello there',
    });
    await bus.publish('channel', event);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].payload.content).toBe('Hello there');
    expect(tasks[0].payload.content).not.toContain('[PRIOR OUTBOUND CONTEXT');
  });

  it('does NOT inject preamble for threaded channels even if memos exist', async () => {
    const { bus, logger, memory } = setupTestBus();

    const dispatcher = new Dispatcher({
      bus,
      logger,
      workingMemory: memory,
      channelPolicies: { email: { trust: 'low', unknownSender: 'allow', threaded: true } },
    });
    dispatcher.register();

    await memory.addTurn('email:alice@example.com', 'coordinator', {
      role: 'system',
      content: `${OUTBOUND_MEMO_PREFIX}${new Date().toISOString()}]\nmessage_preview: hello`,
    });

    const tasks: AgentTaskEvent[] = [];
    bus.subscribe('agent.task', 'agent', (event) => {
      tasks.push(event as AgentTaskEvent);
    });

    const event = createInboundMessage({
      conversationId: 'email:alice@example.com',
      channelId: 'email',
      senderId: 'alice@example.com',
      content: 'Reply to thread',
    });
    await bus.publish('channel', event);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].payload.content).not.toContain('[PRIOR OUTBOUND CONTEXT');
  });

  it('excludes memos older than TTL', async () => {
    const { bus, logger, memory } = setupTestBus();

    const dispatcher = new Dispatcher({
      bus,
      logger,
      workingMemory: memory,
      channelPolicies: { signal: { trust: 'high', unknownSender: 'allow', threaded: false } },
      contextMemoTtlMs: 1000,
    });
    dispatcher.register();

    const oldDate = new Date(Date.now() - 2000).toISOString();
    await memory.addTurn('signal:+14155552671', 'coordinator', {
      role: 'system',
      content: `${OUTBOUND_MEMO_PREFIX}${oldDate}]\nmessage_preview: old message\ntask_type: coordinator-response\nexpected_reply: User may reply`,
    });

    const tasks: AgentTaskEvent[] = [];
    bus.subscribe('agent.task', 'agent', (event) => {
      tasks.push(event as AgentTaskEvent);
    });

    const event = createInboundMessage({
      conversationId: 'signal:+14155552671',
      channelId: 'signal',
      senderId: '+14155552671',
      content: 'Hello',
    });
    await bus.publish('channel', event);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].payload.content).toBe('Hello');
    expect(tasks[0].payload.content).not.toContain('[PRIOR OUTBOUND CONTEXT');
  });
});
