import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BullpenDispatcher } from '../../../src/dispatch/bullpen-dispatcher.js';
import { BullpenService } from '../../../src/memory/bullpen.js';
import { createLogger } from '../../../src/logger.js';
import { createAgentDiscuss } from '../../../src/bus/events.js';
import type { EventBus } from '../../../src/bus/bus.js';

function makeBus() {
  const handlers = new Map<string, ((event: unknown) => void)[]>();
  return {
    subscribe: vi.fn((type: string, _layer: string, handler: (event: unknown) => void) => {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    }),
    publish: vi.fn(async (_layer: string, _event: unknown) => {
      // Simulate bus delivery so tests can inspect published events
    }),
    _trigger: async (type: string, event: unknown) => {
      for (const h of handlers.get(type) ?? []) await h(event);
    },
  };
}

describe('BullpenDispatcher', () => {
  let bus: ReturnType<typeof makeBus>;
  let bullpenService: BullpenService;
  let dispatcher: BullpenDispatcher;

  beforeEach(() => {
    bus = makeBus();
    bullpenService = BullpenService.createInMemory();
    dispatcher = new BullpenDispatcher(bus as unknown as EventBus, createLogger('error'), bullpenService);
    dispatcher.register();
  });

  it('registers a subscriber for agent.discuss', () => {
    expect(bus.subscribe).toHaveBeenCalledWith('agent.discuss', 'dispatch', expect.any(Function));
  });

  it('creates agent.task for all participants except sender', async () => {
    const { thread } = await bullpenService.openThread(
      'Test thread', 'coordinator', ['coordinator', 'agent-b', 'agent-c'], 'Hello', ['agent-b'],
    );
    const event = createAgentDiscuss({
      threadId: thread.id,
      messageId: 'msg-1',
      topic: 'Test thread',
      senderAgentId: 'coordinator',
      participants: ['coordinator', 'agent-b', 'agent-c'],
      mentionedAgentIds: ['agent-b'],
      content: 'Hello',
      parentEventId: 'task-1',
    });
    await bus._trigger('agent.discuss', event);
    // Should create 2 tasks: agent-b (mentioned) and agent-c (FYI), NOT coordinator
    const publishedTasks = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .filter(([_layer, e]) => (e as { type: string }).type === 'agent.task');
    expect(publishedTasks).toHaveLength(2);
    const agentIds = publishedTasks.map(([_layer, e]) => (e as { payload: { agentId: string } }).payload.agentId);
    expect(agentIds).toContain('agent-b');
    expect(agentIds).toContain('agent-c');
    expect(agentIds).not.toContain('coordinator');
  });

  it('sets channelId to "bullpen" and metadata.taskOrigin to "bullpen"', async () => {
    const { thread } = await bullpenService.openThread(
      'Meta test', 'coordinator', ['coordinator', 'agent-b'], 'Hi', ['agent-b'],
    );
    const event = createAgentDiscuss({
      threadId: thread.id, messageId: 'msg-1', topic: 'Meta test',
      senderAgentId: 'coordinator', participants: ['coordinator', 'agent-b'],
      mentionedAgentIds: ['agent-b'], content: 'Hi', parentEventId: 'task-1',
    });
    await bus._trigger('agent.discuss', event);
    const task = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .find(([_l, e]) => (e as { type: string }).type === 'agent.task')?.[1] as { payload: { channelId: string; metadata: Record<string, unknown> } };
    expect(task?.payload.channelId).toBe('bullpen');
    expect(task?.payload.metadata?.taskOrigin).toBe('bullpen');
    expect(task?.payload.metadata?.threadId).toBe(thread.id);
  });

  it('marks mentioned agents with mentioned: true in metadata', async () => {
    const { thread } = await bullpenService.openThread(
      'Mention test', 'coordinator', ['coordinator', 'agent-b', 'agent-c'], 'Hi', ['agent-b'],
    );
    const event = createAgentDiscuss({
      threadId: thread.id, messageId: 'msg-1', topic: 'Mention test',
      senderAgentId: 'coordinator', participants: ['coordinator', 'agent-b', 'agent-c'],
      mentionedAgentIds: ['agent-b'], content: 'Hi', parentEventId: 'task-1',
    });
    await bus._trigger('agent.discuss', event);
    const tasks = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .filter(([_l, e]) => (e as { type: string }).type === 'agent.task')
      .map(([_l, e]) => e as { payload: { agentId: string; metadata: Record<string, unknown> } });
    const bTask = tasks.find(t => t.payload.agentId === 'agent-b');
    const cTask = tasks.find(t => t.payload.agentId === 'agent-c');
    expect(bTask?.payload.metadata?.mentioned).toBe(true);
    expect(cTask?.payload.metadata?.mentioned).toBe(false);
  });

  it('forwards originator from discuss event to task metadata', async () => {
    const { thread } = await bullpenService.openThread(
      'Originator test', 'coordinator', ['coordinator', 'agent-b'], 'Hi', ['agent-b'],
    );
    const originator = {
      contactId: 'ceo-contact-id',
      systemRole: 'principal' as const,
      channel: 'email',
      initiatedAt: '2026-05-01T10:00:00.000Z',
    };
    const event = createAgentDiscuss({
      threadId: thread.id, messageId: 'msg-1', topic: 'Originator test',
      senderAgentId: 'coordinator', participants: ['coordinator', 'agent-b'],
      mentionedAgentIds: ['agent-b'], content: 'Hi', originator, parentEventId: 'task-1',
    });
    await bus._trigger('agent.discuss', event);
    const task = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .find(([_l, e]) => (e as { type: string }).type === 'agent.task')?.[1] as
      { payload: { metadata: Record<string, unknown> } };
    expect(task?.payload.metadata?.originator).toEqual(originator);
  });

  it('omits originator from task metadata when discuss event has none and thread has none', async () => {
    const { thread } = await bullpenService.openThread(
      'No originator', 'coordinator', ['coordinator', 'agent-b'], 'Hi', [],
    );
    const event = createAgentDiscuss({
      threadId: thread.id, messageId: 'msg-1', topic: 'No originator',
      senderAgentId: 'coordinator', participants: ['coordinator', 'agent-b'],
      mentionedAgentIds: ['agent-b'], content: 'Hi', parentEventId: 'task-1',
    });
    await bus._trigger('agent.discuss', event);
    const task = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .find(([_l, e]) => (e as { type: string }).type === 'agent.task')?.[1] as
      { payload: { metadata: Record<string, unknown> } };
    // originator key should be absent — not present as undefined
    expect(task?.payload.metadata).not.toHaveProperty('originator');
  });

  it('uses thread stored originator as fallback when discuss event carries none', async () => {
    // Simulate the poll-fallback path: the original agent.discuss publish failed
    // so the event has no originator, but the thread was opened with one and it
    // is stored on bullpen_threads.
    const originator = {
      contactId: 'ceo-contact-id',
      systemRole: 'principal' as const,
      channel: 'email',
      initiatedAt: '2026-05-01T10:00:00.000Z',
    };
    const { thread } = await bullpenService.openThread(
      'Fallback test', 'coordinator', ['coordinator', 'agent-b'], 'Hi', ['agent-b'],
      originator,
    );
    // Event has no originator (simulates a reply on the poll-fallback path)
    const event = createAgentDiscuss({
      threadId: thread.id, messageId: 'msg-1', topic: 'Fallback test',
      senderAgentId: 'coordinator', participants: ['coordinator', 'agent-b'],
      mentionedAgentIds: ['agent-b'], content: 'Hi', parentEventId: 'task-1',
    });
    await bus._trigger('agent.discuss', event);
    const task = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .find(([_l, e]) => (e as { type: string }).type === 'agent.task')?.[1] as
      { payload: { metadata: Record<string, unknown> } };
    expect(task?.payload.metadata?.originator).toEqual(originator);
  });

  it('event originator takes precedence over thread stored originator', async () => {
    const threadOriginator = {
      contactId: 'original-contact-id',
      systemRole: 'principal' as const,
      channel: 'email',
      initiatedAt: '2026-05-01T10:00:00.000Z',
    };
    const eventOriginator = {
      contactId: 'override-contact-id',
      systemRole: 'principal' as const,
      channel: 'email',
      initiatedAt: '2026-05-02T12:00:00.000Z',
    };
    const { thread } = await bullpenService.openThread(
      'Precedence test', 'coordinator', ['coordinator', 'agent-b'], 'Hi', ['agent-b'],
      threadOriginator,
    );
    const event = createAgentDiscuss({
      threadId: thread.id, messageId: 'msg-1', topic: 'Precedence test',
      senderAgentId: 'coordinator', participants: ['coordinator', 'agent-b'],
      mentionedAgentIds: ['agent-b'], content: 'Hi', originator: eventOriginator,
      parentEventId: 'task-1',
    });
    await bus._trigger('agent.discuss', event);
    const task = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .find(([_l, e]) => (e as { type: string }).type === 'agent.task')?.[1] as
      { payload: { metadata: Record<string, unknown> } };
    expect(task?.payload.metadata?.originator).toEqual(eventOriginator);
  });

  it('skips task creation when thread message_count >= 100', async () => {
    const { thread } = await bullpenService.openThread(
      'Cap test', 'coordinator', ['coordinator', 'agent-b'], 'Start', [],
    );
    // Post 99 more to reach the cap (thread starts at 1)
    for (let i = 0; i < 99; i++) {
      await bullpenService.postMessage(thread.id, 'coordinator', `Msg ${i}`, []);
    }
    const event = createAgentDiscuss({
      threadId: thread.id, messageId: 'msg-cap', topic: 'Cap test',
      senderAgentId: 'coordinator', participants: ['coordinator', 'agent-b'],
      mentionedAgentIds: ['agent-b'], content: 'Over cap', parentEventId: 'task-1',
    });
    await bus._trigger('agent.discuss', event);
    // No tasks should be created (thread is at 100)
    const tasks = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .filter(([_l, e]) => (e as { type: string }).type === 'agent.task');
    expect(tasks).toHaveLength(0);
  });

  it('creates agent.task for originator when thread is closed via close_after (even with empty mentions)', async () => {
    // A close_after reply closes the thread atomically; the concluding message must
    // still wake other participants so consult hand-offs complete. (#1256)
    const { thread } = await bullpenService.openThread(
      'Scheduling consult', 'ceo-inbox', ['ceo-inbox', 'calendar'], 'CONSULT REQUEST', [],
    );
    await bullpenService.postMessage(thread.id, 'calendar', 'CONSULT REPLY\nResult: ok\n...', [], true);
    const event = createAgentDiscuss({
      threadId: thread.id, messageId: 'msg-closed', topic: 'Scheduling consult',
      senderAgentId: 'calendar', participants: ['ceo-inbox', 'calendar'],
      mentionedAgentIds: [], content: 'CONSULT REPLY\nResult: ok', threadClosed: true,
      parentEventId: 'task-1',
    });
    await bus._trigger('agent.discuss', event);
    const tasks = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .filter(([_l, e]) => (e as { type: string }).type === 'agent.task')
      .map(([_l, e]) => e as { payload: { agentId: string; content: string; metadata: Record<string, unknown> } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.payload.agentId).toBe('ceo-inbox');
    expect(tasks[0]!.payload.content).toContain('thread is now closed');
    expect(tasks[0]!.payload.content).toContain('get_thread');
    expect(tasks[0]!.payload.content).toContain('do not reply in-thread');
    expect(tasks[0]!.payload.content).not.toContain('reply using the bullpen skill');
    expect(tasks[0]!.payload.metadata?.threadClosed).toBe(true);
  });

  it('sets threadClosed false on open-thread dispatch tasks', async () => {
    const { thread } = await bullpenService.openThread(
      'Open thread', 'coordinator', ['coordinator', 'agent-b'], 'Hi', ['agent-b'],
    );
    const event = createAgentDiscuss({
      threadId: thread.id, messageId: 'msg-1', topic: 'Open thread',
      senderAgentId: 'coordinator', participants: ['coordinator', 'agent-b'],
      mentionedAgentIds: ['agent-b'], content: 'Hi', threadClosed: false,
      parentEventId: 'task-1',
    });
    await bus._trigger('agent.discuss', event);
    const task = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .find(([_l, e]) => (e as { type: string }).type === 'agent.task')?.[1] as
      { payload: { metadata: Record<string, unknown> } };
    expect(task?.payload.metadata?.threadClosed).toBe(false);
  });
});
