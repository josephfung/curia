import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BULLPEN_PENDING_WINDOW_MINUTES,
  BullpenService,
  formatBullpenContext,
  pendingThreadWatermarkSnapshot,
  selectThreadsToWatermark,
  toBullpenToolTouch,
} from '../../../src/memory/bullpen.js';
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

  // Both rows are required. A 90-minute-old exclusion alone also passes when the
  // argument is read as milliseconds (everything is outside a 60ms window).
  it('getPendingThreadsForAgent applies the window in minutes (#1899)', async () => {
    vi.useFakeTimers();
    const t0 = new Date('2026-09-24T12:00:00Z');
    try {
      vi.setSystemTime(t0);
      const { thread: outside } = await service.openThread('Outside', 'coordinator', ['coordinator', 'agent-b'], 'old', []);
      vi.setSystemTime(new Date(t0.getTime() + 60 * 60 * 1000));
      const { thread: inside } = await service.openThread('Inside', 'coordinator', ['coordinator', 'agent-b'], 'newer', []);
      // Query 90 minutes after the older thread: it is outside a 60-minute window,
      // the newer thread is 30 minutes old and inside it.
      vi.setSystemTime(new Date(t0.getTime() + 90 * 60 * 1000));
      const ids = (await service.getPendingThreadsForAgent('agent-b', 60)).map(t => t.threadId);
      expect(ids).toContain(inside.id);
      expect(ids).not.toContain(outside.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it('default window still returns a thread many hours old and drops one past seven days (#1899)', async () => {
    vi.useFakeTimers();
    const queryAt = new Date('2026-09-24T12:00:00Z');
    try {
      vi.setSystemTime(new Date(queryAt.getTime() - 8 * 24 * 60 * 60 * 1000));
      const { thread: abandoned } = await service.openThread('Abandoned', 'coordinator', ['coordinator', 'agent-b'], 'weeks old', []);
      vi.setSystemTime(new Date(queryAt.getTime() - 11 * 60 * 60 * 1000));
      const { thread: recent } = await service.openThread('Recent', 'coordinator', ['coordinator', 'agent-b'], 'hours old', []);
      vi.setSystemTime(queryAt);
      const ids = (await service.getPendingThreadsForAgent('agent-b', BULLPEN_PENDING_WINDOW_MINUTES)).map(t => t.threadId);
      expect(ids).toContain(recent.id);
      expect(ids).not.toContain(abandoned.id);
    } finally {
      vi.useRealTimers();
    }
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

  it('keeps the oldest eligible thread when more than five are pending (#1899)', async () => {
    vi.useFakeTimers();
    const queryAt = new Date('2026-09-24T12:00:00Z');
    try {
      for (let ageDays = 6; ageDays >= 1; ageDays--) {
        vi.setSystemTime(new Date(queryAt.getTime() - ageDays * 24 * 60 * 60 * 1000));
        await service.openThread(
          `age-${ageDays}`,
          'coordinator',
          ['coordinator', 'agent-b'],
          `message ${ageDays}`,
          [],
        );
      }
      vi.setSystemTime(queryAt);
      const topics = (await service.getPendingThreadsForAgent('agent-b', BULLPEN_PENDING_WINDOW_MINUTES)).map(t => t.topic);
      // 6 days is the oldest; 1–4 days are the four newest. 5 days is the one crowded out.
      expect(topics).toEqual(expect.arrayContaining(['age-6', 'age-1', 'age-2', 'age-3', 'age-4']));
      expect(topics).not.toContain('age-5');
      expect(topics).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not give the oldest slot to a handoff already shown and left untouched (#1901)', async () => {
    vi.useFakeTimers();
    const queryAt = new Date('2026-09-24T12:00:00Z');
    try {
      const opened = new Map<number, { id: string; shownThrough: Date }>();
      for (let ageDays = 6; ageDays >= 1; ageDays--) {
        vi.setSystemTime(new Date(queryAt.getTime() - ageDays * 24 * 60 * 60 * 1000));
        const { thread } = await service.openThread(
          `age-${ageDays}`,
          'coordinator',
          ['coordinator', 'agent-b'],
          `message ${ageDays}`,
          ['agent-b'],
        );
        opened.set(ageDays, { id: thread.id, shownThrough: thread.lastMessageAt! });
      }
      const oldest = opened.get(6)!;
      await service.recordUnhandledInjection('agent-b', [{ threadId: oldest.id, shownThrough: oldest.shownThrough }]);
      vi.setSystemTime(queryAt);
      const topics = (await service.getPendingThreadsForAgent('agent-b', BULLPEN_PENDING_WINDOW_MINUTES)).map(t => t.topic);
      // age-6 was already shown, so the age slot moves to age-5. The four newest stay.
      expect(topics).toEqual(expect.arrayContaining(['age-5', 'age-1', 'age-2', 'age-3', 'age-4']));
      expect(topics).not.toContain('age-6');
      expect(topics).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps five slots when every thread older than the four newest was already shown (#1901)', async () => {
    vi.useFakeTimers();
    const queryAt = new Date('2026-09-24T12:00:00Z');
    try {
      const opened = new Map<number, { id: string; shownThrough: Date }>();
      // Hours, not days: a thread exactly seven days old is outside the window.
      for (let ageHours = 70; ageHours >= 10; ageHours -= 10) {
        vi.setSystemTime(new Date(queryAt.getTime() - ageHours * 60 * 60 * 1000));
        const { thread } = await service.openThread(
          `age-${ageHours}`,
          'coordinator',
          ['coordinator', 'agent-b'],
          `message ${ageHours}`,
          ['agent-b'],
        );
        opened.set(ageHours, { id: thread.id, shownThrough: thread.lastMessageAt! });
      }
      await service.recordUnhandledInjection('agent-b', [50, 60, 70].map(ageHours => {
        const openedThread = opened.get(ageHours)!;
        return { threadId: openedThread.id, shownThrough: openedThread.shownThrough };
      }));
      vi.setSystemTime(queryAt);
      const topics = (await service.getPendingThreadsForAgent('agent-b', BULLPEN_PENDING_WINDOW_MINUTES)).map(t => t.topic);
      // No unseen thread sits outside the four newest, so the oldest already-shown
      // thread fills the fifth slot and can receive its second look.
      expect(topics).toEqual(expect.arrayContaining(['age-70', 'age-10', 'age-20', 'age-30', 'age-40']));
      expect(topics).not.toContain('age-50');
      expect(topics).not.toContain('age-60');
      expect(topics).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
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

  it('markThreadsSeen stops at the message the agent was shown (#1901)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-21T10:00:00Z'));
    try {
      const { thread } = await service.openThread('Test', 'coordinator', ['coordinator', 'agent-b'], 'Hi', ['agent-b']);
      const shown = thread.lastMessageAt!;
      vi.setSystemTime(new Date('2026-06-21T10:05:00Z'));
      await service.postMessage(thread.id, 'coordinator', 'please handle this too', ['agent-b']);
      await service.markThreadsSeen('agent-b', [thread.id], new Map([[thread.id, shown]]));
      const pending = await service.getPendingThreadsForAgent('agent-b', 60);
      expect(pending.map(t => t.threadId)).toContain(thread.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recordUnhandledInjection leaves the thread pending and marks it already shown (#1901)', async () => {
    const { thread } = await service.openThread('Test', 'coordinator', ['coordinator', 'agent-b'], 'Hi', ['agent-b']);
    await service.recordUnhandledInjection('agent-b', [{ threadId: thread.id, shownThrough: thread.lastMessageAt! }]);
    const pending = await service.getPendingThreadsForAgent('agent-b', 60);
    expect(pending.map(t => t.threadId)).toContain(thread.id);
    expect(pending[0]?.alreadyInjected).toBe(true);
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

  it('stamps each message in the principal timezone (#1899)', () => {
    const pending = makePending();
    pending.recentMessages[0]!.createdAt = new Date('2026-09-24T23:40:00Z');
    const out = formatBullpenContext([pending], 'America/Toronto');
    expect(out).toContain('2026-09-24T19:40:00.000-04:00');
  });

  it('tells the model ambient threads are answered in-thread (#1899)', () => {
    const out = formatBullpenContext([makePending()]);
    expect(out).toContain('ambient internal threads');
    expect(out).toContain('bullpen tools');
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

describe('selectThreadsToWatermark (#1901)', () => {
  const shownAt = new Date('2026-09-25T12:00:00Z');
  const mention = 'zzzz handled-beta-1901-token zzzz relay this mention out of band zzzz';
  const other = 'qqqq ignored-alpha-1901-token qqqq keep this mention pending qqqq';

  const handled = {
    threadId: 'handled',
    mentionsAgent: true,
    handoffText: mention,
    shownThrough: shownAt,
    alreadyInjected: false,
  };
  const ignored = {
    threadId: 'ignored',
    mentionsAgent: true,
    handoffText: other,
    shownThrough: shownAt,
    alreadyInjected: false,
  };
  const fyi = {
    threadId: 'fyi',
    mentionsAgent: false,
    shownThrough: shownAt,
    alreadyInjected: false,
  };

  function watermarkIds(decision: ReturnType<typeof selectThreadsToWatermark>): string[] {
    return decision.watermark.map(stamp => stamp.threadId);
  }
  function deferIds(decision: ReturnType<typeof selectThreadsToWatermark>): string[] {
    return decision.defer.map(stamp => stamp.threadId);
  }

  it('keeps an untouched ambient @mention and stamps a non-mention plus the woke thread', () => {
    const decision = selectThreadsToWatermark({
      wokeThreadId: 'woke',
      wokeShownThrough: shownAt,
      ambient: [handled, ignored, fyi],
      toolTouches: [],
    });
    expect(watermarkIds(decision)).toEqual(['woke', 'fyi']);
    expect(deferIds(decision)).toEqual(['handled', 'ignored']);
    expect(decision.watermark[0]?.shownThrough).toEqual(shownAt);
  });

  it('stamps only the ambient @mention whose text an out-of-band call carried', () => {
    const decision = selectThreadsToWatermark({
      ambient: [handled, ignored],
      toolTouches: [{ name: 'signal-send', input: { message: mention }, success: true }],
    });
    expect(watermarkIds(decision)).toEqual(['handled']);
    expect(deferIds(decision)).toEqual(['ignored']);
  });

  it('does not let a shared template prefix stamp the other handoff', () => {
    const prefix = 'message to send: your meeting with ';
    const lisa = `${prefix}Lisa at three about the board pack and the decision log`;
    const bob = `${prefix}Bob at four about the budget review and the hiring plan`;
    const lisaThread = { ...handled, threadId: 'lisa', handoffText: lisa };
    const bobThread = { ...ignored, threadId: 'bob', handoffText: bob };
    const decision = selectThreadsToWatermark({
      ambient: [lisaThread, bobThread],
      toolTouches: [{ name: 'signal-send', input: { message: lisa }, success: true }],
    });
    expect(watermarkIds(decision)).toEqual(['lisa']);
    expect(deferIds(decision)).toEqual(['bob']);
  });

  it('stamps a bullpen reply or close and ignores a read of the same thread', () => {
    expect(watermarkIds(selectThreadsToWatermark({
      ambient: [handled],
      toolTouches: [{ name: 'bullpen', input: { action: 'reply', thread_id: 'handled', content: 'done' }, success: true }],
    }))).toEqual(['handled']);
    expect(watermarkIds(selectThreadsToWatermark({
      ambient: [handled],
      toolTouches: [{ name: 'bullpen', input: { action: 'close', thread_id: 'handled' }, success: true }],
    }))).toEqual(['handled']);
    const read = selectThreadsToWatermark({
      ambient: [handled],
      toolTouches: [{ name: 'bullpen', input: { action: 'get_thread', thread_id: 'handled' }, success: true }],
    });
    expect(watermarkIds(read)).toEqual([]);
    expect(deferIds(read)).toEqual(['handled']);
    const otherThread = selectThreadsToWatermark({
      ambient: [handled],
      toolTouches: [{ name: 'bullpen', input: { action: 'reply', thread_id: 'someone-else' }, success: true }],
    });
    expect(watermarkIds(otherThread)).toEqual([]);
    expect(deferIds(otherThread)).toEqual(['handled']);
  });

  it('does not treat a failed or soft-failed call as handling', () => {
    const touch = toBullpenToolTouch('signal-send', { message: mention }, { success: false });
    expect(touch.success).toBe(false);
    const failed = selectThreadsToWatermark({ ambient: [handled], toolTouches: [touch] });
    expect(watermarkIds(failed)).toEqual([]);
    expect(deferIds(failed)).toEqual(['handled']);

    const soft = toBullpenToolTouch('delegate', { task: mention }, { success: true, data: { failed: true } });
    expect(soft.success).toBe(false);
    const softFailed = selectThreadsToWatermark({ ambient: [handled], toolTouches: [soft] });
    expect(watermarkIds(softFailed)).toEqual([]);
    expect(deferIds(softFailed)).toEqual(['handled']);
  });

  it('stamps an untouched @mention the second time the same messages are shown', () => {
    const decision = selectThreadsToWatermark({
      ambient: [{ ...ignored, alreadyInjected: true }],
      toolTouches: [],
    });
    expect(watermarkIds(decision)).toEqual(['ignored']);
    expect(deferIds(decision)).toEqual([]);
  });

  it('keeps a handoff open when a later message drops the @mention', () => {
    const earlier = new Date('2026-09-25T11:00:00Z');
    const later = new Date('2026-09-25T12:00:00Z');
    const snapshot = pendingThreadWatermarkSnapshot('coordinator', {
      threadId: 't1',
      topic: 'topic',
      totalMessages: 2,
      recentMessages: [
        {
          senderAgentId: 'meeting-debrief',
          content: mention,
          mentionedAgentIds: ['coordinator'],
          createdAt: earlier,
        },
        {
          senderAgentId: 'meeting-debrief',
          content: 'adding the attendee list',
          mentionedAgentIds: [],
          createdAt: later,
        },
      ],
    });
    expect(snapshot.mentionsAgent).toBe(true);
    expect(snapshot.handoffText).toBe(mention);
    expect(snapshot.shownThrough).toEqual(later);
  });

  it('does not treat the agent echoing its own earlier note as handling the mention', () => {
    const ownNote = 'weekly status paragraph the coordinator already posted in this thread last week';
    const snapshot = pendingThreadWatermarkSnapshot('coordinator', {
      threadId: 't1',
      topic: 'topic',
      totalMessages: 2,
      recentMessages: [
        {
          senderAgentId: 'coordinator',
          content: ownNote,
          mentionedAgentIds: [],
          createdAt: new Date('2026-09-25T10:00:00Z'),
        },
        {
          senderAgentId: 'meeting-debrief',
          content: mention,
          mentionedAgentIds: ['coordinator'],
          createdAt: shownAt,
        },
      ],
    });
    expect(snapshot.handoffText).toBe(mention);
    const decision = selectThreadsToWatermark({
      ambient: [snapshot],
      toolTouches: [{ name: 'signal-send', input: { message: ownNote }, success: true }],
    });
    expect(watermarkIds(decision)).toEqual([]);
    expect(deferIds(decision)).toEqual(['t1']);
  });

  it('treats messages after the agent last posted as the open span', () => {
    const snapshot = pendingThreadWatermarkSnapshot('coordinator', {
      threadId: 't1',
      topic: 'topic',
      totalMessages: 3,
      recentMessages: [
        {
          senderAgentId: 'meeting-debrief',
          content: mention,
          mentionedAgentIds: ['coordinator'],
          createdAt: new Date('2026-09-25T10:00:00Z'),
        },
        {
          senderAgentId: 'coordinator',
          content: 'relayed',
          mentionedAgentIds: [],
          createdAt: new Date('2026-09-25T11:00:00Z'),
        },
        {
          senderAgentId: 'meeting-debrief',
          content: 'adding the attendee list',
          mentionedAgentIds: [],
          createdAt: shownAt,
        },
      ],
    });
    expect(snapshot.mentionsAgent).toBe(false);
    expect(snapshot.handoffText).toBeUndefined();
  });
});
