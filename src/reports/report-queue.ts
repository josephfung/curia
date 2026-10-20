// report-queue.ts — the principal's digest queue (#2159).
//
// "Act, then tell" items, notices and approval mentions are published as principal.report
// bus events. The audit logger records every event in audit_log, so the queue needs no table
// of its own: this class reads principal.report rows back, oldest first, from a marker held
// in the config store.
//
// Two rules keep items from being lost:
//   - list() never moves the marker. Only ack() does, and the digest calls it after the
//     digest has actually been sent. A digest that fails to send repeats its items next
//     time; a duplicate line is cheap, a silently dropped notice is not.
//   - The cursor is audit_log.seq, not timestamp. seq is assigned under the hash chain's
//     transaction-scoped lock, so it follows commit order; an event's timestamp is set when
//     it is built, before it waits on that lock, so a timestamp cursor could pass over a
//     row that commits late.
//
// Cursors are seq values as decimal strings (BIGINT exceeds JS number precision). ack()
// accepts only a seq that names a real principal.report row, so an invented cursor ahead of
// the queue cannot silently skip what is waiting.

import type { AuditLogRepo, AuditLogRow } from '../audit/audit-log-repo.js';
import type { PrincipalReportSource, PrincipalReportUrgency } from '../bus/events.js';
import type { ConfigStore } from '../memory/config-store.js';
import type { Logger } from '../logger.js';

const EVENT_TYPE = 'principal.report';
const MARKER_NAMESPACE = 'reports';
const MARKER_KEY = 'last_reported';
const DEFAULT_LIMIT = 100;
const SEQ_PATTERN = /^\d{1,19}$/;

const URGENCIES: ReadonlySet<string> = new Set<PrincipalReportUrgency>(['digest', 'now']);
// Keyed by PrincipalReportSource so the compiler rejects this table when a source is added
// to the union and not here. A source missing here would have its items relabelled 'agent'
// in every digest (toItem's fallback), losing what produced them (#2159 added three).
const SOURCE_KEYS: Record<PrincipalReportSource, true> = {
  agent: true,
  principal_note: true,
  blocked_content: true,
  approval_pending: true,
  approval_expired: true,
  gate_proceeded: true,
  sent_without_review: true,
  claim_trimmed: true,
  relay_deferred: true,
};
const SOURCES: ReadonlySet<string> = new Set(Object.keys(SOURCE_KEYS));

/** ack() was handed a cursor that list() did not issue. */
export class InvalidReportCursorError extends Error {
  constructor(cursor: string) {
    super(`invalid report cursor: ${cursor.slice(0, 40)}`);
    this.name = 'InvalidReportCursorError';
  }
}

export interface ReportItem {
  id: string;
  at: Date;
  summary: string;
  urgency: PrincipalReportUrgency;
  source: PrincipalReportSource;
  conversationId?: string;
  link?: string;
  actionShortRef?: string;
}

export interface ReportBatch {
  items: ReportItem[];
  /** Pass to ack() once the digest is sent, or to list({ after }) for the next page. Null when nothing was read. */
  cursor: string | null;
  /** More items wait beyond this batch's limit. */
  hasMore: boolean;
}

export interface ReportQueueDeps {
  auditLogRepo: Pick<AuditLogRepo, 'findByEventTypeAfterSeq' | 'hasEventAtSeq'>;
  configStore: Pick<ConfigStore, 'get' | 'set'>;
  logger: Logger;
}

export class ReportQueue {
  constructor(private readonly deps: ReportQueueDeps) {}

