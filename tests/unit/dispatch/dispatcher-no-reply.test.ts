import { describe, it, expect, vi } from 'vitest';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { Logger } from '../../../src/logger.js';
import {
  createAgentResponse,
  type BusEvent,
  type OutboundMessageEvent,
  type OutboundNoReplyEvent,
  type OutboundSuppressedDuplicateEvent,
} from '../../../src/bus/events.js';
import { NO_REPLY_SENTINEL } from '../../../src/dispatch/no-reply.js';

function isOutboundMessage(e: BusEvent): e is OutboundMessageEvent {
  return e.type === 'outbound.message';
}

function isOutboundNoReply(e: BusEvent): e is OutboundNoReplyEvent {
  return e.type === 'outbound.no_reply';
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

function seedRouting(
  dispatcher: Dispatcher,
  taskEventId: string,
  opts: {
    channelId?: string;
    conversationId?: string;
    senderId?: string;
    humanReplySent?: boolean;
    contentBlockRetryAttempt?: number;
  } = {},
) {
  (dispatcher as unknown as {
    taskRouting: Map<string, {
      channelId: string;
      conversationId: string;
      senderId: string;
      humanReplySent: boolean;
      contentBlockRetryAttempt?: number;
    }>;
  }).taskRouting.set(taskEventId, {
    channelId: opts.channelId ?? 'email',
    conversationId: opts.conversationId ?? 'email:thread-abc',
    senderId: opts.senderId ?? 'sender@example.com',
    humanReplySent: opts.humanReplySent ?? false,
    contentBlockRetryAttempt: opts.contentBlockRetryAttempt,
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
  return event;
}

describe('Dispatcher no-reply — handleAgentResponse (#1732)', () => {
  it('publishes outbound.no_reply and no outbound.message when the agent returns NO_REPLY', async () => {
    const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs();
    dispatcher.register();

    seedRouting(dispatcher, 'task-nr-1');
    const response = await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-nr-1',
      content: NO_REPLY_SENTINEL,
    });

    expect(publishedEvents.filter(isOutboundMessage)).toHaveLength(0);
    expect(publishedEvents.filter(isOutboundSuppressedDuplicate)).toHaveLength(0);

    const noReply = publishedEvents.filter(isOutboundNoReply);
    expect(noReply).toHaveLength(1);
    expect(noReply[0]!.payload.reason).toBe('agent_declined');
    expect(noReply[0]!.payload.agentId).toBe('coordinator');
    expect(noReply[0]!.payload.conversationId).toBe('email:thread-abc');
    expect(noReply[0]!.payload.channelId).toBe('email');
    expect(noReply[0]!.payload.routingTaskId).toBe('task-nr-1');
    expect(noReply[0]!.parentEventId).toBe(response.id);
    expect(noReply[0]!.sourceLayer).toBe('dispatch');
  });

  it('honours NO_REPLY on the content-block rewrite path without a salvage draft', async () => {
    const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs();
    dispatcher.register();

    seedRouting(dispatcher, 'task-nr-rewrite', { contentBlockRetryAttempt: 1 });
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-nr-rewrite',
      content: NO_REPLY_SENTINEL,
    });

    expect(publishedEvents.filter(isOutboundMessage)).toHaveLength(0);
    const noReply = publishedEvents.filter(isOutboundNoReply);
    expect(noReply).toHaveLength(1);
    expect(noReply[0]!.payload.reason).toBe('content_block_abandoned');
  });

  it('reply-lock still wins when humanReplySent is true, even if content is NO_REPLY', async () => {
    const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs();
    dispatcher.register();

    seedRouting(dispatcher, 'task-nr-lock', { humanReplySent: true });
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-nr-lock',
      content: NO_REPLY_SENTINEL,
    });

    expect(publishedEvents.filter(isOutboundMessage)).toHaveLength(0);
    expect(publishedEvents.filter(isOutboundNoReply)).toHaveLength(0);
    const suppressed = publishedEvents.filter(isOutboundSuppressedDuplicate);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]!.payload.reason).toBe('human_reply_already_sent');
  });

  it('still publishes outbound.message when the agent returns ordinary reply text', async () => {
    const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs();
    dispatcher.register();

    seedRouting(dispatcher, 'task-nr-send');
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-nr-send',
      content: 'Thanks for the update — I will follow up next week.',
    });

    expect(publishedEvents.filter(isOutboundMessage)).toHaveLength(1);
    expect(publishedEvents.filter(isOutboundNoReply)).toHaveLength(0);
    expect(publishedEvents.filter(isOutboundMessage)[0]!.payload.content).toBe(
      'Thanks for the update — I will follow up next week.',
    );
  });

  it('does not treat narration that mentions no-reply as the sentinel', async () => {
    const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs();
    dispatcher.register();

    seedRouting(dispatcher, 'task-nr-narration');
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-nr-narration',
      content: 'This is an automated calendar decline notification — no reply needed from me. I\'ll just archive it.',
    });

    expect(publishedEvents.filter(isOutboundMessage)).toHaveLength(1);
    expect(publishedEvents.filter(isOutboundNoReply)).toHaveLength(0);
  });

  it('deletes the routing entry after no-reply (no double-processing)', async () => {
    const { dispatcher, subscribeHandlers } = makeStubs();
    dispatcher.register();

    seedRouting(dispatcher, 'task-nr-cleanup');
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-nr-cleanup',
      content: NO_REPLY_SENTINEL,
    });

    const taskRouting = (dispatcher as unknown as {
      taskRouting: Map<string, unknown>;
    }).taskRouting;
    expect(taskRouting.has('task-nr-cleanup')).toBe(false);
  });
});
