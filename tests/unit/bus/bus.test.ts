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

  it('calls onDelivered hook strictly after all subscribers have been attempted', async () => {
    // The onDelivered hook is used by the audit logger to flip acknowledged = true
    // after all handlers have been dispatched (regardless of per-subscriber errors).
    // Verify ordering by tracking invocation sequence across two subscribers.
    const callOrder: string[] = [];
    const subscriber1 = vi.fn(() => { callOrder.push('subscriber1'); });
    const subscriber2 = vi.fn(() => { callOrder.push('subscriber2'); });
    const onDelivered = vi.fn(() => { callOrder.push('onDelivered'); });

    bus = new EventBus(createLogger('error'), undefined, onDelivered);
    bus.subscribe('inbound.message', 'dispatch', subscriber1);
    bus.subscribe('inbound.message', 'dispatch', subscriber2);

    const event = createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
    });
    await bus.publish('channel', event);

    expect(subscriber1).toHaveBeenCalledWith(event);
    expect(subscriber2).toHaveBeenCalledWith(event);
    expect(onDelivered).toHaveBeenCalledWith(event.id);
    // onDelivered must come last — both subscribers were attempted first.
    expect(callOrder).toEqual(['subscriber1', 'subscriber2', 'onDelivered']);
  });

  it('calls onDelivered even when a subscriber throws', async () => {
    // A failing subscriber must not prevent acknowledgement — the event was
    // dispatched and the audit record should reflect that. Verify ordering:
    // both subscribers are attempted before onDelivered fires.
    const callOrder: string[] = [];
    const failingSubscriber = vi.fn(() => {
      callOrder.push('failingSubscriber');
      throw new Error('subscriber failure');
    });
    const successSubscriber = vi.fn(() => { callOrder.push('successSubscriber'); });
    const onDelivered = vi.fn(() => { callOrder.push('onDelivered'); });

    bus = new EventBus(createLogger('error'), undefined, onDelivered);
    bus.subscribe('inbound.message', 'dispatch', failingSubscriber);
    bus.subscribe('inbound.message', 'dispatch', successSubscriber);

    const event = createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
    });
    await bus.publish('channel', event);

    expect(onDelivered).toHaveBeenCalledWith(event.id);
    // onDelivered must fire after both subscribers — even the failing one.
    expect(callOrder).toEqual(['failingSubscriber', 'successSubscriber', 'onDelivered']);
  });

  it('resolves publish() even when onDelivered throws', async () => {
    // A failed acknowledgement write must not roll back a completed delivery.
    // The publisher's view of the event (published successfully) must remain
    // stable regardless of whether the post-delivery audit flip succeeded.
    const failingOnDelivered = vi.fn().mockRejectedValue(new Error('ack write failed'));
    bus = new EventBus(createLogger('error'), undefined, failingOnDelivered);
    bus.subscribe('inbound.message', 'dispatch', vi.fn());

    const event = createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
    });

    // Must resolve — not reject — even though onDelivered threw.
    await expect(bus.publish('channel', event)).resolves.toBeUndefined();
  });
});
