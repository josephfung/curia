import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { Logger } from '../../../src/logger.js';
import { createAgentResponse, type BusEvent, type ObservationTriageCompletedEvent } from '../../../src/bus/events.js';

function isTriageEvent(e: BusEvent): e is ObservationTriageCompletedEvent {
  return e.type === 'observation.triage.completed';
}

function makeStubs() {
  const publishedEvents: BusEvent[] = [];
  const subscribeHandlers = new Map<string, (event: BusEvent) => Promise<void>>();

  const bus = {
    subscribe: vi.fn((eventType: string, _layer: string, handler: (e: BusEvent) => Promise<void>) => {
      subscribeHandlers.set(eventType, handler);
    }),
    publish: vi.fn(async (_layer: string, event: BusEvent) => {
      publishedEvents.push(event);
    }),
  } as unknown as EventBus;

  const logger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  } as unknown as Logger;

  const dispatcher = new Dispatcher({ bus, logger });

  return { dispatcher, bus, logger, publishedEvents, subscribeHandlers };
}

/** Seeds the Dispatcher's private taskRouting map with observationMode enabled. */
function seedRouting(
  dispatcher: Dispatcher,
  taskEventId: string,
  opts: { conversationId?: string; senderId?: string; accountId?: string } = {},
) {
  const routing = {
    channelId: 'email',
    conversationId: opts.conversationId ?? 'email:thread-1',
    senderId: opts.senderId ?? 'sender@example.com',
    accountId: opts.accountId ?? 'ceo-inbox',
    observationMode: true,
  };
  (dispatcher as unknown as { taskRouting: Map<string, typeof routing> })
    .taskRouting.set(taskEventId, routing);
}

async function fireAgentResponse(
  subscribeHandlers: Map<string, (event: BusEvent) => Promise<void>>,
  opts: {
    taskEventId: string;
    content: string;
    skillsCalled?: string[];
    isError?: boolean;
    agentId?: string;
    conversationId?: string;
  },
) {
  const event = createAgentResponse({
    agentId: opts.agentId ?? 'coordinator',
    conversationId: opts.conversationId ?? 'email:thread-1',
    content: opts.content,
    skillsCalled: opts.skillsCalled,
    ...(opts.isError && { isError: true }),
    parentEventId: opts.taskEventId,
  });
  const handler = subscribeHandlers.get('agent.response');
  if (!handler) throw new Error('No agent.response handler registered');
  await handler(event);
}

