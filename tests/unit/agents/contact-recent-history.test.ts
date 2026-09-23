import { describe, it, expect, vi } from 'vitest';
import { AgentRuntime } from '../../../src/agents/runtime.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createAgentTask, type AgentResponseEvent, type ContextBudgetEvent } from '../../../src/bus/events.js';
import type { LLMProvider, Message } from '../../../src/agents/llm/provider.js';
import type { ModelRegistry } from '../../../src/agents/llm/model-registry.js';
import { createLogger } from '../../../src/logger.js';
import { WorkingMemory } from '../../../src/memory/working-memory.js';
import { VOICE_GREETING_USER_MESSAGE } from '../../../src/channels/voice/greeting.js';
import { CONTACT_RECENT_HISTORY_HEADER } from '../../../src/memory/contact-recent-history.js';
import type { ConversationEntityState } from '../../../src/entity-context/conversation-entities.js';
import type { ResolvedEntityCard } from '../../../src/agents/resolved-entities.js';

const ALICE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CAROL = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const EARLIER = new Date();

const PRIVATE_EMAIL = {
  curiaRole: 'to',
  primaryRecipientEmails: [] as string[],
  participants: [
    { email: 'alice@example.com', role: 'from' },
    { email: 'office@example.com', role: 'to' },
  ],
};

const ALICE_SENDER = {
  resolved: true as const,
  contactId: ALICE,
  displayName: 'Alice',
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
  contactConfidence: 1,
};

function provider(): LLMProvider & { chat: ReturnType<typeof vi.fn> } {
  return {
    id: 'mock',
    chat: vi.fn().mockResolvedValue({
      type: 'text' as const,
      content: 'Noted.',
      usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      provenance: { requestedModel: 'mock-model', actualModel: 'mock-model', providerRequestId: 'msg_mock' },
    }),
  };
}

function messagesOf(chat: ReturnType<typeof vi.fn>): Message[] {
  const arg = chat.mock.calls[0]?.[0] as { messages: Message[] } | undefined;
  return arg?.messages ?? [];
}

function blockText(messages: Message[]): string | undefined {
  const found = messages.find(m => typeof m.content === 'string' && m.content.includes(CONTACT_RECENT_HISTORY_HEADER));
  return typeof found?.content === 'string' ? found.content : undefined;
}

async function seedPrior(memory: WorkingMemory): Promise<void> {
  await memory.addTurn('email:thread-old', 'coordinator', { role: 'user', content: 'the prior thread asked for Thursday' }, {
    senderContactId: ALICE,
    channelId: 'email',
    createdAt: EARLIER,
  });
  await memory.addTurn('email:thread-old', 'coordinator', { role: 'assistant', content: 'see you Thursday' }, {
    channelId: 'email',
    createdAt: new Date(EARLIER.getTime() + 1000),
  });
  await memory.addTurn('email:thread-cc', 'coordinator', { role: 'user', content: 'alice own line' }, {
    senderContactId: ALICE,
    channelId: 'email',
    createdAt: new Date(EARLIER.getTime() + 2000),
  });
  await memory.addTurn('email:thread-cc', 'coordinator', { role: 'user', content: 'carol secret line' }, {
    senderContactId: CAROL,
    channelId: 'email',
    createdAt: new Date(EARLIER.getTime() + 3000),
  });
  await memory.addTurn('email:thread-cc', 'coordinator', { role: 'assistant', content: 'noted everyone on the thread' }, {
    channelId: 'email',
    createdAt: new Date(EARLIER.getTime() + 4000),
  });
  await memory.addTurn('email:thread-old', 'coordinator', { role: 'user', content: 'yesterday leftover' }, {
    senderContactId: ALICE,
    channelId: 'email',
    createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
  });
}

