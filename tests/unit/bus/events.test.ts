import { describe, it, expect } from 'vitest';
import {
  createInboundMessage,
  createAgentTask,
  createAgentResponse,
  createOutboundMessage,
  createToolInvoke,
  createToolResult,
  createConversationCheckpoint,
  createVoiceSessionStarted,
  createVoiceSessionEnded,
  createOutboundNoReply,
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

  it('createToolInvoke creates a tool.invoke event', () => {
    const event = createToolInvoke({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      toolName: 'web-fetch',
      input: { url: 'https://example.com' },
      taskEventId: 'task-1',
      parentEventId: 'parent-1',
    });
    expect(event.type).toBe('tool.invoke');
    expect(event.sourceLayer).toBe('agent');
    expect(event.payload.toolName).toBe('web-fetch');
    expect(event.parentEventId).toBe('parent-1');
  });

  it('createToolResult creates a tool.result event', () => {
    const event = createToolResult({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      toolName: 'web-fetch',
      result: { success: true, data: 'page content' },
      durationMs: 250,
      parentEventId: 'invoke-1',
    });
    expect(event.type).toBe('tool.result');
    expect(event.sourceLayer).toBe('execution');
    expect(event.payload.durationMs).toBe(250);
  });

  it('creates a conversation.checkpoint event', () => {
    const event = createConversationCheckpoint({
      conversationId: 'email:thread-abc',
      agentId: 'coordinator',
      channelId: 'email',
      through: 'cli',
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

  it('creates voice session lifecycle events', () => {
    const started = createVoiceSessionStarted({
      sessionId: 'session-1',
      conversationId: 'voice:session-1',
      livekitRoom: 'voice-session-1',
    });
    expect(started.type).toBe('voice.session.started');
    expect(started.sourceLayer).toBe('channel');
    expect(started.payload.livekitRoom).toBe('voice-session-1');

    const ended = createVoiceSessionEnded({
      sessionId: 'session-1',
      conversationId: 'voice:session-1',
      reason: 'console_hangup',
      durationMs: 1234,
    });
    expect(ended.type).toBe('voice.session.ended');
    expect(ended.sourceLayer).toBe('channel');
    expect(ended.payload.durationMs).toBe(1234);
  });

  it('creates an outbound.no_reply event', () => {
    const event = createOutboundNoReply({
      routingTaskId: 'task-1',
      agentId: 'coordinator',
      conversationId: 'email:thread-abc',
      channelId: 'email',
      reason: 'agent_declined',
      parentEventId: 'response-1',
    });
    expect(event.type).toBe('outbound.no_reply');
    expect(event.sourceLayer).toBe('dispatch');
    expect(event.parentEventId).toBe('response-1');
    expect(event.payload.reason).toBe('agent_declined');
    expect(event.payload.channelId).toBe('email');
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
