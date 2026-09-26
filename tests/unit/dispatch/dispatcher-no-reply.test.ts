import { describe, it, expect, vi } from 'vitest';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createLogger } from '../../../src/logger.js';
import type { Logger } from '../../../src/logger.js';
import {
  createAgentResponse,
  createAgentTask,
  type OutboundMessageEvent,
  type OutboundNoReplyEvent,
  type OutboundNotificationEvent,
  type OutboundSuppressedDuplicateEvent,
} from '../../../src/bus/events.js';
import { NO_REPLY_SENTINEL } from '../../../src/dispatch/no-reply.js';

function mockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function principalOriginator() {
  return {
    contactId: 'principal-1',
    systemRole: 'principal' as const,
    channel: 'email' as const,
    initiatedAt: new Date().toISOString(),
    tier: 'principal' as const,
  };
}

function buildHarness(opts: { logger?: Logger } = {}) {
  const logger = opts.logger ?? createLogger('error');
  const bus = new EventBus(logger);
  const outboundMessages: OutboundMessageEvent[] = [];
  const noReplyEvents: OutboundNoReplyEvent[] = [];
  const notifications: OutboundNotificationEvent[] = [];
  const suppressed: OutboundSuppressedDuplicateEvent[] = [];

  const dispatcher = new Dispatcher({ bus, logger });
  dispatcher.register();

  bus.subscribe('outbound.message', 'channel', (event) => {
    outboundMessages.push(event as OutboundMessageEvent);
  });
  bus.subscribe('outbound.no_reply', 'system', (event) => {
    noReplyEvents.push(event as OutboundNoReplyEvent);
  });
  bus.subscribe('outbound.notification', 'channel', (event) => {
    notifications.push(event as OutboundNotificationEvent);
  });
  bus.subscribe('outbound.suppressed_duplicate', 'system', (event) => {
    suppressed.push(event as OutboundSuppressedDuplicateEvent);
  });

  return { bus, dispatcher, outboundMessages, noReplyEvents, notifications, suppressed, logger };
}

async function publishLiveNoReply(
  harness: ReturnType<typeof buildHarness>,
  opts: {
    content: string;
    channelId?: string;
    suppressDelivery?: boolean;
    conversationId?: string;
    liveTurn?: boolean;
  },
): Promise<void> {
  const channelId = opts.channelId ?? 'email';
  const conversationId = opts.conversationId ?? `${channelId}:ceo-thread`;
  const liveTurn = opts.liveTurn !== false;
  const task = createAgentTask({
    agentId: 'coordinator',
    conversationId,
    channelId,
    senderId: 'ceo@example.com',
    content: 'thanks',
    parentEventId: `inbound-${conversationId}`,
  });
  harness.dispatcher.registerExternalTaskRouting(task.id, {
    channelId,
    conversationId,
    senderId: 'ceo@example.com',
    ...(liveTurn ? { liveTurn: true } : {}),
    originator: principalOriginator(),
  });
  await harness.bus.publish('system', createAgentResponse({
    agentId: 'coordinator',
    conversationId,
    content: opts.content,
    ...(opts.suppressDelivery ? { suppressDelivery: true } : {}),
    parentEventId: task.id,
  }));
}

