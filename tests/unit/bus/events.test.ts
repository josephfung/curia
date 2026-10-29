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
  createSystemRestart,
  createDocumentConsoleAction,
  createKgNodesMerged,
  createActivitySummary,
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

  it('createAgentTask passes turnDeadlineAt through and never reads it from metadata (#2371)', () => {
    const withField = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      content: 'Hello',
      channelId: 'cli',
      senderId: 'user',
      turnDeadlineAt: 1_700_000_000_000,
      parentEventId: 'p-1',
    });
    expect(withField.payload.turnDeadlineAt).toBe(1_700_000_000_000);

    const fromMetadata = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      content: 'Hello',
      channelId: 'cli',
      senderId: 'user',
      metadata: { turnDeadlineAt: 1_700_000_000_000 },
      parentEventId: 'p-1',
    });
    expect(fromMetadata.payload.turnDeadlineAt).toBeUndefined();
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

  it('creates a system.restart event', () => {
    const event = createSystemRestart({
      bootedAt: '2026-09-10T12:00:00.000Z',
      initiatedBy: 'operator',
    });
    expect(event.type).toBe('system.restart');
    expect(event.sourceLayer).toBe('system');
    expect(event.payload.bootedAt).toBe('2026-09-10T12:00:00.000Z');
    expect(event.payload.initiatedBy).toBe('operator');
  });

  it('creates a document.console_action event (#1822)', () => {
    const event = createDocumentConsoleAction({
      stage: 'completed',
      action: 'update',
      path: '/projects/x/brief.md',
      documentId: '00000000-0000-4000-8000-000000000001',
      version: 3,
      byteSize: 120,
      initiatedBy: 'principal',
      channel: 'console',
    });
    expect(event.type).toBe('document.console_action');
    expect(event.sourceLayer).toBe('system');
    expect(event.payload.action).toBe('update');
  });

  it('creates a kg.nodes_merged event (#2233)', () => {
    const event = createKgNodesMerged({
      survivorId: 's',
      absorbedId: 'a',
      survivor: { id: 's', type: 'organization', label: 'Acme' },
      absorbed: { id: 'a', type: 'event', label: 'Acme Summit' },
      resultLabel: 'Acme',
      crossType: true,
      contactMerge: null,
      summary: { factsMoved: 1, factsCollapsed: 0, edgesMoved: 2, edgesCollapsed: 0, edgesDropped: 0, conflictsResolved: 0, contactReferencesRepointed: 0 },
      resolutions: { label: 'survivor', properties: {}, facts: {}, nearDuplicateFacts: {}, contactFields: {}, authOverrides: {}, acknowledgements: [] },
      principalIdentitiesTransferred: ['sms: +15550002'],
      principalPrimaryFieldsFilled: { primary_email: 'me@x.com' },
      actor: null,
      mergedAt: '2026-10-21T00:00:00.000Z',
    });
    expect(event.type).toBe('kg.nodes_merged');
    expect(event.sourceLayer).toBe('system');
    expect(event.payload.crossType).toBe(true);
    expect(event.payload.principalIdentitiesTransferred).toEqual(['sms: +15550002']);
    expect(event.payload.principalPrimaryFieldsFilled).toEqual({ primary_email: 'me@x.com' });
    expect(event.id).toBeTruthy();
  });

  it('creates an activity.summary event parented on its task (#2251)', () => {
    const event = createActivitySummary({
      agentId: 'coordinator',
      conversationId: 'conv-1',
      taskEventId: 'task-1',
      summary: 'provided two essay ideas',
      parentEventId: 'task-1',
    });
    expect(event.type).toBe('activity.summary');
    expect(event.sourceLayer).toBe('system');
    expect(event.parentEventId).toBe('task-1');
    expect(event.payload).toEqual({ agentId: 'coordinator', conversationId: 'conv-1', taskEventId: 'task-1', summary: 'provided two essay ideas' });
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
