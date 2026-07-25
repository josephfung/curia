// field-extraction.ts — deterministic structured-field extraction for audit_log
// (spec 10 §Field Extraction). Runs inside AuditLogger before INSERT.
//
// Extraction Failure Policy: missing/mistyped mapped fields become the sentinel
// '[EXTRACTION_FAILED]' (not NULL — NULL means pre-migration). Unmapped event
// types leave all structured columns NULL.

import type { Logger } from '../logger.js';

/** Sentinel written when a mapped field is missing or mistyped. */
export const EXTRACTION_FAILED = '[EXTRACTION_FAILED]';

/** Shared initiator literals for system/dispatch-originated events (queryable dimension). */
export const INITIATOR_TYPE_SYSTEM = 'system';
export const INITIATOR_ID_DISPATCH = 'dispatch';

export interface StructuredAuditFields {
  action: string | null;
  outcome: string | null;
  target_type: string | null;
  target_id: string | null;
  initiator_type: string | null;
  initiator_id: string | null;
}

const ALL_NULL: StructuredAuditFields = {
  action: null,
  outcome: null,
  target_type: null,
  target_id: null,
  initiator_type: null,
  initiator_id: null,
};

type Extractor = (
  payload: Record<string, unknown>,
  fail: (field: string) => string,
) => StructuredAuditFields;

function str(
  payload: Record<string, unknown>,
  field: string,
  fail: (field: string) => string,
): string {
  const v = payload[field];
  return typeof v === 'string' && v.length > 0 ? v : fail(field);
}

/** toolName with legacy skillName fallback (pre-ADR-031 rows / dual vocabulary). */
function toolName(
  payload: Record<string, unknown>,
  fail: (field: string) => string,
): string {
  if (typeof payload.toolName === 'string' && payload.toolName.length > 0) {
    return payload.toolName;
  }
  if (typeof payload.skillName === 'string' && payload.skillName.length > 0) {
    return payload.skillName;
  }
  return fail('toolName');
}

function toolResultOutcome(
  payload: Record<string, unknown>,
  fail: (field: string) => string,
): string {
  const result = payload.result;
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return fail('result.success');
  }
  const success = (result as Record<string, unknown>).success;
  if (typeof success !== 'boolean') {
    return fail('result.success');
  }
  return success ? 'success' : 'failure';
}

const extractToolInvoke: Extractor = (p, fail) => ({
  action: 'execute',
  outcome: 'pending',
  target_type: 'skill',
  target_id: toolName(p, fail),
  initiator_type: 'agent',
  initiator_id: str(p, 'agentId', fail),
});

const extractToolResult: Extractor = (p, fail) => ({
  action: 'execute',
  outcome: toolResultOutcome(p, fail),
  target_type: 'skill',
  target_id: toolName(p, fail),
  initiator_type: 'agent',
  initiator_id: str(p, 'agentId', fail),
});

/**
 * Mapping table from spec 10. Also covers pre-ADR-031 `skill.*` aliases so any
 * residual dual-vocabulary emitters still get structured columns.
 */
