// event-record.ts — shared shape for audit events returned by the diagnostics
// skills (audit-query, audit-trace). Keeps the structural fields an investigator
// cites (id, parent_event_id, type) while replacing the raw payload with a
// bounded, PII-scrubbed summary (see redact.ts).

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
  payloadSummary: unknown;
}

export function toEventRecord(row: AuditLogRow, tz?: string): DiagnosticEventRecord {
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
    payloadSummary: summarizePayload(row.payload),
  };
}