describe('Dispatcher no-reply — handleAgentResponse (#1732)', () => {
  it('publishes outbound.no_reply and no outbound.message when the agent returns NO_REPLY', async () => {
    const { bus, dispatcher, outboundMessages, noReplyEvents, suppressed } = buildHarness();
    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'email:thread-abc',
      channelId: 'email',
      senderId: 'sender@example.com',
      content: 'inbound',
      parentEventId: 'inbound-1',
    });
    dispatcher.registerExternalTaskRouting(task.id, {
      channelId: 'email',
      conversationId: 'email:thread-abc',
      senderId: 'sender@example.com',
      originator: principalOriginator(),
    });

    const response = createAgentResponse({
      agentId: 'coordinator',
      conversationId: 'email:thread-abc',
      content: NO_REPLY_SENTINEL,
      parentEventId: task.id,
    });
    await bus.publish('system', response);

    expect(outboundMessages).toHaveLength(0);
    expect(suppressed).toHaveLength(0);
    expect(noReplyEvents).toHaveLength(1);
    expect(noReplyEvents[0]!.payload.reason).toBe('agent_declined');
    expect(noReplyEvents[0]!.payload.agentId).toBe('coordinator');
    expect(noReplyEvents[0]!.payload.conversationId).toBe('email:thread-abc');
    expect(noReplyEvents[0]!.payload.channelId).toBe('email');
    expect(noReplyEvents[0]!.payload.routingTaskId).toBe(task.id);
    expect(noReplyEvents[0]!.parentEventId).toBe(response.id);
  });

  it('still publishes outbound.message when the agent returns ordinary reply text', async () => {
    const { bus, dispatcher, outboundMessages, noReplyEvents } = buildHarness();
    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'email:thread-abc',
      channelId: 'email',
      senderId: 'sender@example.com',
      content: 'inbound',
      parentEventId: 'inbound-2',
    });
    dispatcher.registerExternalTaskRouting(task.id, {
      channelId: 'email',
      conversationId: 'email:thread-abc',
      senderId: 'sender@example.com',
      originator: principalOriginator(),
    });
    await bus.publish('system', createAgentResponse({
      agentId: 'coordinator',
      conversationId: 'email:thread-abc',
      content: 'Thanks for the update — I will follow up next week.',
      parentEventId: task.id,
    }));

    expect(outboundMessages).toHaveLength(1);
    expect(noReplyEvents).toHaveLength(0);
    expect(outboundMessages[0]!.payload.content).toBe(
      'Thanks for the update — I will follow up next week.',
    );
  });

  it('does not treat narration without the token as a decline', async () => {
    const { bus, dispatcher, outboundMessages, noReplyEvents } = buildHarness();
    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'email:thread-abc',
      channelId: 'email',
      senderId: 'sender@example.com',
      content: 'inbound',
      parentEventId: 'inbound-3',
    });
    dispatcher.registerExternalTaskRouting(task.id, {
      channelId: 'email',
      conversationId: 'email:thread-abc',
      senderId: 'sender@example.com',
      originator: principalOriginator(),
    });
    await bus.publish('system', createAgentResponse({
      agentId: 'coordinator',
      conversationId: 'email:thread-abc',
      content: 'This is an automated calendar decline notification — no reply needed from me. I\'ll just archive it.',
      parentEventId: task.id,
    }));

    expect(outboundMessages).toHaveLength(1);
    expect(noReplyEvents).toHaveLength(0);
  });

  it('honours a live-turn decline without emailing the principal (#1908)', async () => {
    const logger = mockLogger();
    const harness = buildHarness({ logger });
    await publishLiveNoReply(harness, { content: NO_REPLY_SENTINEL });

    expect(harness.outboundMessages).toHaveLength(0);
    expect(harness.noReplyEvents).toHaveLength(1);
    expect(harness.noReplyEvents[0]!.payload.reason).toBe('agent_declined');
    expect(harness.notifications).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'agent_declined', liveTurn: true }),
      'Dispatcher no-reply: skipping outbound delivery',
    );
  });

  it('does not notify on live-turn empty_response (#1908)', async () => {
    const logger = mockLogger();
    const harness = buildHarness({ logger });
    await publishLiveNoReply(harness, { content: '   ' });

    expect(harness.outboundMessages).toHaveLength(0);
    expect(harness.noReplyEvents).toHaveLength(1);
    expect(harness.noReplyEvents[0]!.payload.reason).toBe('empty_response');
    expect(harness.notifications).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'empty_response', liveTurn: true }),
      'Dispatcher no-reply: skipping outbound delivery',
    );
  });

  it('does not notify on live-turn ambiguous_decline; still salvages the draft (#1908)', async () => {
    const logger = mockLogger();
    const harness = buildHarness({ logger });
    const nearMiss = 'NO_REPLY — I will archive this.';
    await publishLiveNoReply(harness, { content: nearMiss });

    expect(harness.noReplyEvents).toHaveLength(1);
    expect(harness.noReplyEvents[0]!.payload.reason).toBe('ambiguous_decline');
    expect(harness.noReplyEvents[0]!.payload.abandonedContent).toBe(nearMiss);
    expect(harness.notifications).toHaveLength(0);
    const salvage = harness.outboundMessages.filter((m) => m.payload.contentBlockSalvage);
    expect(salvage).toHaveLength(1);
    expect(salvage[0]!.payload.content).toBe(nearMiss);
    expect(harness.outboundMessages.filter((m) => !m.payload.contentBlockSalvage)).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'ambiguous_decline', liveTurn: true }),
      'Dispatcher no-reply: skipping outbound delivery',
    );
  });

  it('does not notify on live-turn agent_declined via suppressDelivery blank (#1908)', async () => {
    // Production shape: prepareAgentResponseContent blanks an exact sentinel and
    // sets suppressDelivery before publish (see #1908 timeline at 11:10:31).
    const logger = mockLogger();
    const harness = buildHarness({ logger });
    await publishLiveNoReply(harness, { content: '', suppressDelivery: true });

    expect(harness.outboundMessages).toHaveLength(0);
    expect(harness.noReplyEvents).toHaveLength(1);
    expect(harness.noReplyEvents[0]!.payload.reason).toBe('agent_declined');
    expect(harness.notifications).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'agent_declined', liveTurn: true }),
      'Dispatcher no-reply: skipping outbound delivery',
    );
  });

  it.each(['voice', 'cli', 'http'] as const)(
    'warns when a live %s turn ends in silence (#1908)',
    async (channelId) => {
      const logger = mockLogger();
      const harness = buildHarness({ logger });
      await publishLiveNoReply(harness, {
        content: NO_REPLY_SENTINEL,
        channelId,
      });

      expect(harness.noReplyEvents).toHaveLength(1);
      expect(harness.noReplyEvents[0]!.payload.reason).toBe('agent_declined');
      expect(harness.notifications).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ channelId, reason: 'agent_declined' }),
        'Dispatcher no-reply: principal turn ended in silence on a conversational channel',
      );
    },
  );

  it('does not warn on a non-live conversational channel silence (#1908)', async () => {
    const logger = mockLogger();
    const harness = buildHarness({ logger });
    await publishLiveNoReply(harness, {
      content: NO_REPLY_SENTINEL,
      channelId: 'voice',
      liveTurn: false,
    });

    expect(harness.noReplyEvents).toHaveLength(1);
    expect(harness.noReplyEvents[0]!.payload.reason).toBe('agent_declined');
    expect(harness.notifications).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'Dispatcher no-reply: principal turn ended in silence on a conversational channel',
    );
  });

  it('salvages a near-miss sentinel as a draft instead of sending it', async () => {
    const { bus, dispatcher, outboundMessages, noReplyEvents } = buildHarness();
    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'email:thread-near',
      channelId: 'email',
      senderId: 'known@example.com',
      content: 'inbound',
      parentEventId: 'inbound-near',
    });
    dispatcher.registerExternalTaskRouting(task.id, {
      channelId: 'email',
      conversationId: 'email:thread-near',
      senderId: 'known@example.com',
      originator: principalOriginator(),
    });
    const nearMiss = 'NO_REPLY — I will archive this.';
    await bus.publish('system', createAgentResponse({
      agentId: 'coordinator',
      conversationId: 'email:thread-near',
      content: nearMiss,
      parentEventId: task.id,
    }));

    expect(noReplyEvents).toHaveLength(1);
    expect(noReplyEvents[0]!.payload.reason).toBe('ambiguous_decline');
    expect(noReplyEvents[0]!.payload.abandonedContent).toBe(nearMiss);
    const salvage = outboundMessages.filter((m) => m.payload.contentBlockSalvage);
    expect(salvage).toHaveLength(1);
    expect(salvage[0]!.payload.content).toBe(nearMiss);
    expect(outboundMessages.filter((m) => !m.payload.contentBlockSalvage)).toHaveLength(0);
  });

  it('does not send a blank outbound.message for empty content', async () => {
    const { bus, dispatcher, outboundMessages, noReplyEvents } = buildHarness();
    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'email:thread-empty',
      channelId: 'email',
      senderId: 'known@example.com',
      content: 'inbound',
      parentEventId: 'inbound-empty',
    });
    dispatcher.registerExternalTaskRouting(task.id, {
      channelId: 'email',
      conversationId: 'email:thread-empty',
      senderId: 'known@example.com',
      originator: principalOriginator(),
    });
    await bus.publish('system', createAgentResponse({
      agentId: 'coordinator',
      conversationId: 'email:thread-empty',
      content: '   ',
      parentEventId: task.id,
    }));

    expect(outboundMessages).toHaveLength(0);
    expect(noReplyEvents).toHaveLength(1);
    expect(noReplyEvents[0]!.payload.reason).toBe('empty_response');
  });

  it('honours suppressDelivery with blanked content as a deliberate decline', async () => {
    const { bus, dispatcher, outboundMessages, noReplyEvents } = buildHarness();
    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'email:thread-flag',
      channelId: 'email',
      senderId: 'known@example.com',
      content: 'inbound',
      parentEventId: 'inbound-flag',
    });
    dispatcher.registerExternalTaskRouting(task.id, {
      channelId: 'email',
      conversationId: 'email:thread-flag',
      senderId: 'known@example.com',
      originator: principalOriginator(),
    });
    await bus.publish('system', createAgentResponse({
      agentId: 'coordinator',
      conversationId: 'email:thread-flag',
      content: '',
      suppressDelivery: true,
      parentEventId: task.id,
    }));

    expect(outboundMessages).toHaveLength(0);
    expect(noReplyEvents).toHaveLength(1);
    expect(noReplyEvents[0]!.payload.reason).toBe('agent_declined');
  });

  it('deletes the routing entry after no-reply (second response does not send)', async () => {
    const { bus, dispatcher, outboundMessages, noReplyEvents } = buildHarness();
    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'email:thread-abc',
      channelId: 'email',
      senderId: 'sender@example.com',
      content: 'inbound',
      parentEventId: 'inbound-cleanup',
    });
    dispatcher.registerExternalTaskRouting(task.id, {
      channelId: 'email',
      conversationId: 'email:thread-abc',
      senderId: 'sender@example.com',
      originator: principalOriginator(),
    });
    await bus.publish('system', createAgentResponse({
      agentId: 'coordinator',
      conversationId: 'email:thread-abc',
      content: NO_REPLY_SENTINEL,
      parentEventId: task.id,
    }));
    await bus.publish('system', createAgentResponse({
      agentId: 'coordinator',
      conversationId: 'email:thread-abc',
      content: 'this would have sent if routing remained',
      parentEventId: task.id,
    }));

    expect(noReplyEvents).toHaveLength(1);
    expect(outboundMessages).toHaveLength(0);
  });
});

