import { describe, it, expect, beforeEach, vi } from 'vitest';
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

  it('getPendingThreadsForAgent shows all messages when thread is within the window limit', async () => {
    const { thread } = await service.openThread('Test', 'coordinator', ['coordinator', 'agent-b'], 'Msg 1', []);
    for (let i = 2; i <= 8; i++) {
      await service.postMessage(thread.id, 'coordinator', `Msg ${i}`, []);
    }
    const pending = await service.getPendingThreadsForAgent('agent-b', 60);
    // 8 messages is below RECENT_MSG_LIMIT (15), so all are shown
    expect(pending[0]?.totalMessages).toBe(8);
    expect(pending[0]?.recentMessages).toHaveLength(8);
    expect(pending[0]?.recentMessages[7]?.content).toBe('Msg 8');
  });

  it('getPendingThreadsForAgent shows all messages without duplication at exactly the window limit', async () => {
    // 15 messages == RECENT_MSG_LIMIT: should take the "show all" path, not the pin path.
    const { thread } = await service.openThread('Boundary', 'coordinator', ['coordinator', 'agent-b'], 'Msg 1', []);
    for (let i = 2; i <= 15; i++) {
      await service.postMessage(thread.id, 'coordinator', `Msg ${i}`, []);
    }
    const pending = await service.getPendingThreadsForAgent('agent-b', 60);
    expect(pending[0]?.recentMessages).toHaveLength(15);
    // First message must appear exactly once (no duplication from the pin logic)
    expect(pending[0]?.recentMessages.filter(m => m.content === 'Msg 1')).toHaveLength(1);
    // totalMessages equals recentMessages.length — no truncation indicator needed
    expect(pending[0]?.totalMessages).toBe(pending[0]?.recentMessages.length);
  });

  it('getPendingThreadsForAgent pins the first message when a thread exceeds the window limit (#1090)', async () => {
    // Build a thread with 17 messages (> RECENT_MSG_LIMIT of 15).
    const { thread } = await service.openThread('Long thread', 'coordinator', ['coordinator', 'agent-b'], 'Msg 1', ['agent-b']);
    for (let i = 2; i <= 17; i++) {
      await service.postMessage(thread.id, 'coordinator', `Msg ${i}`, []);
    }
    const pending = await service.getPendingThreadsForAgent('agent-b', 60);
    expect(pending[0]?.totalMessages).toBe(17);
    // Exactly RECENT_MSG_LIMIT messages shown: first + last 14
    expect(pending[0]?.recentMessages).toHaveLength(15);
    // First message (original request) is always pinned
    expect(pending[0]?.recentMessages[0]?.content).toBe('Msg 1');
    // Followed by the last 14 messages (Msg 4 through Msg 17)
    expect(pending[0]?.recentMessages[1]?.content).toBe('Msg 4');
    // Last message is present
    expect(pending[0]?.recentMessages[14]?.content).toBe('Msg 17');
  });

  // Read watermark (#1065): a thread the agent has been shown stops re-surfacing until
  // a newer message arrives — so an out-of-band-handled request isn't re-actioned.
  it('markThreadsSeen suppresses a previously-pending thread for that agent', async () => {
    const { thread } = await service.openThread('Test', 'coordinator', ['coordinator', 'agent-b'], 'Hi', []);
    expect((await service.getPendingThreadsForAgent('agent-b', 60))).toHaveLength(1);

    await service.markThreadsSeen('agent-b', [thread.id]);
    expect((await service.getPendingThreadsForAgent('agent-b', 60))).toHaveLength(0);
  });

  it('markThreadsSeen is per-agent — other participants still see the thread', async () => {
    const { thread } = await service.openThread('Test', 'creator', ['creator', 'agent-b', 'agent-c'], 'Hi', []);
    await service.markThreadsSeen('agent-b', [thread.id]);
    expect((await service.getPendingThreadsForAgent('agent-b', 60))).toHaveLength(0);
    // agent-c never saw it, so it is still pending for them.
    expect((await service.getPendingThreadsForAgent('agent-c', 60)).map(t => t.threadId)).toContain(thread.id);
  });

  it('a new message re-surfaces a watermarked thread', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-21T10:00:00Z'));
    try {
      const { thread } = await service.openThread('Test', 'coordinator', ['coordinator', 'agent-b'], 'Hi', []);
      await service.markThreadsSeen('agent-b', [thread.id]);
      expect((await service.getPendingThreadsForAgent('agent-b', 60))).toHaveLength(0);

      // Newer activity advances last_message_at past the watermark.
      vi.setSystemTime(new Date('2026-06-21T10:05:00Z'));
      await service.postMessage(thread.id, 'coordinator', 'one more thing', []);
      const pending = await service.getPendingThreadsForAgent('agent-b', 60);
      expect(pending.map(t => t.threadId)).toContain(thread.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it('markThreadsSeen ignores unknown thread ids without throwing', async () => {
    await expect(service.markThreadsSeen('agent-b', ['00000000-0000-0000-0000-000000000000'])).resolves.toBeUndefined();
  });

  it('a watermarked multi-turn thread re-surfaces with the original request still in the recent window', async () => {
    // The watermark gates thread *visibility*, not individual messages. After contact has
    // seen the opening request and it is watermarked, a later reply must bring the thread
    // back WITH the original request still visible — otherwise the agent would act on "the
    // VC" with no idea what was being asked.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-21T10:00:00Z'));
    try {
      // ceo-inbox opens the thread with the original request (msg1).
      const { thread } = await service.openThread(
        'Debrief John Doe',
        'ceo-inbox',
        ['ceo-inbox', 'contact'],
        'debrief me about John Doe',
        ['contact'],
      );
      // contact is woken, sees msg1, and the runtime watermarks the thread for contact.
      await service.markThreadsSeen('contact', [thread.id]);
      expect(await service.getPendingThreadsForAgent('contact', 60)).toHaveLength(0);

      // contact asks a clarifying question (msg2), then ceo-inbox answers (msg3) — new
      // activity past contact's watermark.
      vi.setSystemTime(new Date('2026-06-21T10:01:00Z'));
      await service.postMessage(thread.id, 'contact', 'which John Doe?', ['ceo-inbox']);
      vi.setSystemTime(new Date('2026-06-21T10:02:00Z'));
      await service.postMessage(thread.id, 'ceo-inbox', 'the VC', ['contact']);

      // The thread re-surfaces for contact, and the recent window still carries the
      // original request alongside the new answer.
      const pending = await service.getPendingThreadsForAgent('contact', 60);
      expect(pending.map(t => t.threadId)).toContain(thread.id);
      const contents = pending[0]!.recentMessages.map(m => m.content);
      expect(contents).toContain('debrief me about John Doe');
      expect(contents).toContain('the VC');
    } finally {
      vi.useRealTimers();
    }
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

  it('shows "first + last N" header and middle-omitted hint when thread is truncated (#1090)', () => {
    // Simulate a thread where recentMessages holds first + last N (14 recent) of 20 total.
    const msgs = Array.from({ length: 15 }, (_, i) => ({
      senderAgentId: 'coordinator',
      content: `Msg ${i + 1}`,
      mentionedAgentIds: [] as string[],
      createdAt: new Date(i * 1000),
    }));
    const truncated: PendingThreadContext = {
      threadId: 'thread-2',
      topic: 'Long discussion',
      totalMessages: 20,
      recentMessages: msgs,
    };
    const out = formatBullpenContext([truncated]);
    // Header must name the composition, not just "showing last N"
    expect(out).toContain('first + last 14 of 20');
    // Middle-omission hint must be present
    expect(out).toContain('Middle messages omitted');
    // get_thread hint still present
    expect(out).toContain('get_thread');
  });
});
