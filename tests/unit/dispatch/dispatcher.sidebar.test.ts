// dispatcher.sidebar.test.ts — tests for the sidebar split in handleAgentResponse.
//
// When an agent.response carries a sidebar field and the dispatcher is
// configured with principalRouting, it must publish two outbound.message
// events: one to the inbound sender (external content only) and one to
// the principal (sidebar content only). The sidebar text must never appear
// in the external outbound, and vice versa.

import { describe, it, expect, vi } from 'vitest';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { Logger } from '../../../src/logger.js';
import {
  createAgentResponse,
  type BusEvent,
  type OutboundMessageEvent,
} from '../../../src/bus/events.js';

function isOutboundMessage(e: BusEvent): e is OutboundMessageEvent {
  return e.type === 'outbound.message';
}

function makeStubs(principalRouting?: { channelId: string; accountId?: string; recipientId: string }) {
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

  const dispatcher = new Dispatcher({ bus, logger, principalRouting });

  return { dispatcher, bus, publishedEvents, subscribeHandlers };
}

/** Seeds the routing table for an inbound task. */
function seedRouting(
  dispatcher: Dispatcher,
  taskEventId: string,
  opts: { channelId?: string; conversationId?: string; senderId?: string; accountId?: string } = {},
) {
  (dispatcher as unknown as {
    taskRouting: Map<string, {
      channelId: string;
      conversationId: string;
      senderId: string;
      accountId?: string;
      humanReplySent: boolean;
    }>;
  }).taskRouting.set(taskEventId, {
    channelId: opts.channelId ?? 'email',
    conversationId: opts.conversationId ?? 'email:thread-abc',
    senderId: opts.senderId ?? 'armin@example.com',
    accountId: opts.accountId,
    humanReplySent: false,
  });
}

async function fireAgentResponse(
  subscribeHandlers: Map<string, (event: BusEvent) => void | Promise<void>>,
  opts: {
    taskEventId: string;
    content?: string;
    sidebar?: { audience: 'principal'; content: string };
    conversationId?: string;
    agentId?: string;
  },
) {
  const event = createAgentResponse({
    agentId: opts.agentId ?? 'coordinator',
    conversationId: opts.conversationId ?? 'email:thread-abc',
    content: opts.content ?? 'ok',
    ...(opts.sidebar !== undefined && { sidebar: opts.sidebar }),
    parentEventId: opts.taskEventId,
  });
  const handler = subscribeHandlers.get('agent.response');
  if (!handler) throw new Error('No agent.response handler registered');
  await handler(event);
}

describe('Dispatcher sidebar split', () => {
  it('publishes two outbound.message events when sidebar is present and principalRouting is configured', async () => {
    const principalRouting = { channelId: 'email', accountId: 'curia', recipientId: 'ceo@example.com' };
    const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs(principalRouting);
    dispatcher.register();

    seedRouting(dispatcher, 'task-1', { senderId: 'armin@example.com', channelId: 'email', accountId: 'curia' });
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-1',
      content: 'Friday at 2 PM works!',
      sidebar: { audience: 'principal', content: 'Confirmed Fri 2 PM with Armin; invite pending.' },
    });

    const outbounds = publishedEvents.filter(isOutboundMessage);
    expect(outbounds).toHaveLength(2);
  });

  it('sends the external content (not sidebar) to the inbound sender', async () => {
    const principalRouting = { channelId: 'email', accountId: 'curia', recipientId: 'ceo@example.com' };
    const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs(principalRouting);
    dispatcher.register();

    seedRouting(dispatcher, 'task-2', { senderId: 'armin@example.com', channelId: 'email' });
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-2',
      content: 'Friday at 2 PM works!',
      sidebar: { audience: 'principal', content: 'Status for CEO.' },
    });

    const outbounds = publishedEvents.filter(isOutboundMessage);
    const external = outbounds.find(e => e.payload.recipientId === 'armin@example.com');
    expect(external).toBeDefined();
    expect(external!.payload.content).toBe('Friday at 2 PM works!');
    // Sidebar text must NOT appear in the external outbound
    expect(external!.payload.content).not.toContain('Status for CEO.');
  });

  it('sends the sidebar content (not external) to the principal', async () => {
    const principalRouting = { channelId: 'email', accountId: 'curia', recipientId: 'ceo@example.com' };
    const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs(principalRouting);
    dispatcher.register();

    seedRouting(dispatcher, 'task-3', { senderId: 'armin@example.com', channelId: 'email' });
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-3',
      content: 'Friday at 2 PM works!',
      sidebar: { audience: 'principal', content: 'Status for CEO.' },
    });

    const outbounds = publishedEvents.filter(isOutboundMessage);
    const principal = outbounds.find(e => e.payload.recipientId === 'ceo@example.com');
    expect(principal).toBeDefined();
    expect(principal!.payload.content).toBe('Status for CEO.');
    // External text must NOT appear in the principal outbound
    expect(principal!.payload.content).not.toContain('Friday at 2 PM works!');
  });

  it('routes the principal outbound through the correct channelId and accountId', async () => {
    const principalRouting = { channelId: 'email', accountId: 'curia', recipientId: 'ceo@example.com' };
    const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs(principalRouting);
    dispatcher.register();

    seedRouting(dispatcher, 'task-4', { senderId: 'armin@example.com', channelId: 'email', accountId: 'work' });
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-4',
      content: 'External reply.',
      sidebar: { audience: 'principal', content: 'CEO update.' },
    });

    const outbounds = publishedEvents.filter(isOutboundMessage);
    const principal = outbounds.find(e => e.payload.recipientId === 'ceo@example.com');
    expect(principal!.payload.channelId).toBe('email');
    expect(principal!.payload.accountId).toBe('curia');
  });

  it('publishes only one outbound.message when sidebar is absent', async () => {
    const principalRouting = { channelId: 'email', accountId: 'curia', recipientId: 'ceo@example.com' };
    const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs(principalRouting);
    dispatcher.register();

    seedRouting(dispatcher, 'task-5', { senderId: 'armin@example.com' });
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-5',
      content: 'Just a plain reply.',
    });

    const outbounds = publishedEvents.filter(isOutboundMessage);
    expect(outbounds).toHaveLength(1);
  });

  it('publishes only one outbound.message when sidebar is present but principalRouting is not configured', async () => {
    // If the dispatcher has no principalRouting, it cannot deliver the sidebar —
    // it still sends the external reply but silently drops the sidebar.
    const { dispatcher, subscribeHandlers, publishedEvents } = makeStubs(/* no principalRouting */);
    dispatcher.register();

    seedRouting(dispatcher, 'task-6', { senderId: 'armin@example.com' });
    await fireAgentResponse(subscribeHandlers, {
      taskEventId: 'task-6',
      content: 'External reply.',
      sidebar: { audience: 'principal', content: 'Sidebar text.' },
    });

    const outbounds = publishedEvents.filter(isOutboundMessage);
    // Only the external message goes out — sidebar is dropped (no principal routing)
    expect(outbounds).toHaveLength(1);
    expect(outbounds[0]!.payload.content).toBe('External reply.');
  });
});
