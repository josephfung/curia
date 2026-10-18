// principal.report — items for the principal's digest (#2159).
import { describe, it, expect } from 'vitest';
import { createPrincipalReport } from '../../../src/bus/events.js';
import { canPublish, canSubscribe } from '../../../src/bus/permissions.js';
import { extractStructuredFields } from '../../../src/audit/field-extraction.js';
import { createSilentLogger } from '../../../src/logger.js';

describe('principal.report', () => {
  const event = createPrincipalReport({
    summary: 'Replied to Dana confirming Tuesday.',
    urgency: 'digest',
    source: 'agent',
    conversationId: 'email:thread-1',
    parentEventId: 'task-1',
    sourceLayer: 'dispatch',
  });

  it('builds the event with the publishing layer kept off the payload', () => {
    expect(event.type).toBe('principal.report');
    expect(event.sourceLayer).toBe('dispatch');
    expect(event.parentEventId).toBe('task-1');
    expect(event.payload).toEqual({
      summary: 'Replied to Dana confirming Tuesday.',
      urgency: 'digest',
      source: 'agent',
      conversationId: 'email:thread-1',
    });
  });

  it('accepts the system layer', () => {
    const sys = createPrincipalReport({
      summary: 'Approval expired without an answer: Send email reply',
      urgency: 'digest',
      source: 'approval_expired',
      actionShortRef: 'abcd1234',
      parentEventId: 'task-2',
      sourceLayer: 'system',
    });
    expect(sys.sourceLayer).toBe('system');
    expect(sys.payload.actionShortRef).toBe('abcd1234');
  });

  it('is published by dispatch and system, and read only by system', () => {
    expect(canPublish('dispatch', 'principal.report')).toBe(true);
    expect(canPublish('system', 'principal.report')).toBe(true);
    expect(canPublish('agent', 'principal.report')).toBe(false);
    expect(canPublish('channel', 'principal.report')).toBe(false);
    expect(canPublish('execution', 'principal.report')).toBe(false);
    // A report can carry what Curia did for the principal; no channel or agent may read it.
    expect(canSubscribe('system', 'principal.report')).toBe(true);
    expect(canSubscribe('channel', 'principal.report')).toBe(false);
    expect(canSubscribe('dispatch', 'principal.report')).toBe(false);
    expect(canSubscribe('agent', 'principal.report')).toBe(false);
  });

  it('extracts structured audit columns keyed by source', () => {
    expect(extractStructuredFields(
      'principal.report',
      event.payload as unknown as Record<string, unknown>,
      'evt-report',
      createSilentLogger(),
    )).toEqual({
      action: 'report',
      outcome: 'success',
      target_type: 'principal',
      target_id: 'agent',
      initiator_type: 'system',
      initiator_id: 'agent',
    });
  });
});
