// event-record.ts — shared shape for audit events returned by the diagnostics
// skills (audit-query, audit-trace). Keeps the structural fields an investigator
// cites (id, parent_event_id, type, action/outcome/target/initiator) while
// replacing the raw payload with a bounded, PII-scrubbed summary (see redact.ts).

import type { AuditLogRow } from '../audit/audit-log-repo.js';
import { toLocalIso } from '../time/timestamp.js';
import { summarizePayload } from './redact.js';

export interface DiagnosticEventRecord {
  id: string;
  /** Local-timezone ISO string for display (UTC when no tz is configured, per
   *  toLocalIso). The literal 'unknown' only when the row's own timestamp is
   *  corrupt/non-finite — never a raw fabricated value. */
  timestamp: string;
  eventType: string;
  sourceLayer: string;
  sourceId: string;
  conversationId: string | null;
  parentEventId: string | null;
  /** Structured action taxonomy verb — null on pre-hardening rows. */
  action: string | null;
  /** Structured outcome — null on pre-hardening rows. */
  outcome: string | null;
  /** `{ type, id }` when either structured target column is present. */
  target: { type: string | null; id: string | null } | null;
  /** `{ type, id }` when either structured initiator column is present. */
  initiator: { type: string | null; id: string | null } | null;
  payloadSummary: unknown;
}

export function toEventRecord(row: AuditLogRow, tz?: string): DiagnosticEventRecord {
  const hasTarget = row.targetType !== null || row.targetId !== null;
  const hasInitiator = row.initiatorType !== null || row.initiatorId !== null;
  return {
    id: row.id,
    // toLocalIso returns null ONLY when the timestamp is corrupt (non-finite/≤0).
    // In that case surface an explicit sentinel rather than `row.timestamp.toISOString()`,
    // which would either throw (Invalid Date) or emit a raw UTC `Z` string the timestamp
    // convention forbids. A wrong-but-formatted "now" would be worse for a forensic tool.
    timestamp: toLocalIso(Math.floor(row.timestamp.getTime() / 1000), tz) ?? 'unknown',
    eventType: row.eventType,
    sourceLayer: row.sourceLayer,
    sourceId: row.sourceId,
    conversationId: row.conversationId,
    parentEventId: row.parentEventId,
    action: row.action,
    outcome: row.outcome,
    target: hasTarget ? { type: row.targetType, id: row.targetId } : null,
    initiator: hasInitiator ? { type: row.initiatorType, id: row.initiatorId } : null,
    payloadSummary: summarizePayload(row.payload),
  };
}
