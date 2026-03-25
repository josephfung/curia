import { describe, it, expect } from 'vitest';
import {
  createInboundMessage,
  createAgentTask,
  createAgentResponse,
  createOutboundMessage,
  type BusEvent,
} from '../../../src/bus/events.js';

describe('Event Types', () => {
  it('creates an inbound.message event', () => {
    const event = createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
    });
    expect(event.type).toBe('inbound.message');
    expect(event.sourceLayer).toBe('channel');
    expect(event.payload.content).toBe('Hello');
    expect(event.id).toBeDefined();
    expect(event.timestamp).toBeInstanceOf(Date);
  });

  it('creates an agent.task event with parent reference', () => {
    const parent = createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
    });
    const task = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      content: 'Hello',
      channelId: 'cli',
      senderId: 'user',
      parentEventId: parent.id,
    });
    expect(task.type).toBe('agent.task');
    expect(task.sourceLayer).toBe('dispatch');
    expect(task.parentEventId).toBe(parent.id);
  });

  it('creates an agent.response event', () => {
    const event = createAgentResponse({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      content: 'Hi there!',
      parentEventId: 'parent-1',
    });
    expect(event.type).toBe('agent.response');
    expect(event.sourceLayer).toBe('agent');
  });

  it('creates an outbound.message event', () => {
    const event = createOutboundMessage({
      conversationId: 'conv-1',
      channelId: 'cli',
      content: 'Hi there!',
      parentEventId: 'parent-1',
    });
    expect(event.type).toBe('outbound.message');
    expect(event.sourceLayer).toBe('dispatch');
  });

  it('type narrows via discriminated union', () => {
    const event: BusEvent = createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'cli',
      senderId: 'user',
      content: 'Hello',
    });
    if (event.type === 'inbound.message') {
      expect(event.payload.senderId).toBe('user');
    }
  });
});
