// event-record.ts — shared shape for audit events returned by the diagnostics
// skills (audit-query, audit-trace). Keeps the structural fields an investigator
// cites (id, parent_event_id, type) while replacing the raw payload with a
// bounded, PII-scrubbed summary (see redact.ts).

import type { AuditLogRow } from '../audit/audit-log-repo.js';
import { toLocalIso } from '../time/timestamp.js';
import { summarizePayload } from './redact.js';

export interface DiagnosticEventRecord {
  id: string;
  /** Local-timezone ISO string for display; falls back to UTC when tz is absent. */
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
    timestamp: toLocalIso(Math.floor(row.timestamp.getTime() / 1000), tz) ?? row.timestamp.toISOString(),
    eventType: row.eventType,
    sourceLayer: row.sourceLayer,
    sourceId: row.sourceId,
    conversationId: row.conversationId,
    parentEventId: row.parentEventId,
    payloadSummary: summarizePayload(row.payload),
  };
}