describe('AgentRuntime contact recent history (#1599)', () => {
  it('injects the prior email thread on a new thread and omits other participants', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    const responses: AgentResponseEvent[] = [];
    bus.subscribe('agent.response', 'dispatch', (event) => {
      responses.push(event as AgentResponseEvent);
    });
    const llm = provider();
    const memory = WorkingMemory.createInMemory();
    await seedPrior(memory);

    const runtime = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are helpful.',
      provider: llm,
      resolvedModel: 'mock-model',
      bus,
      logger,
      memory,
      timezone: 'America/Toronto',
      selfEmails: ['office@example.com'],
    });
    runtime.register();

    await bus.publish('dispatch', createAgentTask({
      agentId: 'coordinator',
      conversationId: 'email:thread-new',
      channelId: 'email',
      senderId: 'alice@example.com',
      content: 'following up on a new thread',
      senderContext: ALICE_SENDER,
      metadata: PRIVATE_EMAIL,
      parentEventId: 'parent-1',
    }));

    expect(responses).toHaveLength(1);
    const messages = messagesOf(llm.chat);
    const block = blockText(messages);
    expect(block).toBeDefined();
    expect(block).toContain('the prior thread asked for Thursday');
    expect(block).toContain('see you Thursday');
    expect(block).toContain('alice own line');
    expect(block).not.toContain('carol secret line');
    expect(block).not.toContain('noted everyone on the thread');
    expect(block).not.toContain('yesterday leftover');
    expect(block).not.toContain('following up on a new thread');
    expect(messages.some(m => m.role === 'user' && m.content === 'following up on a new thread')).toBe(true);
    const blockAt = messages.findIndex(m => typeof m.content === 'string' && m.content.includes(CONTACT_RECENT_HISTORY_HEADER));
    const historyAt = messages.findIndex(m => m.role === 'user' && m.content === 'following up on a new thread');
    expect(blockAt).toBeGreaterThan(-1);
    expect(blockAt).toBeLessThan(historyAt);

    // The turn just written is itself recallable from a later conversation.
    const stamped = await memory.getContactRecentHistory({
      contactId: ALICE,
      agentId: 'coordinator',
      excludeConversationId: 'email:thread-later',
      since: new Date(Date.now() - 60 * 60 * 1000),
    });
    expect(stamped.some(t => t.role === 'user' && t.content === 'following up on a new thread')).toBe(true);
    expect(stamped.some(t => t.role === 'assistant' && t.content === 'Noted.')).toBe(true);
  });

  it('does not recall contact history on a scheduler run', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    bus.subscribe('agent.response', 'dispatch', () => {});
    const llm = provider();
    const memory = WorkingMemory.createInMemory();
    await seedPrior(memory);
    const runtime = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are helpful.',
      provider: llm,
      resolvedModel: 'mock-model',
      bus,
      logger,
      memory,
      timezone: 'America/Toronto',
      selfEmails: ['office@example.com'],
    });
    runtime.register();

    await bus.publish('dispatch', createAgentTask({
      agentId: 'coordinator',
      conversationId: 'scheduler:job-1',
      channelId: 'scheduler',
      senderId: 'scheduler',
      content: 'sweep',
      senderContext: ALICE_SENDER,
      parentEventId: 'parent-sched',
    }));

    expect(blockText(messagesOf(llm.chat))).toBeUndefined();
  });

  it('drops the tier when it does not fit, and keeps resolved entities and the live transcript', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    const budgets: ContextBudgetEvent[] = [];
    bus.subscribe('agent.response', 'dispatch', () => {});
    bus.subscribe('context.budget', 'system', (event) => {
      budgets.push(event as ContextBudgetEvent);
    });
    const llm = provider();
    const memory = WorkingMemory.createInMemory();
    const fat = 'x'.repeat(500);
    for (let i = 0; i < 8; i += 1) {
      await memory.addTurn('email:thread-old', 'coordinator', {
        role: 'user',
        content: `${fat} prior ${i}`,
      }, {
        senderContactId: ALICE,
        channelId: 'email',
        createdAt: new Date(EARLIER.getTime() + i * 1000),
      });
    }
    await memory.addTurn('email:thread-new', 'coordinator', { role: 'user', content: 'live transcript turn' }, {
      senderContactId: ALICE,
      channelId: 'email',
      createdAt: EARLIER,
    });
    await memory.addTurn('email:thread-new', 'coordinator', { role: 'assistant', content: 'live transcript reply' }, {
      channelId: 'email',
      createdAt: new Date(EARLIER.getTime() + 500),
    });

    const card: ResolvedEntityCard = {
      contactId: ALICE,
      displayName: 'Dana Ng',
      preferredName: null,
      role: null,
      organization: null,
      primaryEmail: 'dana@example.com',
      primaryPhone: null,
    };
    const conversationEntities = {
      turnIdentities: {
        begin() {},
        replace() {},
        merge() {},
        end() {},
        has() { return false; },
        get() { return []; },
      },
      loadCurrent: async () => [card],
    } as unknown as ConversationEntityState;

    const registry = {
      getContextWindow: () => 2200,
      isKnownModel: () => true,
    } as unknown as ModelRegistry;

    const runtime = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are helpful.',
      provider: llm,
      resolvedModel: 'mock-model',
      bus,
      logger,
      memory,
      timezone: 'America/Toronto',
      selfEmails: ['office@example.com'],
      contextBudget: { responseReserve: 1000 },
      modelRegistry: registry,
      conversationEntities,
    });
    runtime.register();

    await bus.publish('dispatch', createAgentTask({
      agentId: 'coordinator',
      conversationId: 'email:thread-new',
      channelId: 'email',
      senderId: 'alice@example.com',
      content: 'new email',
      senderContext: ALICE_SENDER,
      metadata: PRIVATE_EMAIL,
      parentEventId: 'parent-budget',
    }));

    const messages = messagesOf(llm.chat);
    const joined = messages.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
    expect(joined).toContain('<resolved_entities>');
    expect(joined).toContain('live transcript turn');
    expect(joined).toContain('live transcript reply');
    expect(joined).not.toContain(CONTACT_RECENT_HISTORY_HEADER);

    expect(budgets).toHaveLength(1);
    const tiers = budgets[0]!.payload.tiers;
    const resolvedAt = tiers.findIndex(t => t.name === 'resolved_entities');
    const historyAt = tiers.findIndex(t => t.name === 'conversation_history');
    const contactAt = tiers.findIndex(t => t.name === 'contact_recent_history');
    expect(resolvedAt).toBeGreaterThan(-1);
    expect(historyAt).toBeGreaterThan(resolvedAt);
    expect(contactAt).toBeGreaterThan(historyAt);
    expect(tiers[resolvedAt]!.included).toBe(true);
    expect(tiers[historyAt]!.included).toBe(true);
    expect(tiers[contactAt]!.included).toBe(false);
    expect(tiers[contactAt]!.droppedReason).toBe('budget_exceeded');
  });

  it('does not inject a private 1:1 into a Signal group or a CC email', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    bus.subscribe('agent.response', 'dispatch', () => {});
    const llm = provider();
    const memory = WorkingMemory.createInMemory();
    await memory.addTurn('signal:+1555', 'coordinator', {
      role: 'user',
      content: 'do not tell Bob the offer is 4.2',
    }, {
      senderContactId: ALICE,
      channelId: 'signal',
      createdAt: EARLIER,
    });

    const runtime = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are helpful.',
      provider: llm,
      resolvedModel: 'mock-model',
      bus,
      logger,
      memory,
      timezone: 'America/Toronto',
      selfEmails: ['office@example.com'],
    });
    runtime.register();

    await bus.publish('dispatch', createAgentTask({
      agentId: 'coordinator',
      conversationId: 'signal:group=g1',
      channelId: 'signal',
      senderId: '+1555',
      content: 'posting in the group',
      senderContext: ALICE_SENDER,
      parentEventId: 'parent-group',
    }));

    expect(blockText(messagesOf(llm.chat))).toBeUndefined();
    expect(messagesOf(llm.chat).map(m => m.content).join('\n')).not.toContain('do not tell Bob');

    llm.chat.mockClear();
    await bus.publish('dispatch', createAgentTask({
      agentId: 'coordinator',
      conversationId: 'email:thread-cc',
      channelId: 'email',
      senderId: 'alice@example.com',
      content: 'looping Bob in',
      senderContext: ALICE_SENDER,
      metadata: {
        curiaRole: 'cc',
        primaryRecipientEmails: ['bob@example.com'],
        participants: [
          { email: 'alice@example.com', role: 'from' },
          { email: 'bob@example.com', role: 'to' },
          { email: 'office@example.com', role: 'cc' },
        ],
      },
      parentEventId: 'parent-cc',
    }));

    expect(blockText(messagesOf(llm.chat))).toBeUndefined();
    expect(messagesOf(llm.chat).map(m => m.content).join('\n')).not.toContain('do not tell Bob');

    // BCC: converter reports curiaRole 'to' and no extra To because Curia was
    // not on the headers. Bob is the visible recipient.
    llm.chat.mockClear();
    await bus.publish('dispatch', createAgentTask({
      agentId: 'coordinator',
      conversationId: 'email:thread-bcc',
      channelId: 'email',
      senderId: 'alice@example.com',
      content: 'note to Bob',
      senderContext: ALICE_SENDER,
      metadata: {
        curiaRole: 'to',
        primaryRecipientEmails: [],
        participants: [
          { email: 'alice@example.com', role: 'from' },
          { email: 'bob@example.com', role: 'to' },
        ],
      },
      parentEventId: 'parent-bcc',
    }));

    expect(blockText(messagesOf(llm.chat))).toBeUndefined();
    expect(messagesOf(llm.chat).map(m => m.content).join('\n')).not.toContain('do not tell Bob');
  });

  it('recalls the spoken refusal from a call that opened with the greeting cue', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    bus.subscribe('agent.response', 'dispatch', () => {});
    const llm = provider();
    const memory = WorkingMemory.createInMemory();
    await memory.addTurn('voice:earlier', 'coordinator', {
      role: 'user',
      content: VOICE_GREETING_USER_MESSAGE,
    }, {
      channelId: 'voice',
      createdAt: EARLIER,
    });
    await memory.addTurn('voice:earlier', 'coordinator', {
      role: 'user',
      content: 'can you move the board prep to 4?',
    }, {
      senderContactId: ALICE,
      channelId: 'voice',
      createdAt: new Date(EARLIER.getTime() + 1000),
    });
    await memory.addTurn('voice:earlier', 'coordinator', {
      role: 'assistant',
      content: 'no, you have the investor call then',
    }, {
      channelId: 'voice',
      createdAt: new Date(EARLIER.getTime() + 2000),
    });

    const runtime = new AgentRuntime({
      agentId: 'coordinator',
      systemPrompt: 'You are helpful.',
      provider: llm,
      resolvedModel: 'mock-model',
      bus,
      logger,
      memory,
      timezone: 'America/Toronto',
      selfEmails: ['office@example.com'],
    });
    runtime.register();

    await bus.publish('dispatch', createAgentTask({
      agentId: 'coordinator',
      conversationId: 'email:thread-new',
      channelId: 'email',
      senderId: 'alice@example.com',
      content: 'following up by email',
      senderContext: ALICE_SENDER,
      metadata: PRIVATE_EMAIL,
      parentEventId: 'parent-voice',
    }));

    const block = blockText(messagesOf(llm.chat));
    expect(block).toContain('can you move the board prep to 4?');
    expect(block).toContain('no, you have the investor call then');
    expect(block).not.toContain(VOICE_GREETING_USER_MESSAGE);
  });
});
