// A scheduler turn's reply has no route to anyone (#2091). Reply text the turn ends with is
// recorded, not dropped silently.
import { describe, it, expect, vi } from 'vitest';
import { Dispatcher } from '../../../src/dispatch/dispatcher.js';
import { EventBus } from '../../../src/bus/bus.js';
import { createLogger } from '../../../src/logger.js';
import type { Logger } from '../../../src/logger.js';
import {
  createAgentResponse,
  type OutboundMessageEvent,
  type OutboundNoReplyEvent,
} from '../../../src/bus/events.js';
import { NO_REPLY_SENTINEL } from '../../../src/dispatch/no-reply.js';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function buildHarness(logger: Logger = createLogger('error')) {
  const bus = new EventBus(logger);
  const outboundMessages: OutboundMessageEvent[] = [];
  const noReplyEvents: OutboundNoReplyEvent[] = [];
  new Dispatcher({ bus, logger }).register();
  bus.subscribe('outbound.message', 'channel', (event) => {
    outboundMessages.push(event as OutboundMessageEvent);
  });
  bus.subscribe('outbound.no_reply', 'system', (event) => {
    noReplyEvents.push(event as OutboundNoReplyEvent);
  });
  return { bus, outboundMessages, noReplyEvents };
}

const REPLY = "Here's what I found: Sam says Thursday at 10 works. Want me to confirm?";

async function publishUnrouted(
  bus: EventBus,
  opts: { content: string; channelId?: string; sends?: string[]; suppressDelivery?: boolean; isError?: boolean },
): Promise<string> {
  const response = createAgentResponse({
    agentId: 'coordinator',
    conversationId: 'scheduler:0e5d6c7b-1a2b-4c3d-8e9f-0000000000a1:run-1',
    content: opts.content,
    channelId: opts.channelId ?? 'scheduler',
    ...(opts.sends && { sends: opts.sends }),
    ...(opts.suppressDelivery && { suppressDelivery: true }),
    ...(opts.isError && { isError: true }),
    // No routing entry is registered for this task, as on every scheduler turn.
    parentEventId: 'scheduler-task-1',
  });
  await bus.publish('agent', response);
  return response.id;
}

describe('Dispatcher — unrouted scheduler-turn replies (#2091)', () => {
  it('records a reply with no send as outbound.no_reply scheduler_undelivered, keeping the text', async () => {
    const logger = mockLogger();
    const { bus, outboundMessages, noReplyEvents } = buildHarness(logger);
    const responseId = await publishUnrouted(bus, { content: REPLY, sends: [] });

    expect(outboundMessages).toHaveLength(0);
    expect(noReplyEvents).toHaveLength(1);
    expect(noReplyEvents[0]!.payload).toMatchObject({
      routingTaskId: 'scheduler-task-1',
      channelId: 'scheduler',
      reason: 'scheduler_undelivered',
      abandonedContent: REPLY,
    });
    expect(noReplyEvents[0]!.parentEventId).toBe(responseId);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'scheduler', contentLength: REPLY.length }),
      expect.stringContaining('reached no one'),
    );
    expect(logger.warn).not.toHaveBeenCalled();
    // The reply text belongs in the audit event only, never the log.
    for (const call of vi.mocked(logger.info).mock.calls) {
      expect(JSON.stringify(call)).not.toContain('Sam says');
    }
  });

  it('still records the reply when the turn also sent something', async () => {
    // `sends` names skills, not recipients: an email to a third party does not mean the
    // principal heard the update written in the reply.
    const { bus, noReplyEvents } = buildHarness();
    await publishUnrouted(bus, { content: REPLY, sends: ['email-send'] });
    expect(noReplyEvents).toHaveLength(1);
    expect(noReplyEvents[0]!.payload.abandonedContent).toBe(REPLY);
  });

  it('records nothing when the turn declined', async () => {
    const { bus, noReplyEvents } = buildHarness();
    await publishUnrouted(bus, { content: '', suppressDelivery: true, sends: [] });
    await publishUnrouted(bus, { content: NO_REPLY_SENTINEL, sends: [] });
    expect(noReplyEvents).toHaveLength(0);
  });

  it('still records prose around a stray NO_REPLY token', async () => {
    const { bus, noReplyEvents } = buildHarness();
    // A trailing token: classifyNoReply sees a real reply, the runtime does not suppress.
    const trailing = `Sam confirmed Thursday at 10. ${NO_REPLY_SENTINEL}`;
    await publishUnrouted(bus, { content: trailing, sends: [] });
    // A leading-token near-miss: the runtime flags suppressDelivery but keeps the text.
    const leading = `${NO_REPLY_SENTINEL} — Sam confirmed Thursday at 10.`;
    await publishUnrouted(bus, { content: leading, suppressDelivery: true, sends: [] });
    expect(noReplyEvents.map((e) => e.payload.abandonedContent)).toEqual([trailing, leading]);
  });

  it('leaves an error response to the scheduler', async () => {
    const { bus, noReplyEvents } = buildHarness();
    await publishUnrouted(bus, { content: 'Something went wrong.', isError: true });
    expect(noReplyEvents).toHaveLength(0);
  });

  it('records nothing for an unrouted response on another channel, and names the channel', async () => {
    const logger = mockLogger();
    const { bus, noReplyEvents } = buildHarness(logger);
    await publishUnrouted(bus, { content: REPLY, channelId: 'bullpen', sends: [] });
    expect(noReplyEvents).toHaveLength(0);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'bullpen' }),
      expect.not.stringContaining('expected for bullpen'),
    );
  });
});
