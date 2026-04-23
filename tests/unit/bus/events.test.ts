import { describe, it, expect } from 'vitest';
import {
  createInboundMessage,
  createAgentTask,
  createAgentResponse,
  createOutboundMessage,
  createSkillInvoke,
  createSkillResult,
  createConversationCheckpoint,
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

  it('createSkillInvoke creates a skill.invoke event', () => {
    const event = createSkillInvoke({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      skillName: 'web-fetch',
      input: { url: 'https://example.com' },
      taskEventId: 'task-1',
      parentEventId: 'parent-1',
    });
    expect(event.type).toBe('skill.invoke');
    expect(event.sourceLayer).toBe('agent');
    expect(event.payload.skillName).toBe('web-fetch');
    expect(event.parentEventId).toBe('parent-1');
  });

  it('createSkillResult creates a skill.result event', () => {
    const event = createSkillResult({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      skillName: 'web-fetch',
      result: { success: true, data: 'page content' },
      durationMs: 250,
      parentEventId: 'invoke-1',
    });
    expect(event.type).toBe('skill.result');
    expect(event.sourceLayer).toBe('execution');
    expect(event.payload.durationMs).toBe(250);
  });

  it('creates a conversation.checkpoint event', () => {
    const event = createConversationCheckpoint({
      conversationId: 'email:thread-abc',
      agentId: 'coordinator',
      channelId: 'email',
      since: '2026-04-08T10:00:00Z',
      turns: [
        { role: 'user', content: 'Alice is my wife' },
        { role: 'assistant', content: 'Got it, I will remember that.' },
      ],
    });

    expect(event.type).toBe('conversation.checkpoint');
    expect(event.sourceLayer).toBe('dispatch');
    expect(event.payload.conversationId).toBe('email:thread-abc');
    expect(event.payload.turns).toHaveLength(2);
    expect(event.id).toBeTruthy();
    expect(event.timestamp).toBeInstanceOf(Date);
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
