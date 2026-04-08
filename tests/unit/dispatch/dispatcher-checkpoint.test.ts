import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { DbPool } from '../../../src/db/connection.js';
import type { Logger } from '../../../src/logger.js';
import { createAgentResponse } from '../../../src/bus/events.js';

function makeStubs(debounceMs = 500) {
  const publishedEvents: unknown[] = [];
  const subscribeHandlers = new Map<string, (event: unknown) => Promise<void>>();

  const bus = {
    subscribe: vi.fn((eventType: string, _layer: string, handler: (e: unknown) => Promise<void>) => {
      subscribeHandlers.set(eventType, handler);
    }),
    publish: vi.fn(async (_layer: string, event: unknown) => {
      publishedEvents.push(event);
    }),
  } as unknown as EventBus;

  // Two-call sequence for every fireCheckpoint invocation:
  //   call 1 — conversation_checkpoints watermark query → no prior watermark
  //   call 2 — working_memory turns query → one turn to process
  const queryMock = vi.fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ role: 'user', content: 'hello' }] })
    // Subsequent invocations (reset/debounce tests) also need pairs
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ role: 'user', content: 'hello again' }] });

  const pool = { query: queryMock } as unknown as DbPool;

  const logger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  } as unknown as Logger;

  const dispatcher = new Dispatcher({
    bus,
    logger,
    pool,
    conversationCheckpointDebounceMs: debounceMs,
  });

  return { dispatcher, bus, pool, logger, publishedEvents, subscribeHandlers, queryMock };
}

/** Seeds the Dispatcher's private taskRouting map so handleAgentResponse finds the route. */
function seedRouting(dispatcher: Dispatcher, taskEventId: string, channelId: string, conversationId: string) {
  (dispatcher as unknown as { taskRouting: Map<string, { channelId: string; conversationId: string; senderId: string }> })
    .taskRouting.set(taskEventId, { channelId, conversationId, senderId: 'user-1' });
}

async function fireAgentResponse(
  subscribeHandlers: Map<string, (event: unknown) => Promise<void>>,
  {
    taskEventId,
    conversationId,
    agentId,
    content = 'ok',
  }: { taskEventId: string; conversationId: string; agentId: string; content?: string },
) {
  const event = createAgentResponse({
    agentId,
    conversationId,
    content,
    parentEventId: taskEventId,
  });
  const handler = subscribeHandlers.get('agent.response');
  if (!handler) throw new Error('No agent.response handler registered');
  await handler(event);
}

describe('Dispatcher checkpoint debounce', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('publishes conversation.checkpoint after debounce window elapses', async () => {
    const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs(500);
    dispatcher.register();

    // Pre-seed routing so handleAgentResponse doesn't drop the event
    seedRouting(dispatcher, 'task-1', 'email', 'email:thread-abc');

    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-1',
      conversationId: 'email:thread-abc',
      agentId: 'coordinator',
    });

    // No checkpoint yet — debounce hasn't elapsed
    expect(publishedEvents.filter((e: any) => e.type === 'conversation.checkpoint')).toHaveLength(0);

    // Advance time past debounce
    await vi.advanceTimersByTimeAsync(600);

    const checkpoints = publishedEvents.filter((e: any) => e.type === 'conversation.checkpoint');
    expect(checkpoints).toHaveLength(1);
    expect((checkpoints[0] as any).payload.conversationId).toBe('email:thread-abc');
  });

  it('resets the timer on a second agent.response before debounce elapses', async () => {
    const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs(500);
    dispatcher.register();

    seedRouting(dispatcher, 'task-1', 'email', 'email:thread-abc');
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-1',
      conversationId: 'email:thread-abc',
      agentId: 'coordinator',
    });

    await vi.advanceTimersByTimeAsync(300); // not yet elapsed

    // Second response — resets timer (re-seed routing since first response consumed it)
    seedRouting(dispatcher, 'task-2', 'email', 'email:thread-abc');
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-2',
      conversationId: 'email:thread-abc',
      agentId: 'coordinator',
    });

    await vi.advanceTimersByTimeAsync(300); // 300ms after reset — still not elapsed
    expect(publishedEvents.filter((e: any) => e.type === 'conversation.checkpoint')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(300); // now past debounce from second response
    expect(publishedEvents.filter((e: any) => e.type === 'conversation.checkpoint')).toHaveLength(1);
  });

  it('clears all timers on close() — no checkpoint fires after shutdown', async () => {
    const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs(500);
    dispatcher.register();

    seedRouting(dispatcher, 'task-1', 'email', 'email:thread-abc');
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-1',
      conversationId: 'email:thread-abc',
      agentId: 'coordinator',
    });

    dispatcher.close();

    await vi.advanceTimersByTimeAsync(1000);
    expect(publishedEvents.filter((e: any) => e.type === 'conversation.checkpoint')).toHaveLength(0);
  });
});
