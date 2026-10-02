// What a coordinator turn did, read off a real EventBus (#1956). Shared by the scenario
// suite and smoke, so both see tool calls, NO_REPLY and held replies the same way.
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../src/bus/bus.js';
import { createAgentResponse, createToolInvoke, createToolResult } from '../../../src/bus/events.js';
import { createLogger } from '../../../src/logger.js';
import { createTurnCapture, withoutRecentHistory } from '../../shared/turn-capture.js';

function setup(): { bus: EventBus; capture: ReturnType<typeof createTurnCapture> } {
  const bus = new EventBus(createLogger('error'));
  return { bus, capture: createTurnCapture(bus) };
}

async function respond(bus: EventBus, conversationId: string, content: string, extra: { suppressDelivery?: boolean; agentId?: string } = {}): Promise<void> {
  await bus.publish('agent', createAgentResponse({
    agentId: extra.agentId ?? 'coordinator',
    conversationId,
    content,
    ...(extra.suppressDelivery ? { suppressDelivery: true } : {}),
    parentEventId: 'task-1',
  }));
}

describe('createTurnCapture', () => {
  it('pairs each tool call with its result and ends on the coordinator response', async () => {
    const { bus, capture } = setup();
    const turn = capture.waitFor('conv-1', 5_000);

    const invoke = createToolInvoke({
      agentId: 'coordinator', conversationId: 'conv-1', toolName: 'contact-lookup',
      input: { name: 'Dana' }, taskEventId: 'task-1', parentEventId: 'task-1',
    });
    await bus.publish('agent', invoke);
    await bus.publish('execution', createToolResult({
      agentId: 'coordinator', conversationId: 'conv-1', toolName: 'contact-lookup',
      result: { success: false, error: 'not found' }, durationMs: 3, parentEventId: invoke.id,
    }));
    await respond(bus, 'conv-1', 'I could not find Dana.');

    const outcome = await turn;
    expect(outcome.reply).toBe('I could not find Dana.');
    expect(outcome.calls).toEqual([{
      name: 'contact-lookup',
      input: { name: 'Dana' },
      invokeEventId: invoke.id,
      result: { success: false, error: 'not found' },
    }]);
    expect(outcome.error).toBeUndefined();
  });

  it('restores an exact NO_REPLY the runtime lifted out of the content', async () => {
    const { bus, capture } = setup();
    const turn = capture.waitFor('conv-2', 5_000);
    await respond(bus, 'conv-2', '', { suppressDelivery: true });
    expect((await turn).reply).toBe('NO_REPLY');
  });

  it('ignores other agents and other conversations', async () => {
    const { bus, capture } = setup();
    const turn = capture.waitFor('conv-3', 5_000);
    await respond(bus, 'conv-3', 'specialist text', { agentId: 'research-analyst' });
    await respond(bus, 'other-conv', 'wrong conversation');
    await respond(bus, 'conv-3', 'the coordinator');
    expect((await turn).reply).toBe('the coordinator');
  });

  it('ends a turn that never answers with a timeout error', async () => {
    vi.useFakeTimers();
    try {
      const { capture } = setup();
      const turn = capture.waitFor('conv-4', 1_000);
      await vi.advanceTimersByTimeAsync(2_000);
      const outcome = await turn;
      expect(outcome.reply).toBeNull();
      expect(outcome.error).toMatch(/Timeout waiting for the coordinator \(1s\)/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a turn whose inbound could not be delivered', async () => {
    const { capture } = setup();
    const turn = capture.waitFor('conv-5', 5_000);
    capture.fail('conv-5', new Error('no subscriber'));
    expect((await turn).error).toBe('could not deliver the inbound: no subscriber');
  });
});

describe('withoutRecentHistory', () => {
  it('withholds contact recent history and delegates everything else', async () => {
    const real = {
      getContactRecentHistory: async (): Promise<string[]> => ['a leftover turn'],
      getHistory: async (): Promise<string[]> => ['this conversation'],
    };
    const view = withoutRecentHistory(real);
    expect(await view.getContactRecentHistory()).toEqual([]);
    expect(await view.getHistory()).toEqual(['this conversation']);
  });
});