describe('Dispatcher reply-lock still wins over NO_REPLY', () => {
  it('emits outbound.suppressed_duplicate when humanReplySent is true', async () => {
    const logger = createLogger('error');
    const bus = new EventBus(logger);
    const outboundMessages: OutboundMessageEvent[] = [];
    const noReplyEvents: OutboundNoReplyEvent[] = [];
    const suppressed: OutboundSuppressedDuplicateEvent[] = [];
    const dispatcher = new Dispatcher({ bus, logger });
    dispatcher.register();
    bus.subscribe('outbound.message', 'channel', (e) => {
      outboundMessages.push(e as OutboundMessageEvent);
    });
    bus.subscribe('outbound.no_reply', 'system', (e) => {
      noReplyEvents.push(e as OutboundNoReplyEvent);
    });
    bus.subscribe('outbound.suppressed_duplicate', 'system', (e) => {
      suppressed.push(e as OutboundSuppressedDuplicateEvent);
    });

    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'email:thread-lock',
      channelId: 'email',
      senderId: 'sender@example.com',
      content: 'inbound',
      parentEventId: 'inbound-lock',
    });
    dispatcher.registerExternalTaskRouting(task.id, {
      channelId: 'email',
      conversationId: 'email:thread-lock',
      senderId: 'sender@example.com',
      originator: principalOriginator(),
    });
    // Reply-lock is set by a successful email-reply skill, not by the public routing seam.
    (dispatcher as unknown as {
      taskRouting: Map<string, { humanReplySent: boolean }>;
    }).taskRouting.get(task.id)!.humanReplySent = true;

    await bus.publish('system', createAgentResponse({
      agentId: 'coordinator',
      conversationId: 'email:thread-lock',
      content: NO_REPLY_SENTINEL,
      parentEventId: task.id,
    }));

    expect(outboundMessages).toHaveLength(0);
    expect(noReplyEvents).toHaveLength(0);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]!.payload.reason).toBe('human_reply_already_sent');
  });
});