describe('Dispatcher observation-mode triage event', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('emits observation.triage.completed with URGENT classification', async () => {
    const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs();
    dispatcher.register();

    seedRouting(dispatcher, 'task-1');
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-1',
      content: 'Classification: URGENT — CEO needs to respond to this investor email immediately.',
      skillsCalled: ['entity-context', 'signal-send'],
    });

    const triageEvents = publishedEvents.filter(isTriageEvent);
    expect(triageEvents).toHaveLength(1);

    const payload = triageEvents[0]!.payload;
    expect(payload.classification).toBe('URGENT');
    expect(payload.skillsCalled).toEqual(['entity-context', 'signal-send']);
    expect(payload.outboundActions).toBe(2);
    expect(payload.conversationId).toBe('email:thread-1');
    expect(payload.senderId).toBe('sender@example.com');
    expect(payload.accountId).toBe('ceo-inbox');
    expect(triageEvents[0]!.parentEventId).toBe('task-1');
  });

  it('emits observation.triage.completed with ACTIONABLE classification', async () => {
    const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs();
    dispatcher.register();

    seedRouting(dispatcher, 'task-2');
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-2',
      content: 'ACTIONABLE — calendar invite processed.',
      skillsCalled: ['entity-context', 'email-reply'],
    });

    const triageEvents = publishedEvents.filter(isTriageEvent);
    expect(triageEvents).toHaveLength(1);
    expect(triageEvents[0]!.payload.classification).toBe('ACTIONABLE');
    expect(triageEvents[0]!.payload.skillsCalled).toEqual(['entity-context', 'email-reply']);
  });

  it('emits observation.triage.completed with NEEDS DRAFT classification', async () => {
    const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs();
    dispatcher.register();

    seedRouting(dispatcher, 'task-3');
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-3',
      content: 'NEEDS DRAFT — a polite decline is warranted.',
      skillsCalled: ['email-draft-save'],
    });

    const triageEvents = publishedEvents.filter(isTriageEvent);
    expect(triageEvents).toHaveLength(1);
    expect(triageEvents[0]!.payload.classification).toBe('NEEDS DRAFT');
    expect(triageEvents[0]!.payload.outboundActions).toBe(1);
  });

  it('emits observation.triage.completed with NOISE classification', async () => {
    const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs();
    dispatcher.register();

    seedRouting(dispatcher, 'task-4');
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-4',
      content: 'NOISE — automated shipping notification, archived.',
      skillsCalled: ['email-archive'],
    });

    const triageEvents = publishedEvents.filter(isTriageEvent);
    expect(triageEvents).toHaveLength(1);
    expect(triageEvents[0]!.payload.classification).toBe('NOISE');
    expect(triageEvents[0]!.payload.skillsCalled).toEqual(['email-archive']);
  });

  it('emits observation.triage.completed with LEAVE FOR CEO and zero skills — no warning', async () => {
    const { dispatcher, subscribeHandlers, publishedEvents, logger } = makeStubs();
    dispatcher.register();

    seedRouting(dispatcher, 'task-5');
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-5',
      content: 'LEAVE FOR CEO — personal email from a family member.',
      skillsCalled: [],
    });

    const triageEvents = publishedEvents.filter(isTriageEvent);
    expect(triageEvents).toHaveLength(1);
    expect(triageEvents[0]!.payload.classification).toBe('LEAVE FOR CEO');
    expect(triageEvents[0]!.payload.skillsCalled).toEqual([]);
    expect(triageEvents[0]!.payload.outboundActions).toBe(0);
    // No warn about zero skill calls — zero skills is expected for LEAVE FOR CEO.
    // (logger.warn may have been called for unrelated reasons during register(),
    // so assert on the specific message string rather than call count.)
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const triageWarnCalls = warnCalls.filter(
      (args: unknown[]) => typeof args[1] === 'string' && args[1].includes('zero skill calls'),
    );
    expect(triageWarnCalls).toHaveLength(0);
  });

  it('warns on zero skill calls with non-LEAVE_FOR_CEO classification', async () => {
    const { dispatcher, subscribeHandlers, publishedEvents, logger } = makeStubs();
    dispatcher.register();

    seedRouting(dispatcher, 'task-6');
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-6',
      content: 'URGENT — investor needs response but I could not reach the notification service.',
      skillsCalled: [],
    });

    // Triage event is still emitted
    const triageEvents = publishedEvents.filter(isTriageEvent);
    expect(triageEvents).toHaveLength(1);
    expect(triageEvents[0]!.payload.classification).toBe('URGENT');
    expect(triageEvents[0]!.payload.outboundActions).toBe(0);

    // Defensive warn was logged
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ classification: 'URGENT', conversationId: 'email:thread-1' }),
      expect.stringContaining('zero skill calls'),
    );
  });

  it('defaults skillsCalled to empty array when not present on agent response', async () => {
    const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs();
    dispatcher.register();

    seedRouting(dispatcher, 'task-7');
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-7',
      content: 'LEAVE FOR CEO — ambiguous message.',
      // skillsCalled omitted — simulates error-path responses from runtime
    });

    const triageEvents = publishedEvents.filter(isTriageEvent);
    expect(triageEvents).toHaveLength(1);
    expect(triageEvents[0]!.payload.skillsCalled).toEqual([]);
  });

  it('extracts unknown classification when no label matches', async () => {
    const { dispatcher, subscribeHandlers, publishedEvents, logger } = makeStubs();
    dispatcher.register();

    seedRouting(dispatcher, 'task-8');
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-8',
      content: 'I was unable to classify this email.',
      skillsCalled: [],
    });

    const triageEvents = publishedEvents.filter(isTriageEvent);
    expect(triageEvents).toHaveLength(1);
    expect(triageEvents[0]!.payload.classification).toBe('unknown');

    // unknown + zero skills → warn
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ classification: 'unknown' }),
      expect.stringContaining('zero skill calls'),
    );
  });

  it('does not emit triage event for non-observation-mode responses', async () => {
    const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs();
    dispatcher.register();

    // Seed with observationMode: false (use the checkpoint test's seedRouting pattern)
    const routing = {
      channelId: 'email',
      conversationId: 'email:thread-9',
      senderId: 'user@example.com',
      observationMode: false,
    };
    (dispatcher as unknown as { taskRouting: Map<string, typeof routing> })
      .taskRouting.set('task-9', routing);

    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-9',
      conversationId: 'email:thread-9',
      content: 'Here is my reply.',
      skillsCalled: ['email-reply'],
    });

    const triageEvents = publishedEvents.filter(isTriageEvent);
    expect(triageEvents).toHaveLength(0);
  });

  it('skips triage event for isError responses (runtime failure)', async () => {
    const { dispatcher, subscribeHandlers, publishedEvents, logger } = makeStubs();
    dispatcher.register();

    seedRouting(dispatcher, 'task-10');
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-10',
      content: "I'm sorry, I was unable to process that request. Please try again.",
      isError: true,
    });

    // No triage event — isError responses are runtime failures, not triage decisions
    const triageEvents = publishedEvents.filter(isTriageEvent);
    expect(triageEvents).toHaveLength(0);

    // A warn is logged about skipping
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'email:thread-1' }),
      expect.stringContaining('skipping triage event'),
    );
  });

  it('does not warn for LEAVE FOR CEO with skill calls', async () => {
    const { dispatcher, subscribeHandlers, publishedEvents, logger } = makeStubs();
    dispatcher.register();

    seedRouting(dispatcher, 'task-11');
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-11',
      content: 'LEAVE FOR CEO — looked up sender context first.',
      skillsCalled: ['entity-context'],
    });

    const triageEvents = publishedEvents.filter(isTriageEvent);
    expect(triageEvents).toHaveLength(1);
    expect(triageEvents[0]!.payload.classification).toBe('LEAVE FOR CEO');
    expect(triageEvents[0]!.payload.skillsCalled).toEqual(['entity-context']);

    // No stall warn — LEAVE FOR CEO never triggers the zero-action warning
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const triageWarnCalls = warnCalls.filter(
      (args: unknown[]) => typeof args[1] === 'string' && args[1].includes('zero skill calls'),
    );
    expect(triageWarnCalls).toHaveLength(0);
  });
});
