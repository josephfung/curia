import { describe, it, expect } from 'vitest';
import { createAgentDiscuss } from '../../../src/bus/events.js';
import { canPublish, canSubscribe } from '../../../src/bus/permissions.js';

describe('agent.discuss event', () => {
  const basePayload = {
    threadId: 'thread-1',
    messageId: 'msg-1',
    topic: 'Test topic',
    senderAgentId: 'coordinator',
    participants: ['coordinator', 'agent-b'],
    mentionedAgentIds: ['agent-b'],
    content: 'Hello agent-b',
    parentEventId: 'task-1',
  };

  it('createAgentDiscuss returns correct event shape', () => {
    const event = createAgentDiscuss(basePayload);
    expect(event.type).toBe('agent.discuss');
    expect(event.sourceLayer).toBe('agent');
    expect(event.parentEventId).toBe('task-1');
    expect(event.payload.threadId).toBe('thread-1');
    expect(event.payload.senderAgentId).toBe('coordinator');
    expect(event.payload.participants).toEqual(['coordinator', 'agent-b']);
    expect(event.payload.mentionedAgentIds).toEqual(['agent-b']);
    expect(event.id).toBeTruthy();
    expect(event.timestamp).toBeInstanceOf(Date);
  });

  it('parentEventId is NOT in the payload', () => {
    const event = createAgentDiscuss(basePayload);
    expect((event.payload as Record<string, unknown>)['parentEventId']).toBeUndefined();
  });

  it('agent layer can publish agent.discuss', () => {
    expect(canPublish('agent', 'agent.discuss')).toBe(true);
  });

  it('dispatch layer cannot publish agent.discuss', () => {
    expect(canPublish('dispatch', 'agent.discuss')).toBe(false);
  });

  it('channel layer cannot publish agent.discuss', () => {
    expect(canPublish('channel', 'agent.discuss')).toBe(false);
  });

  it('dispatch layer can subscribe to agent.discuss', () => {
    expect(canSubscribe('dispatch', 'agent.discuss')).toBe(true);
  });

  it('system layer can subscribe to agent.discuss', () => {
    expect(canSubscribe('system', 'agent.discuss')).toBe(true);
  });

  it('agent layer cannot subscribe to agent.discuss', () => {
    expect(canSubscribe('agent', 'agent.discuss')).toBe(false);
  });

  it('channel layer cannot subscribe to agent.discuss', () => {
    expect(canSubscribe('channel', 'agent.discuss')).toBe(false);
  });
});
