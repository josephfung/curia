// secret-capture-resume-subscriber.test.ts — unit tests for the #972 resume subscriber.
// No DB, no real bus: a fake bus records subscriptions/publishes and lets a test emit events.

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { SecretCaptureResumeSubscriber, type ResumeRoutingRegistrar } from './secret-capture-resume-subscriber.js';
import type { EventBus } from '../bus/bus.js';
import type { BusEvent, Layer, EventType, AgentTaskEvent } from '../bus/events.js';
import { createSecretCaptured } from '../bus/events.js';

function makeFakeBus(opts: { publishThrows?: boolean } = {}) {
  const handlers = new Map<EventType, Array<(e: BusEvent) => unknown>>();
  const published: Array<{ layer: Layer; event: BusEvent }> = [];
  const bus = {
    subscribe(type: EventType, _layer: Layer, handler: (e: BusEvent) => unknown) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    async publish(layer: Layer, event: BusEvent) {
      if (opts.publishThrows) throw new Error('bus down');
      published.push({ layer, event });
    },
  } as unknown as EventBus;
  async function emit(event: BusEvent) {
    for (const h of handlers.get(event.type) ?? []) await h(event);
  }
  return { bus, published, emit };
}

const ORIGINATOR = { contactId: 'ceo', systemRole: 'principal', channel: 'email', initiatedAt: 't' };

function makeCapturedEvent(overrides: Partial<Parameters<typeof createSecretCaptured>[0]> = {}) {
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
      ...overrides,
    },
    'task-evt-9',
  );
}

function makeSubscriber(opts: { publishThrows?: boolean } = {}) {
  const { bus, published, emit } = makeFakeBus(opts);
  // Spy registrar so tests can assert routing is seeded for the resume task.
  const routingCalls: Array<{ taskEventId: string; routing: Parameters<ResumeRoutingRegistrar>[1] }> = [];
  const registerRouting: ResumeRoutingRegistrar = (taskEventId, routing) => { routingCalls.push({ taskEventId, routing }); };
  const sub = new SecretCaptureResumeSubscriber(bus, pino({ level: 'silent' }), registerRouting);
  sub.start();
  return { published, emit, routingCalls };
}

describe('SecretCaptureResumeSubscriber', () => {
  it('re-enters the originating agent via a synthetic agent.task with parentEventId threaded', async () => {
    const { published, emit } = makeSubscriber();
    await emit(makeCapturedEvent());

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

  it('seeds dispatcher routing for the resume task BEFORE publishing it (#972)', async () => {
    const { published, emit, routingCalls } = makeSubscriber();
    await emit(makeCapturedEvent());

    // Routing must be registered for the same task id that is published, with the origin channel,
    // so the dispatcher delivers the agent's reply back to the user instead of dropping it.
    expect(routingCalls).toHaveLength(1);
    const publishedTaskId = (published[0]!.event as AgentTaskEvent).id;
    expect(routingCalls[0]!.taskEventId).toBe(publishedTaskId);
    expect(routingCalls[0]!.routing).toEqual({ channelId: 'email', conversationId: 'conv-1', senderId: 'ceo' });
  });

  it('does not double-dispatch on duplicate event delivery', async () => {
    const { published, emit } = makeSubscriber();
    const event = makeCapturedEvent();
    await emit(event);
    await emit(event); // same event id delivered twice
    expect(published).toHaveLength(1);
  });

  it('skips (no dispatch) when essential routing is missing', async () => {
    const { published, emit, routingCalls } = makeSubscriber();
    // A token minted outside an agent context has no agentId — nothing to route a resume to.
    await emit(createSecretCaptured({
      secretName: 'user.x',
      label: 'X',
      conversationId: 'conv-1',
      channelId: 'email',
      // agentId intentionally absent
    }));
    expect(published).toHaveLength(0);
    expect(routingCalls).toHaveLength(0);
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

  it('falls back to a generic sender when originator.contactId is malformed (not a string)', async () => {
    const { published, emit } = makeSubscriber();
    // A malformed persisted originator (contactId is a number) must not yield a non-string senderId.
    await emit(makeCapturedEvent({
      originator: { contactId: 123 as unknown as string, systemRole: 'principal', channel: 'email', initiatedAt: 't' },
    }));
    expect(published).toHaveLength(1);
    const task = published[0]!.event as AgentTaskEvent;
    expect(task.payload.senderId).toBe('secret-capture');
  });

  it('rolls back the dedup marker and propagates when publish fails', async () => {
    const { emit } = makeSubscriber({ publishThrows: true });
    const event = makeCapturedEvent();
    // The failure must propagate (catch policy: log + propagate), not be swallowed.
    await expect(emit(event)).rejects.toThrow('bus down');
    // After rollback a retry is allowed: a second delivery is attempted again (and throws again),
    // proving the dedup marker was cleared rather than left blocking the retry.
    await expect(emit(event)).rejects.toThrow('bus down');
  });

  it('never leaks a secret value (the event carries none; content is name/intent only)', async () => {
    const { published, emit } = makeSubscriber();
    await emit(makeCapturedEvent());
    // Sanity: the payload only ever references the vault key/label/intent — there is no value
    // anywhere in the chain to leak, and the content is built from names only.
    expect(JSON.stringify(published[0]!.event)).not.toContain('hunter2');
  });
});
