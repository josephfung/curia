import { describe, it, expect, beforeEach } from 'vitest';
import { BullpenService, formatBullpenContext } from '../../../src/memory/bullpen.js';
import type { PendingThreadContext } from '../../../src/memory/bullpen.js';

describe('BullpenService (in-memory)', () => {
  let service: BullpenService;

  beforeEach(() => {
    service = BullpenService.createInMemory();
  });

  it('opens a thread and returns thread + first message', async () => {
    const { thread, message } = await service.openThread(
      'Q2 planning',
      'coordinator',
      ['coordinator', 'calendar-agent'],
      'Can you check availability?',
      ['calendar-agent'],
    );
    expect(thread.id).toBeTruthy();
    expect(thread.topic).toBe('Q2 planning');
    expect(thread.creatorAgentId).toBe('coordinator');
    expect(thread.participants).toEqual(['coordinator', 'calendar-agent']);
    expect(thread.status).toBe('open');
    expect(thread.messageCount).toBe(1);
    expect(thread.lastMessageAt).toBeTruthy();
    expect(message.senderId).toBe('coordinator');
    expect(message.mentionedAgentIds).toEqual(['calendar-agent']);
  });

  it('posts a message and increments message_count', async () => {
    const { thread } = await service.openThread('Test', 'coordinator', ['coordinator', 'agent-b'], 'Hello', []);
    await service.postMessage(thread.id, 'agent-b', 'Reply', []);
    const result = await service.getThread(thread.id);
    expect(result?.thread.messageCount).toBe(2);
    expect(result?.messages).toHaveLength(2);
  });

  it('returns null for unknown thread', async () => {
    const result = await service.getThread('00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });

  it('throws when posting to a closed thread', async () => {
    const { thread } = await service.openThread('Test', 'coordinator', ['coordinator'], 'Hi', []);
    await service.closeThread(thread.id, 'coordinator');
    await expect(service.postMessage(thread.id, 'coordinator', 'Late reply', [])).rejects.toThrow('closed');
  });

  it('throws when posting to a capped thread (100 messages)', async () => {
    const { thread } = await service.openThread('Test', 'coordinator', ['coordinator'], 'Start', []);
    // Post 99 more to reach the cap (thread starts at 1)
    for (let i = 0; i < 99; i++) {
      await service.postMessage(thread.id, 'coordinator', `Message ${i}`, []);
    }
    await expect(service.postMessage(thread.id, 'coordinator', 'Over cap', [])).rejects.toThrow('message cap');
  });

  it('enforces close permission: only creator or coordinator may close', async () => {
    const { thread } = await service.openThread('Test', 'agent-b', ['agent-b', 'agent-c'], 'Hi', []);
    await expect(service.closeThread(thread.id, 'agent-c')).rejects.toThrow('not authorized');
  });

  it('allows coordinator to close any thread', async () => {
    const { thread } = await service.openThread('Test', 'agent-b', ['agent-b'], 'Hi', []);
    await expect(service.closeThread(thread.id, 'coordinator')).resolves.not.toThrow();
    const result = await service.getThread(thread.id);
    expect(result?.thread.status).toBe('closed');
  });

  it('postMessage with closeAfter=true posts the reply and closes the thread', async () => {
    const { thread } = await service.openThread('Test', 'coordinator', ['coordinator', 'agent-b'], 'Hello', []);
    const message = await service.postMessage(thread.id, 'agent-b', 'Concluding reply', [], true);
    const result = await service.getThread(thread.id);
    // The reply is written first and persists...
    expect(result?.thread.messageCount).toBe(2);
    expect(result?.messages.some(m => m.id === message.id)).toBe(true);
    // ...and the thread is closed atomically with it.
    expect(result?.thread.status).toBe('closed');
  });

  it('postMessage with closeAfter=false (default) leaves the thread open', async () => {
    const { thread } = await service.openThread('Test', 'coordinator', ['coordinator', 'agent-b'], 'Hello', []);
    await service.postMessage(thread.id, 'agent-b', 'Still talking', []);
    const result = await service.getThread(thread.id);
    expect(result?.thread.status).toBe('open');
  });

  it('postMessage with closeAfter=true allows a non-creator participant to close', async () => {
    // close_after is a soft conclusion signal available to any replying participant,
    // unlike the explicit `close` action which is restricted to creator/coordinator.
    const { thread } = await service.openThread('Test', 'agent-a', ['agent-a', 'agent-b'], 'Hi', []);
    await service.postMessage(thread.id, 'agent-b', 'Done here', [], true);
    const result = await service.getThread(thread.id);
    expect(result?.thread.status).toBe('closed');
  });

  it('postMessage with closeAfter=true rejects (and does not close) a closed thread', async () => {
    const { thread } = await service.openThread('Test', 'coordinator', ['coordinator'], 'Hi', []);
    await service.closeThread(thread.id, 'coordinator');
    await expect(service.postMessage(thread.id, 'coordinator', 'Late', [], true)).rejects.toThrow('closed');
  });

  it('getPendingThreadsForAgent returns only threads where latest sender is not the agent', async () => {
    const { thread } = await service.openThread(
      'Pending test',
      'coordinator',
      ['coordinator', 'agent-b'],
      'What do you think?',
      ['agent-b'],
    );
    // coordinator posted last — agent-b has a pending thread
    const pending = await service.getPendingThreadsForAgent('agent-b', 60);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.threadId).toBe(thread.id);
    expect(pending[0]?.topic).toBe('Pending test');
  });

  it('getPendingThreadsForAgent excludes threads where agent posted last', async () => {
    const { thread } = await service.openThread('Test', 'coordinator', ['coordinator', 'agent-b'], 'Hi', []);
    await service.postMessage(thread.id, 'agent-b', 'Replied', []);
    const pending = await service.getPendingThreadsForAgent('agent-b', 60);
    expect(pending).toHaveLength(0);
  });

  it('getPendingThreadsForAgent excludes closed threads', async () => {
    const { thread } = await service.openThread('Test', 'coordinator', ['coordinator', 'agent-b'], 'Hi', []);
    await service.closeThread(thread.id, 'coordinator');
    const pending = await service.getPendingThreadsForAgent('agent-b', 60);
    expect(pending).toHaveLength(0);
  });

  it('getPendingThreadsForAgent includes up to 5 recent messages per thread', async () => {
    const { thread } = await service.openThread('Test', 'coordinator', ['coordinator', 'agent-b'], 'Msg 1', []);
    for (let i = 2; i <= 8; i++) {
      await service.postMessage(thread.id, 'coordinator', `Msg ${i}`, []);
    }
    const pending = await service.getPendingThreadsForAgent('agent-b', 60);
    expect(pending[0]?.totalMessages).toBe(8);
    expect(pending[0]?.recentMessages).toHaveLength(5);
    // Should be the last 5 messages
    expect(pending[0]?.recentMessages[4]?.content).toBe('Msg 8');
  });
});

describe('formatBullpenContext', () => {
  function makePending(): PendingThreadContext {
    return {
      threadId: 'thread-1',
      topic: 'Q2 planning',
      totalMessages: 1,
      recentMessages: [
        { senderAgentId: 'coordinator', content: 'What do you think?', mentionedAgentIds: [], createdAt: new Date(0) },
      ],
    };
  }

  it('returns empty string when there are no pending threads', () => {
    expect(formatBullpenContext([])).toBe('');
  });

  it('includes the close_after convention note when threads are present', () => {
    const out = formatBullpenContext([makePending()]);
    expect(out).toContain('close_after');
  });
});
