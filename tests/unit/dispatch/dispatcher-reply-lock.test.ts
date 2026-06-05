import { describe, it, expect, vi } from 'vitest';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { Logger } from '../../../src/logger.js';
import {
  createAgentResponse,
  type BusEvent,
  type OutboundMessageEvent,
  type OutboundSuppressedDuplicateEvent,
} from '../../../src/bus/events.js';

function isOutboundMessage(e: BusEvent): e is OutboundMessageEvent {
  return e.type === 'outbound.message';
}

function isOutboundSuppressedDuplicate(e: BusEvent): e is OutboundSuppressedDuplicateEvent {
  return e.type === 'outbound.suppressed_duplicate';
}

function makeStubs() {
  const publishedEvents: BusEvent[] = [];
  const subscribeHandlers = new Map<string, (event: BusEvent) => void | Promise<void>>();

  const bus = {
    subscribe: vi.fn((eventType: string, _layer: string, handler: (e: BusEvent) => void | Promise<void>) => {
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

  return { dispatcher, bus, publishedEvents, subscribeHandlers };
}

/** Seeds the routing map with humanReplySent set to the given value. */
function seedRouting(
  dispatcher: Dispatcher,
  taskEventId: string,
  opts: { channelId?: string; conversationId?: string; senderId?: string; humanReplySent?: boolean } = {},
) {
  (dispatcher as unknown as {
    taskRouting: Map<string, { channelId: string; conversationId: string; senderId: string; humanReplySent: boolean }>;
  }).taskRouting.set(taskEventId, {
    channelId: opts.channelId ?? 'email',
    conversationId: opts.conversationId ?? 'email:thread-abc',
    senderId: opts.senderId ?? 'sender@example.com',
    humanReplySent: opts.humanReplySent ?? false,
  });
}

async function fireAgentResponse(
  subscribeHandlers: Map<string, (event: BusEvent) => void | Promise<void>>,
  { taskEventId, conversationId = 'email:thread-abc', agentId = 'coordinator', content = 'ok' }: {
    taskEventId: string;
    conversationId?: string;
    agentId?: string;
    content?: string;
  },
) {
  const event = createAgentResponse({ agentId, conversationId, content, parentEventId: taskEventId });
  const handler = subscribeHandlers.get('agent.response');
  if (!handler) throw new Error('No agent.response handler registered');
  await handler(event);
}

describe('Dispatcher reply-lock — handleAgentResponse', () => {
  it('publishes outbound.message when humanReplySent is false', async () => {
    const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs();
    dispatcher.register();

    seedRouting(dispatcher, 'task-1', { humanReplySent: false });
    await fireAgentResponse(subscribeHandlers, { taskEventId: 'task-1' });

    expect(publishedEvents.filter(isOutboundMessage)).toHaveLength(1);
    expect(publishedEvents.filter(isOutboundSuppressedDuplicate)).toHaveLength(0);
  });

  it('suppresses outbound.message and emits outbound.suppressed_duplicate when humanReplySent is true', async () => {
    const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs();
    dispatcher.register();

    seedRouting(dispatcher, 'task-2', { humanReplySent: true });
    await fireAgentResponse(subscribeHandlers, { taskEventId: 'task-2', agentId: 'coordinator' });

    expect(publishedEvents.filter(isOutboundMessage)).toHaveLength(0);

    const suppressed = publishedEvents.filter(isOutboundSuppressedDuplicate);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]!.payload.reason).toBe('human_reply_already_sent');
    expect(suppressed[0]!.payload.agentId).toBe('coordinator');
    expect(suppressed[0]!.payload.conversationId).toBe('email:thread-abc');
    expect(suppressed[0]!.payload.routingTaskId).toBe('task-2');
    // parentEventId of suppressed event points to the agent.response (not the task)
    expect(suppressed[0]!.parentEventId).toBeDefined();
  });

  it('outbound.suppressed_duplicate payload has correct structure', async () => {
    const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs();
    dispatcher.register();

    seedRouting(dispatcher, 'task-3', {
      conversationId: 'email:conv-xyz',
      humanReplySent: true,
    });
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-3',
      conversationId: 'email:conv-xyz',
      agentId: 'curia',
    });

    const suppressed = publishedEvents.filter(isOutboundSuppressedDuplicate);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]!.type).toBe('outbound.suppressed_duplicate');
    expect(suppressed[0]!.sourceLayer).toBe('dispatch');
    expect(suppressed[0]!.id).toBeDefined();
    expect(suppressed[0]!.timestamp).toBeDefined();
  });

  it('routing entry is deleted after suppression (no double-processing)', async () => {
    const { dispatcher, subscribeHandlers } = makeStubs();
    dispatcher.register();

    seedRouting(dispatcher, 'task-4', { humanReplySent: true });
    await fireAgentResponse(subscribeHandlers, { taskEventId: 'task-4' });

    const taskRouting = (dispatcher as unknown as {
      taskRouting: Map<string, unknown>;
    }).taskRouting;
    expect(taskRouting.has('task-4')).toBe(false);
  });
});
