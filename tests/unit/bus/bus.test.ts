import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../../../src/bus/bus.js';
import { createInboundMessage, createAgentTask } from '../../../src/bus/events.js';
import { createLogger } from '../../../src/logger.js';

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus(createLogger('error'));
  });

  it('delivers events to subscribers', async () => {
    const handler = vi.fn();
    bus.subscribe('inbound.message', 'dispatch', handler);

    const event = createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
    });
    await bus.publish('channel', event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  it('rejects publish from unauthorized layer', async () => {
    // 'channel' is not allowed to publish 'agent.task' — only 'dispatch' can
    const event = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
      parentEventId: 'parent-1',
    });

    await expect(bus.publish('channel', event)).rejects.toThrow(
      /not authorized to publish/,
    );
  });

  it('rejects subscribe from unauthorized layer', () => {
    // 'channel' is not allowed to subscribe to 'agent.task'
    expect(() =>
      bus.subscribe('agent.task', 'channel', vi.fn()),
    ).toThrow(/not authorized to subscribe/);
  });

  it('does not deliver events to non-matching subscribers', async () => {
    // subscribe to 'outbound.message' but publish 'inbound.message' — handler must not fire
    const handler = vi.fn();
    bus.subscribe('outbound.message', 'channel', handler);

    const event = createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
    });
    await bus.publish('channel', event);

    expect(handler).not.toHaveBeenCalled();
  });

  it('calls onEvent hook for every published event', async () => {
    // The onEvent hook is used by the audit logger to record all bus traffic
    // before delivery so nothing is missed even if a subscriber throws.
    const onEvent = vi.fn();
    bus = new EventBus(createLogger('error'), onEvent);

    const event = createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
    });
    await bus.publish('channel', event);

    expect(onEvent).toHaveBeenCalledWith(event);
  });
});