const EXTRACTORS: Readonly<Record<string, Extractor>> = {
  'inbound.message': (p, fail) => ({
    action: 'receive',
    outcome: 'success',
    target_type: 'conversation',
    target_id: str(p, 'conversationId', fail),
    initiator_type: 'human',
    initiator_id: str(p, 'senderId', fail),
  }),

  // Spec 10 maps agent.task → system/dispatch. Originator (human vs principal
  // vs scheduler) lives in payload.metadata.originator for trust-gate / Gate C;
  // it is intentionally NOT mirrored into initiator_* (keeps extraction parent-
  // lookup-free). trust-gate must not assume initiator_type = 'human' here.
  'agent.task': (p, fail) => ({
    action: 'delegate',
    outcome: 'pending',
    target_type: 'agent',
    target_id: str(p, 'agentId', fail),
    initiator_type: INITIATOR_TYPE_SYSTEM,
    initiator_id: INITIATOR_ID_DISPATCH,
  }),

  'agent.response': (p, fail) => ({
    action: 'respond',
    outcome: 'success',
    target_type: 'conversation',
    target_id: str(p, 'conversationId', fail),
    initiator_type: 'agent',
    initiator_id: str(p, 'agentId', fail),
  }),

  'outbound.message': (p, fail) => ({
    action: 'send',
    outcome: 'success',
    target_type: 'conversation',
    target_id: str(p, 'conversationId', fail),
    initiator_type: INITIATOR_TYPE_SYSTEM,
    initiator_id: INITIATOR_ID_DISPATCH,
  }),

  // Spec maps initiator to channel / channelId; outbound.delivered payload uses `channel`.
  'outbound.delivered': (p, fail) => ({
    action: 'deliver',
    outcome: 'success',
    target_type: 'conversation',
    target_id: typeof p.conversationId === 'string' && p.conversationId.length > 0
      ? p.conversationId
      : fail('conversationId'),
    initiator_type: 'channel',
    initiator_id: str(p, 'channel', fail),
  }),

  'tool.invoke': extractToolInvoke,
  'skill.invoke': extractToolInvoke,

  'tool.result': extractToolResult,
  'skill.result': extractToolResult,

  'memory.store': (p, fail) => ({
    action: 'create',
    outcome: 'success',
    target_type: 'kg_node',
    target_id: str(p, 'nodeId', fail),
    initiator_type: 'agent',
    initiator_id: str(p, 'agentId', fail),
  }),

  'memory.query': (p, fail) => ({
    action: 'read',
    outcome: 'success',
    target_type: 'knowledge_graph',
    target_id: str(p, 'queryType', fail),
    initiator_type: 'agent',
    initiator_id: str(p, 'agentId', fail),
  }),

  'contact.resolved': (p, fail) => ({
    action: 'resolve',
    outcome: 'success',
    target_type: 'contact',
    target_id: str(p, 'contactId', fail),
    initiator_type: INITIATOR_TYPE_SYSTEM,
    initiator_id: INITIATOR_ID_DISPATCH,
  }),

  'contact.unknown': (p, fail) => ({
    action: 'resolve',
    outcome: 'failure',
    target_type: 'contact',
    target_id: str(p, 'senderId', fail),
    initiator_type: INITIATOR_TYPE_SYSTEM,
    initiator_id: INITIATOR_ID_DISPATCH,
  }),

  // Spec lists message.held; the event type is reserved but not yet emitted.
  // Keep the mapping ready so structured columns populate the day it ships.
  'message.held': (p, fail) => ({
    action: 'hold',
    outcome: 'pending',
    target_type: 'message',
    target_id: str(p, 'heldMessageId', fail),
    initiator_type: INITIATOR_TYPE_SYSTEM,
    initiator_id: INITIATOR_ID_DISPATCH,
  }),
};

/**
 * Extract structured audit columns for an event. Never throws — failures become
 * the EXTRACTION_FAILED sentinel and a warning log.
 */
export function extractStructuredFields(
  eventType: string,
  payload: Record<string, unknown>,
  eventId: string,
  logger: Logger,
): StructuredAuditFields {
  const extractor = EXTRACTORS[eventType];
  if (!extractor) {
    logger.debug(
      { eventId, eventType },
      'Audit field extraction: unmapped event type — structured columns left NULL',
    );
    return { ...ALL_NULL };
  }

  const failedFields: string[] = [];
  const fail = (field: string): string => {
    failedFields.push(field);
    return EXTRACTION_FAILED;
  };

  const fields = extractor(payload, fail);

  if (failedFields.length > 0) {
    logger.warn(
      { eventId, eventType, failedFields },
      'Audit field extraction failed for one or more mapped fields — wrote [EXTRACTION_FAILED] sentinel',
    );
  }

  return fields;
}
