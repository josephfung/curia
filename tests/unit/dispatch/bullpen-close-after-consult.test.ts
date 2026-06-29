import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BullpenDispatcher } from '../../../src/dispatch/bullpen-dispatcher.js';
import { BullpenService } from '../../../src/memory/bullpen.js';
import { createLogger } from '../../../src/logger.js';
import { createAgentDiscuss } from '../../../src/bus/events.js';
import type { EventBus } from '../../../src/bus/bus.js';

// Regression for #1256: calendar closes a scheduling consult with close_after;
// ceo-inbox must be woken so Branch A can draft (not wait for consult-timeout).

function makeBus() {
  const handlers = new Map<string, ((event: unknown) => void)[]>();
  return {
    subscribe: vi.fn((type: string, _layer: string, handler: (event: unknown) => void) => {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    }),
    publish: vi.fn(async () => undefined),
    _trigger: async (type: string, event: unknown) => {
      for (const h of handlers.get(type) ?? []) await h(event);
    },
  };
}

const CONSULT_REPLY = [
  'CONSULT REPLY',
  'Result: ok',
  'Slots:',
  '  - Thursday June 25 at 10:30 AM ET (7:30 AM PT their time) - hold placed',
  '  - Friday June 26 at 2:00 PM ET (11:00 AM PT their time) - hold placed',
].join('\n');

describe('bullpen close_after scheduling consult regression (#1256)', () => {
  let bus: ReturnType<typeof makeBus>;
  let bullpenService: BullpenService;

  beforeEach(() => {
    bus = makeBus();
    bullpenService = BullpenService.createInMemory();
    const dispatcher = new BullpenDispatcher(bus as unknown as EventBus, createLogger('error'), bullpenService);
    dispatcher.register();
  });

  it('wakes ceo-inbox when calendar closes consult with Result: ok and empty mentions', async () => {
    const { thread } = await bullpenService.openThread(
      'Scheduling: coffee with Alice',
      'ceo-inbox',
      ['ceo-inbox', 'calendar'],
      'CONSULT REQUEST\nContext: source_message_id=msg-sched-1',
      [],
    );
    await bullpenService.postMessage(thread.id, 'calendar', CONSULT_REPLY, [], true);

    const event = createAgentDiscuss({
      threadId: thread.id,
      messageId: 'reply-1',
      topic: 'Scheduling: coffee with Alice',
      senderAgentId: 'calendar',
      participants: ['ceo-inbox', 'calendar'],
      mentionedAgentIds: [],
      content: CONSULT_REPLY,
      threadClosed: true,
      parentEventId: 'calendar-task-1',
    });
    await bus._trigger('agent.discuss', event);

    const tasks = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .filter(([_l, e]) => (e as { type: string }).type === 'agent.task')
      .map(([_l, e]) => e as { payload: { agentId: string; content: string; metadata: Record<string, unknown> } });

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.payload.agentId).toBe('ceo-inbox');
    expect(tasks[0]!.payload.metadata.threadClosed).toBe(true);
    expect(tasks[0]!.payload.content.toLowerCase()).toContain('do not reply in-thread');
    expect(tasks[0]!.payload.content).toContain('get_thread');
  });
});