  /**
   * Items after the acknowledged marker, oldest first, or after `after` (a cursor from an
   * earlier batch) when paging. Never moves the marker.
   */
  async list(opts: { limit?: number; after?: string } = {}): Promise<ReportBatch> {
    const after = opts.after !== undefined ? parseSeq(opts.after) : await this.readMarker();
    if (opts.after !== undefined && after === null) throw new InvalidReportCursorError(opts.after);

    const page = await this.deps.auditLogRepo.findByEventTypeAfterSeq(EVENT_TYPE, after, opts.limit ?? DEFAULT_LIMIT);

    const items: ReportItem[] = [];
    for (const { row } of page.rows) {
      const item = this.toItem(row);
      if (item) items.push(item);
    }

    // The cursor covers every row read, malformed ones included, so a bad row is skipped
    // once (with a warning) rather than blocking the queue on every digest.
    const last = page.rows[page.rows.length - 1];
    return { items, cursor: last ? last.seq : null, hasMore: page.hasMore };
  }

  /**
   * Advance the marker to `cursor`. Returns false, leaving the marker where it was, when the
   * config store soft-rejects the write; the items then repeat in the next digest.
   * Throws InvalidReportCursorError on a cursor this queue did not issue.
   */
  async ack(cursor: string): Promise<boolean> {
    const seq = parseSeq(cursor);
    if (seq === null || !(await this.deps.auditLogRepo.hasEventAtSeq(EVENT_TYPE, seq))) {
      throw new InvalidReportCursorError(cursor);
    }
    const { stored } = await this.deps.configStore.set(MARKER_NAMESPACE, MARKER_KEY, seq);
    if (!stored) {
      this.deps.logger.warn({ cursor }, 'report-queue: marker write rejected — items will repeat in the next digest');
    }
    return stored;
  }

  /** Timestamp of the oldest unacknowledged item, or null when nothing is waiting. */
  async oldestUnreported(): Promise<Date | null> {
    const page = await this.deps.auditLogRepo.findByEventTypeAfterSeq(EVENT_TYPE, await this.readMarker(), 1);
    return page.rows[0]?.row.timestamp ?? null;
  }

  private async readMarker(): Promise<string | null> {
    const raw = await this.deps.configStore.get(MARKER_NAMESPACE, MARKER_KEY);
    if (raw === null) return null;
    const seq = parseSeq(raw);
    if (seq === null) {
      // Reading from the start re-reports old items; that beats silently reporting nothing.
      this.deps.logger.warn({ raw: raw.slice(0, 40) }, 'report-queue: stored marker is unreadable — reading from the start');
    }
    return seq;
  }

  private toItem(row: AuditLogRow): ReportItem | null {
    const p = row.payload;
    if (typeof p.summary !== 'string' || p.summary.trim() === '') {
      this.deps.logger.warn({ auditId: row.id }, 'report-queue: principal.report row has no summary — skipped');
      return null;
    }
    // Unknown urgency or source fall back rather than drop the item: the summary is what
    // the principal reads, and the enums only shape how it is grouped.
    const urgency = typeof p.urgency === 'string' && URGENCIES.has(p.urgency)
      ? (p.urgency as PrincipalReportUrgency)
      : 'digest';
    const knownSource = typeof p.source === 'string' && SOURCES.has(p.source);
    if (!knownSource) {
      // A row from an older or newer build: keep it, but say so, or the relabel is invisible.
      this.deps.logger.warn({ auditId: row.id, source: p.source }, 'report-queue: unknown report source — listed as agent');
    }
    const source = knownSource ? (p.source as PrincipalReportSource) : 'agent';
    return {
      id: row.id,
      at: row.timestamp,
      summary: p.summary,
      urgency,
      source,
      ...(typeof p.conversationId === 'string' ? { conversationId: p.conversationId } : {}),
      ...(typeof p.link === 'string' ? { link: p.link } : {}),
      ...(typeof p.actionShortRef === 'string' ? { actionShortRef: p.actionShortRef } : {}),
    };
  }
}

/** A seq as a canonical decimal string, or null when `raw` is not one. */
function parseSeq(raw: string): string | null {
  const trimmed = raw.trim();
  return SEQ_PATTERN.test(trimmed) ? trimmed : null;
}
