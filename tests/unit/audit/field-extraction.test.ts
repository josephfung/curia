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
});
