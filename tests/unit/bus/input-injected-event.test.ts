// agent.task.input_injected — a same-contact follow-up drained into a live turn (#2018).
import { describe, it, expect } from 'vitest';
import { createAgentTaskInputInjected, isInjectionDrainPoint } from '../../../src/bus/events.js';
import { canPublish, canSubscribe } from '../../../src/bus/permissions.js';

const HOST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INBOUND = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SENDER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function payload() {
  return {
    hostTaskEventId: HOST,
    inboundEventId: INBOUND,
    conversationId: 'signal:+15551212',
    agentId: 'coordinator',
    drainPoint: 'round:0' as const,
    senderContactId: SENDER,
  };
}

describe('agent.task.input_injected', () => {
  it('sets parentEventId to the inbound and copies only the named fields', () => {
    const event = createAgentTaskInputInjected({
      ...payload(),
      content: 'words from another contact',
      originalContent: 'also not this event',
      senderLabel: 'Dana',
    } as ReturnType<typeof payload>);
    expect(event.type).toBe('agent.task.input_injected');
    expect(event.sourceLayer).toBe('agent');
    expect(event.parentEventId).toBe(INBOUND);
    expect(event.payload).toEqual(payload());
    expect(JSON.stringify(event.payload)).not.toContain('another contact');
    expect(event.payload).not.toHaveProperty('content');
  });

  it('rejects an empty id and a drain point that is not a round', () => {
    expect(() => createAgentTaskInputInjected({ ...payload(), inboundEventId: '' })).toThrow(/inboundEventId/);
    expect(() => createAgentTaskInputInjected({
      ...payload(),
      senderContactId: { length: 4, content: 'secret words' } as unknown as string,
    })).toThrow(/senderContactId/);
    expect(() => createAgentTaskInputInjected({
      ...payload(),
      hostTaskEventId: undefined as unknown as string,
    })).toThrow(/hostTaskEventId/);
    expect(() => createAgentTaskInputInjected({
      ...payload(),
      drainPoint: 'round:01' as 'round:0',
    })).toThrow(/drainPoint/);
    expect(() => createAgentTaskInputInjected({
      ...payload(),
      drainPoint: 'turn_start\ninjected' as 'turn_start',
    })).toThrow(/drainPoint/);
    expect(isInjectionDrainPoint('turn_start')).toBe(true);
    expect(isInjectionDrainPoint('exit')).toBe(true);
    expect(isInjectionDrainPoint('round:0')).toBe(true);
    expect(isInjectionDrainPoint('round:12')).toBe(true);
    expect(isInjectionDrainPoint('round:')).toBe(false);
    expect(isInjectionDrainPoint('round:-1')).toBe(false);
  });

  it('is published by the agent and system, and read only by system', () => {
    expect(canPublish('agent', 'agent.task.input_injected')).toBe(true);
    expect(canPublish('system', 'agent.task.input_injected')).toBe(true);
    expect(canSubscribe('system', 'agent.task.input_injected')).toBe(true);
    expect(canPublish('channel', 'agent.task.input_injected')).toBe(false);
    expect(canPublish('dispatch', 'agent.task.input_injected')).toBe(false);
    expect(canSubscribe('agent', 'agent.task.input_injected')).toBe(false);
    expect(canSubscribe('channel', 'agent.task.input_injected')).toBe(false);
  });
});
