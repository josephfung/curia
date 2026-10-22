// Voice tool calls in audit_log (#1968): the same tool.invoke / tool.result pair a
// text turn publishes, chained under the spoken turn.

import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../../src/bus/bus.js';
import type { BusEvent, ToolInvokeEvent, ToolResultEvent } from '../../../../src/bus/events.js';
import { invokeVoiceToolAudited } from '../../../../src/channels/voice/voice-tool-audit.js';
import { createSilentLogger } from '../../../../src/logger.js';

function recordingBus(): { bus: EventBus; events: BusEvent[] } {
  const bus = new EventBus(createSilentLogger());
  const events: BusEvent[] = [];
  bus.subscribe('tool.invoke', 'system', async e => { events.push(e); });
  bus.subscribe('tool.result', 'system', async e => { events.push(e); });
  return { bus, events };
}

const call = { id: 'c1', name: 'task-list', input: { status: 'open' } };

describe('invokeVoiceToolAudited', () => {
  it('publishes tool.invoke before the call and tool.result after, chained under the turn', async () => {
    const { bus, events } = recordingBus();
    const seenParent: string[] = [];
    const result = await invokeVoiceToolAudited({
      bus,
      call,
      conversationId: 'voice:s1',
      sessionId: 's1',
      turnEventId: 'inbound-1',
      invoke: async (invokeEventId) => {
        // The tool runs only after its invoke is on record.
        expect(events.map(e => e.type)).toEqual(['tool.invoke']);
        seenParent.push(invokeEventId);
        return { success: true, data: { items: [] } };
      },
    });

    expect(result).toEqual({ success: true, data: { items: [] } });
    const [invoke, done] = events as [ToolInvokeEvent, ToolResultEvent];
    expect(invoke.type).toBe('tool.invoke');
    expect(invoke.parentEventId).toBe('inbound-1');
    expect(invoke.payload).toEqual({
      agentId: 'coordinator',
      conversationId: 'voice:s1',
      toolName: 'task-list',
      input: { status: 'open' },
      taskEventId: 's1',
    });
    // ExecutionLayer's own events chain under the invoke.
    expect(seenParent).toEqual([invoke.id]);
    expect(done.type).toBe('tool.result');
    expect(done.parentEventId).toBe(invoke.id);
    expect(done.payload).toMatchObject({
      agentId: 'coordinator',
      conversationId: 'voice:s1',
      toolName: 'task-list',
      result: { success: true, data: { items: [] } },
      routingTaskId: 's1',
    });
    expect(done.payload.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records a failed call with its error and errorType', async () => {
    const { bus, events } = recordingBus();
    await invokeVoiceToolAudited({
      bus,
      call,
      conversationId: 'voice:s1',
      sessionId: 's1',
      turnEventId: 'inbound-1',
      invoke: async () => ({ success: false, error: 'db down', errorType: 'DATABASE_UNAVAILABLE' }),
    });
    expect((events[1] as ToolResultEvent).payload.result).toEqual({
      success: false,
      error: 'db down',
      errorType: 'DATABASE_UNAVAILABLE',
    });
  });

  it('parents the invoke on the session when the turn has no inbound.message', async () => {
    const { bus, events } = recordingBus();
    await invokeVoiceToolAudited({
      bus,
      call,
      conversationId: 'voice:s1',
      sessionId: 's1',
      invoke: async () => ({ success: true, data: null }),
    });
    expect(events[0]!.parentEventId).toBe('s1');
  });

  it('does not run the tool when its invoke cannot be recorded', async () => {
    const bus = { publish: vi.fn(async () => { throw new Error('audit write failed'); }) } as unknown as EventBus;
    const invoke = vi.fn(async () => ({ success: true as const, data: null }));
    await expect(invokeVoiceToolAudited({
      bus,
      call,
      conversationId: 'voice:s1',
      sessionId: 's1',
      invoke,
    })).rejects.toThrow('audit write failed');
    expect(invoke).not.toHaveBeenCalled();
  });
});
