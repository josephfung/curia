// card-use-resume-subscriber.test.ts — unit tests for the #1358 card-use resume subscriber.

import { describe, it, expect, vi } from 'vitest';
import { createSilentLogger } from '../../../src/logger.js';
import { CardUseResumeSubscriber } from '../../../src/secrets/card-use-resume-subscriber.js';
import type { ResumeRoutingRegistrar } from '../../../src/secrets/secret-capture-resume-subscriber.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { BusEvent, Layer, EventType, AgentTaskEvent, CardUseDecidedPayload } from '../../../src/bus/events.js';
import { createCardUseDecided } from '../../../src/bus/events.js';
import { encodeResumeToken } from '../../../src/agents/resume-token.js';

function makeFakeBus() {
  const handlers = new Map<EventType, Array<(e: BusEvent) => unknown>>();
  const published: Array<{ layer: Layer; event: BusEvent }> = [];
  const delivered: BusEvent[] = [];
  let failStage = false;
  const bus = {
    subscribe(type: EventType, _layer: Layer, handler: (e: BusEvent) => unknown) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    async stagePublish(layer: Layer, event: BusEvent) {
      if (failStage) throw new Error('write-ahead failed');
      published.push({ layer, event });
      return { deliver: async () => { delivered.push(event); } };
    },
  } as unknown as EventBus;
  async function emit(event: BusEvent) {
    for (const h of handlers.get(event.type) ?? []) await h(event);
  }
  return { bus, published, delivered, emit, setFailStage: (v: boolean) => { failStage = v; } };
}

const ORIGINATOR = {
  contactId: 'ceo',
  systemRole: 'principal' as const,
  channel: 'email',
  initiatedAt: 't',
  tier: 'principal' as const,
};

function makeDecided(overrides: Partial<CardUseDecidedPayload> = {}) {
  return createCardUseDecided(
    {
      requestId: 'req-1',
      secretName: 'user.visa_card',
      siteDomain: 'aircanada.com',
      decision: 'approved',
      via: 'console',
      resume: true,
      purpose: 'the Toronto flight',
      origin: {
        conversationId: 'conv-1',
        agentId: 'coordinator',
        channelId: 'email',
        taskEventId: 'task-evt-9',
        originator: ORIGINATOR,
      },
      ...overrides,
    },
    'parent-1',
  );
}

function setup() {
  const { bus, published, delivered, emit, setFailStage } = makeFakeBus();
  const registerRouting = vi.fn<ResumeRoutingRegistrar>();
  new CardUseResumeSubscriber(bus, createSilentLogger(), registerRouting).start();
  const tasks = () => published.filter((p) => p.event.type === 'agent.task').map((p) => p.event as AgentTaskEvent);
  return { published, delivered, emit, registerRouting, tasks, setFailStage };
}

describe('CardUseResumeSubscriber', () => {
  it('resumes with approved copy', async () => {
    const { emit, tasks, registerRouting } = setup();
    await emit(makeDecided());
    const task = tasks()[0]!;
    expect(task.payload.content).toBe(
      'The principal approved the card payment for the Toronto flight on aircanada.com. Continue the checkout in the same browser session.',
    );
    expect(task.payload.agentId).toBe('coordinator');
    expect(task.payload.conversationId).toBe('conv-1');
    expect(task.payload.senderId).toBe('ceo');
    expect(task.parentEventId).toBe('task-evt-9');
    expect(registerRouting).toHaveBeenCalledWith(task.id, expect.objectContaining({ channelId: 'email', conversationId: 'conv-1' }));
  });

  it('persists the task before the handler returns, then delivers it', async () => {
    const { emit, tasks, delivered } = setup();
    await emit(makeDecided());
    expect(tasks()).toHaveLength(1);
    expect(delivered).toHaveLength(1);
  });

  it('propagates a persist failure and lets the event be replayed', async () => {
    const { emit, tasks, setFailStage } = setup();
    const event = makeDecided();
    setFailStage(true);
    await expect(emit(event)).rejects.toThrow('write-ahead failed');
    setFailStage(false);
    await emit(event);
    expect(tasks()).toHaveLength(1);
  });

  it('resumes with denied copy', async () => {
    const { emit, tasks } = setup();
    await emit(makeDecided({ decision: 'denied' }));
    expect(tasks()[0]!.payload.content).toBe(
      "The principal declined the card payment for the Toronto flight. Don't fill the card; tell them you stopped.",
    );
  });

  it('resumes with expired copy', async () => {
    const { emit, tasks } = setup();
    await emit(makeDecided({ decision: 'expired' }));
    expect(tasks()[0]!.payload.content).toBe(
      'The card confirmation for the Toronto flight expired without an answer. Ask again only if they still want it.',
    );
  });

  it('skips when resume is false', async () => {
    const { emit, tasks, registerRouting } = setup();
    await emit(makeDecided({ resume: false }));
    expect(tasks()).toHaveLength(0);
    expect(registerRouting).not.toHaveBeenCalled();
  });

  it('dedups a redelivered event', async () => {
    const { emit, tasks } = setup();
    const event = makeDecided();
    await emit(event);
    await emit(event);
    expect(tasks()).toHaveLength(1);
  });

  it('skips an unroutable origin and a non-deliverable channel', async () => {
    const { emit, tasks } = setup();
    await emit(makeDecided({ origin: {} }));
    await emit(makeDecided({ origin: { agentId: 'a', conversationId: 'c', channelId: 'internal' } }));
    expect(tasks()).toHaveLength(0);
  });

  it('appends re-delegation instructions for a delegated specialist', async () => {
    const { emit, tasks } = setup();
    const resumeToken = encodeResumeToken({ agent: 'travel', originalTask: 'book', context: 'ctx' });
    await emit(makeDecided({ origin: { agentId: 'coordinator', conversationId: 'conv-1', channelId: 'email', originator: ORIGINATOR, resumeToken } }));
    const content = tasks()[0]!.payload.content;
    expect(content).toContain("Re-delegate to 'travel'");
    expect(content).toContain(resumeToken);
  });

  it('payload never contains number or cvv', async () => {
    const event = makeDecided();
    const keys = Object.keys(event.payload);
    expect(keys).not.toContain('number');
    expect(keys).not.toContain('cvv');
    expect(JSON.stringify(event.payload)).not.toMatch(/"(number|cvv|pan)"/);
    // Type-level: these would fail to compile if the payload gained such fields.
    // @ts-expect-error CardUseDecidedPayload has no `number` field
    const n: CardUseDecidedPayload['number'] = undefined;
    // @ts-expect-error CardUseDecidedPayload has no `cvv` field
    const c: CardUseDecidedPayload['cvv'] = undefined;
    expect([n, c]).toEqual([undefined, undefined]);
  });
});
