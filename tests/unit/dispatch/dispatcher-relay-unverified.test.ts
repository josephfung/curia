// A relayed reply to a turn an unverified principal match started (a forged email From, an SMS)
// is flagged on its outbound.message, so the adapter tells the gateway and any approval its hold
// raises is marked unverified: delivered only on a verified channel, with the impersonation
// warning, under the hourly cap (GHSA-p49r-jqh2-v668).
import { describe, it, expect, vi } from 'vitest';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import type { EventBus } from '../../../src/bus/bus.js';
import type { Logger } from '../../../src/logger.js';
import { createAgentResponse, type BusEvent, type OutboundMessageEvent } from '../../../src/bus/events.js';

const CONVERSATION = 'email:thread-1';

function harness() {
  const published: BusEvent[] = [];
  const handlers = new Map<string, (event: BusEvent) => void | Promise<void>>();
  const bus = {
    subscribe: vi.fn((type: string, _layer: string, handler: (e: BusEvent) => void | Promise<void>) => {
      handlers.set(type, handler);
    }),
    publish: vi.fn(async (_layer: string, event: BusEvent) => { published.push(event); }),
  } as unknown as EventBus;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  const dispatcher = new Dispatcher({ bus, logger });
  dispatcher.register();
  return { dispatcher, handlers, published };
}

function seedRouting(dispatcher: Dispatcher, taskId: string, authenticated: boolean): void {
  (dispatcher as unknown as { taskRouting: Map<string, Record<string, unknown>> }).taskRouting.set(taskId, {
    channelId: 'email',
    conversationId: CONVERSATION,
    senderId: 'principal@example.test',
    humanReplySent: false,
    replySkillGateCBlocked: false,
    liveTurn: authenticated,
    originator: {
      contactId: 'principal-1', systemRole: 'principal', channel: 'email', tier: 'principal',
      initiatedAt: '2026-11-17T12:00:00.000Z', authenticated,
    },
  });
}

async function respond(handlers: Map<string, (event: BusEvent) => void | Promise<void>>, taskId: string): Promise<void> {
  await handlers.get('agent.response')!(createAgentResponse({
    agentId: 'coordinator', conversationId: CONVERSATION, content: 'Done.', parentEventId: taskId,
  }));
}

const relays = (events: BusEvent[]) => events.filter((e): e is OutboundMessageEvent => e.type === 'outbound.message');

describe('Dispatcher relay flag for an unverified principal turn (GHSA-p49r-jqh2-v668)', () => {
  it('flags the reply to an unauthenticated principal turn', async () => {
    const { dispatcher, handlers, published } = harness();
    seedRouting(dispatcher, 'task-1', false);
    await respond(handlers, 'task-1');
    expect(relays(published)[0]!.payload.requesterUnverified).toBe(true);
  });

  it('leaves the reply to an authenticated principal turn unflagged', async () => {
    const { dispatcher, handlers, published } = harness();
    seedRouting(dispatcher, 'task-1', true);
    await respond(handlers, 'task-1');
    expect(relays(published)[0]!.payload).not.toHaveProperty('requesterUnverified');
  });
});
