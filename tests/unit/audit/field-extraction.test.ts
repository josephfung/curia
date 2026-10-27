import { describe, it, expect, vi } from 'vitest';
import {
  EXTRACTION_FAILED,
  extractStructuredFields,
} from '../../../src/audit/field-extraction.js';
import { createSilentLogger } from '../../../src/logger.js';

const logger = createSilentLogger();

describe('extractStructuredFields', () => {
  it('maps inbound.message per spec 10', () => {
    expect(extractStructuredFields(
      'inbound.message',
      { conversationId: 'c1', senderId: 's1', channelId: 'email', content: 'hi' },
      'evt-1',
      logger,
    )).toEqual({
      action: 'receive',
      outcome: 'success',
      target_type: 'conversation',
      target_id: 'c1',
      initiator_type: 'human',
      initiator_id: 's1',
    });
  });

  it('maps a requested document.console_action as pending (write-ahead)', () => {
    expect(extractStructuredFields(
      'document.console_action',
      { stage: 'requested', action: 'update', path: '/projects/x/brief.md', initiatedBy: 'principal', channel: 'console' },
      'evt-doc-req',
      logger,
    )).toMatchObject({ action: 'update', outcome: 'pending', target_id: '/projects/x/brief.md' });
  });

  it('maps document.console_action onto the working document (#1822)', () => {
    expect(extractStructuredFields(
      'document.console_action',
      { stage: 'completed', action: 'archive', path: '/projects/x/brief.md', initiatedBy: 'principal', channel: 'console' },
      'evt-doc',
      logger,
    )).toEqual({
      action: 'archive',
      outcome: 'success',
      target_type: 'working_document',
      target_id: '/projects/x/brief.md',
      initiator_type: 'human',
      initiator_id: 'principal',
    });
  });

  it('maps tool.result outcome from result.success', () => {
    expect(extractStructuredFields(
      'tool.result',
      {
        agentId: 'calendar',
        conversationId: 'c1',
        toolName: 'calendar-create',
        result: { success: false, error: 'nope' },
        durationMs: 1,
      },
      'evt-2',
      logger,
    )).toMatchObject({
      action: 'execute',
      outcome: 'failure',
      target_type: 'skill',
      target_id: 'calendar-create',
      initiator_type: 'agent',
      initiator_id: 'calendar',
    });
  });

  it('maps kg.nodes_merged to the surviving node, initiated by the principal (#2233)', () => {
    expect(extractStructuredFields(
      'kg.nodes_merged',
      { survivorId: 'node-s', absorbedId: 'node-a', actor: { contactId: 'principal-1', channel: 'console' } },
      'evt-kg',
      logger,
    )).toEqual({
      action: 'merge',
      outcome: 'success',
      target_type: 'kg_node',
      target_id: 'node-s',
      initiator_type: 'human',
      initiator_id: 'principal-1',
    });
    // No resolved principal: the console itself is the initiator.
    expect(extractStructuredFields('kg.nodes_merged', { survivorId: 'node-s', actor: null }, 'evt-kg2', logger).initiator_id)
      .toBe('console');
  });

  it('writes EXTRACTION_FAILED sentinel and warns on missing mapped fields', () => {
    const warn = vi.spyOn(logger, 'warn');
    const fields = extractStructuredFields(
      'inbound.message',
      { channelId: 'email', content: 'hi' }, // missing conversationId + senderId
      'evt-3',
      logger,
    );
    expect(fields.target_id).toBe(EXTRACTION_FAILED);
    expect(fields.initiator_id).toBe(EXTRACTION_FAILED);
    expect(warn).toHaveBeenCalled();
  });

  it('maps delegation.requester_context onto the delegation target (#1859)', () => {
    expect(extractStructuredFields(
      'delegation.requester_context',
      {
        delegateEventId: 'task-1',
        taskId: 'task-1',
        agentId: 'calendar',
        conversationId: 'conv-1',
        contactId: 'ceo-contact-id',
        channel: 'signal',
        systemRole: 'principal',
        tier: 'principal',
        tierPresent: true,
        delegatedAddendumApplied: true,
      },
      'evt-req',
      logger,
    )).toEqual({
      action: 'record',
      outcome: 'success',
      target_type: 'delegation',
      target_id: 'task-1',
      initiator_type: 'agent',
      initiator_id: 'calendar',
    });
    expect(extractStructuredFields(
      'delegation.requester_context',
      {
        delegateEventId: 'task-2',
        agentId: 'calendar',
        delegatedAddendumApplied: false,
      },
      'evt-req-drop',
      logger,
    ).outcome).toBe('failure');
  });

  it('maps delegation.principal_note onto the conversation it came from (#1990)', () => {
    expect(extractStructuredFields(
      'delegation.principal_note',
      {
        agentId: 'coordinator',
        conversationId: 'email:thread-1',
        targetAgent: 'ceo-inbox',
        reason: 'timeout',
        note: 'Thread not found.',
        followUpLogged: true,
        reviewTaskId: 'task-1',
        addedToReviewTask: true,
        replyVia: 'model',
      },
      'evt-note',
      logger,
    )).toEqual({
      action: 'record',
      outcome: 'success',
      target_type: 'conversation',
      target_id: 'email:thread-1',
      initiator_type: 'agent',
      initiator_id: 'coordinator',
    });
  });

  it('leaves structured columns NULL for unmapped event types', () => {
    const debug = vi.spyOn(logger, 'debug');
    expect(extractStructuredFields('llm.call', { agentId: 'a' }, 'evt-4', logger)).toEqual({
      action: null,
      outcome: null,
      target_type: null,
      target_id: null,
      initiator_type: null,
      initiator_id: null,
    });
    expect(debug).toHaveBeenCalled();
  });

  it('accepts legacy skillName on tool.result', () => {
    expect(extractStructuredFields(
      'skill.result',
      {
        agentId: 'a',
        conversationId: 'c',
        skillName: 'email-send',
        result: { success: true, data: {} },
        durationMs: 1,
      },
      'evt-5',
      logger,
    ).target_id).toBe('email-send');
  });

  it('maps outbound.no_reply as suppress/success on the conversation', () => {
    expect(extractStructuredFields(
      'outbound.no_reply',
      {
        routingTaskId: 'task-1',
        agentId: 'coordinator',
        conversationId: 'email:thread-abc',
        channelId: 'email',
        reason: 'agent_declined',
      },
      'evt-6',
      logger,
    )).toEqual({
      action: 'suppress',
      outcome: 'success',
      target_type: 'conversation',
      target_id: 'email:thread-abc',
      initiator_type: 'system',
      initiator_id: 'dispatch',
    });
  });

  it('maps outbound.judge outcomes into spec 10 enum (#1911)', () => {
    expect(extractStructuredFields(
      'outbound.judge',
      { conversationId: 'c1', channelId: 'email', outcome: 'failed_open', failMode: 'split' },
      'evt-7',
      logger,
    )).toEqual({
      action: 'judge',
      outcome: 'error',
      target_type: 'conversation',
      target_id: 'c1',
      initiator_type: 'system',
      initiator_id: 'dispatch',
    });
    expect(extractStructuredFields(
      'outbound.judge',
      { conversationId: 'c1', channelId: 'email', outcome: 'failed_closed', failMode: 'closed', reasonCode: 'unreachable' },
      'evt-7b',
      logger,
    ).outcome).toBe('error');
    expect(extractStructuredFields(
      'outbound.judge',
      { conversationId: 'c1', channelId: 'signal', outcome: 'skipped_principal_sole' },
      'evt-8',
      logger,
    ).outcome).toBe('success');
    expect(extractStructuredFields(
      'outbound.judge',
      { conversationId: 'c1', channelId: 'email', outcome: 'judged_block', failMode: 'split', reasonCode: 'audience_leak' },
      'evt-9',
      logger,
    ).outcome).toBe('denied');
  });

  it('maps agent.task.input_injected without reading a message body (#2018)', () => {
    const host = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const inbound = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const sender = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    expect(extractStructuredFields(
      'agent.task.input_injected',
      {
        hostTaskEventId: host,
        inboundEventId: inbound,
        conversationId: 'signal:+1555',
        agentId: 'coordinator',
        drainPoint: 'turn_start',
        senderContactId: sender,
        content: 'this must not become a column',
      },
      'evt-inject',
      logger,
    )).toEqual({
      action: 'inject',
      outcome: 'success',
      target_type: 'conversation',
      target_id: 'signal:+1555',
      initiator_type: 'human',
      initiator_id: sender,
    });
  });
});
