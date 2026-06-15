// secret-capture-resume-subscriber.test.ts — unit tests for the #972 resume subscriber.
// No DB, no real bus: a fake bus records subscriptions/publishes and lets a test emit events.

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { SecretCaptureResumeSubscriber } from './secret-capture-resume-subscriber.js';
import type { EventBus } from '../bus/bus.js';
import type { BusEvent, Layer, EventType, AgentTaskEvent } from '../bus/events.js';
import { createSecretCaptured } from '../bus/events.js';

function fakeBus() {
  const handlers = new Map<EventType, Array<(e: BusEvent) => unknown>>();
  const published: Array<{ layer: Layer; event: BusEvent }> = [];
  const bus = {
    subscribe(type: EventType, _layer: Layer, handler: (e: BusEvent) => unknown) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    async publish(layer: Layer, event: BusEvent) {
      published.push({ layer, event });
    },
  } as unknown as EventBus;
  async function emit(event: BusEvent) {
    for (const h of handlers.get(event.type) ?? []) await h(event);
  }
  return { bus, published, emit };
}

const ORIGINATOR = { contactId: 'ceo', systemRole: 'principal', channel: 'email', initiatedAt: 't' };

function fullEvent() {
  return createSecretCaptured(
    {
      secretName: 'user.aeroplan_password',
      label: 'Aeroplan password',
      conversationId: 'conv-1',
      agentId: 'coordinator',
      channelId: 'email',
      taskEventId: 'task-evt-9',
      resumeIntent: 'check the Aeroplan balance',
      originator: ORIGINATOR,
    },
    'task-evt-9',
  );
}

function makeSubscriber() {
  const { bus, published, emit } = fakeBus();
  const sub = new SecretCaptureResumeSubscriber(bus, pino({ level: 'silent' }));
  sub.start();
  return { published, emit };
}

describe('SecretCaptureResumeSubscriber', () => {
  it('re-enters the originating agent via a synthetic agent.task with parentEventId threaded', async () => {
    const { published, emit } = makeSubscriber();
    await emit(fullEvent());

    expect(published).toHaveLength(1);
    const { layer, event } = published[0]!;
    expect(layer).toBe('system');
    expect(event.type).toBe('agent.task');
    const task = event as AgentTaskEvent;
    expect(task.payload.agentId).toBe('coordinator');
    expect(task.payload.conversationId).toBe('conv-1');
    expect(task.payload.channelId).toBe('email');
    // senderId attributes the resumed turn to whoever started the chain (the originator).
    expect(task.payload.senderId).toBe('ceo');
    // parentEventId threads back to the originating agent.task for causal tracing.
    expect(task.parentEventId).toBe('task-evt-9');
    // originator is preserved so authorization/identity gates still resolve on the resumed task.
    expect(task.payload.metadata).toEqual({ originator: ORIGINATOR });
    // The content tells the agent what arrived + the original intent so it can reason about
    // completeness from its own conversation history.
    expect(task.payload.content).toContain('Aeroplan password');
    expect(task.payload.content).toContain('check the Aeroplan balance');
  });

  it('does not double-dispatch on duplicate event delivery', async () => {
    const { published, emit } = makeSubscriber();
    const event = fullEvent();
    await emit(event);
    await emit(event); // same event id delivered twice
    expect(published).toHaveLength(1);
  });

  it('skips (no dispatch) when essential routing is missing', async () => {
    const { published, emit } = makeSubscriber();
    // A token minted outside an agent context has no agentId — nothing to route a resume to.
    await emit(createSecretCaptured({
      secretName: 'user.x',
      label: 'X',
      conversationId: 'conv-1',
      channelId: 'email',
      // agentId intentionally absent
    }));
    expect(published).toHaveLength(0);
  });

  it('falls back to a generic sender when no originator is present', async () => {
    const { published, emit } = makeSubscriber();
    await emit(createSecretCaptured({
      secretName: 'user.x',
      label: 'X',
      conversationId: 'conv-1',
      agentId: 'coordinator',
      channelId: 'email',
    }));
    expect(published).toHaveLength(1);
    const task = published[0]!.event as AgentTaskEvent;
    expect(typeof task.payload.senderId).toBe('string');
    expect(task.payload.senderId.length).toBeGreaterThan(0);
    expect(task.payload.metadata).toBeUndefined();
  });

  it('never leaks a secret value (the event carries none; content is name/intent only)', async () => {
    const { published, emit } = makeSubscriber();
    await emit(fullEvent());
    // Sanity: the payload only ever references the vault key/label/intent — there is no value
    // anywhere in the chain to leak, and the content is built from names only.
    expect(JSON.stringify(published[0]!.event)).not.toContain('hunter2');
  });
});
