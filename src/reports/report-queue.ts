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
//   - list() skips rows younger than REPORT_SETTLE_MS. The audit writer is asynchronous
//     (src/audit/logger.ts), so a row can land with a timestamp just before the newest row
//     already read. A cursor past it would skip it forever; the lag leaves room for it.
//
// The marker is a (timestamp, id) keyset, the same cursor shape AuditLogRepo paginates on.

import type { AuditLogRepo, AuditLogRow } from '../audit/audit-log-repo.js';
import type { PrincipalReportSource, PrincipalReportUrgency } from '../bus/events.js';
import type { ConfigStore } from '../memory/config-store.js';
import type { Logger } from '../logger.js';

export const REPORT_SETTLE_MS = 30_000;

const MARKER_NAMESPACE = 'reports';
const MARKER_KEY = 'last_reported';
const DEFAULT_LIMIT = 100;

const URGENCIES: ReadonlySet<string> = new Set<PrincipalReportUrgency>(['digest', 'now']);
const SOURCES: ReadonlySet<string> = new Set<PrincipalReportSource>([
  'agent', 'principal_note', 'blocked_content', 'approval_pending', 'approval_expired',
]);

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
  /** Pass to ack() once the digest is sent. Null when there was nothing to read. */
  cursor: string | null;
  /** More items wait beyond this batch's limit. */
  hasMore: boolean;
}

interface Marker {
  timestamp: Date;
  id: string;
}

export interface ReportQueueDeps {
  auditLogRepo: Pick<AuditLogRepo, 'findByEventTypes'>;
  configStore: Pick<ConfigStore, 'get' | 'set'>;
  logger: Logger;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export class ReportQueue {
  private readonly now: () => Date;

  constructor(private readonly deps: ReportQueueDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Items after the acknowledged marker, oldest first. Never moves the marker. */
  async list(limit: number = DEFAULT_LIMIT): Promise<ReportBatch> {
    const marker = await this.readMarker();
    const page = await this.deps.auditLogRepo.findByEventTypes(['principal.report'], {
      ...(marker ? { after: marker } : {}),
      to: this.settledBefore(),
      limit,
    });

    const items: ReportItem[] = [];
    for (const row of page.rows) {
      const item = this.toItem(row);
      if (item) items.push(item);
    }

    // The cursor covers every row read, malformed ones included, so a bad row is skipped
    // once (with a warning) rather than blocking the queue on every digest.
    const last = page.rows[page.rows.length - 1];
    return {
      items,
      cursor: last ? encodeCursor({ timestamp: last.timestamp, id: last.id }) : null,
      hasMore: page.hasMore,
    };
  }

  /**
   * Advance the marker to `cursor`. Returns false, leaving the marker where it was, when the
   * config store soft-rejects the write; the items then repeat in the next digest.
   * Throws on a cursor this queue did not issue.
   */
  async ack(cursor: string): Promise<boolean> {
    const marker = decodeCursor(cursor);
    if (!marker) throw new Error('invalid report cursor');
    const { stored } = await this.deps.configStore.set(MARKER_NAMESPACE, MARKER_KEY, encodeCursor(marker));
    if (!stored) {
      this.deps.logger.warn({ cursor }, 'report-queue: marker write rejected — items will repeat in the next digest');
    }
    return stored;
  }

  /** Timestamp of the oldest unacknowledged item, or null when nothing is waiting. */
  async oldestUnreported(): Promise<Date | null> {
    const marker = await this.readMarker();
    const page = await this.deps.auditLogRepo.findByEventTypes(['principal.report'], {
      ...(marker ? { after: marker } : {}),
      to: this.settledBefore(),
      limit: 1,
    });
    return page.rows[0]?.timestamp ?? null;
  }

  private settledBefore(): Date {
    return new Date(this.now().getTime() - REPORT_SETTLE_MS);
  }

  private async readMarker(): Promise<Marker | null> {
    const raw = await this.deps.configStore.get(MARKER_NAMESPACE, MARKER_KEY);
    if (raw === null) return null;
    const marker = decodeCursor(raw);
    if (!marker) {
      // Reading from the start re-reports old items; that beats silently reporting nothing.
      this.deps.logger.warn({ raw }, 'report-queue: stored marker is unreadable — reading from the start');
      return null;
    }
    return marker;
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
    const source = typeof p.source === 'string' && SOURCES.has(p.source)
      ? (p.source as PrincipalReportSource)
      : 'agent';
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

function encodeCursor(marker: Marker): string {
  return JSON.stringify({ t: marker.timestamp.toISOString(), id: marker.id });
}

function decodeCursor(raw: string): Marker | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON: the caller reports it (ack throws, readMarker warns). Nothing to log here.
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const { t, id } = parsed as { t?: unknown; id?: unknown };
  if (typeof t !== 'string' || typeof id !== 'string' || id === '') return null;
  const timestamp = new Date(t);
  if (Number.isNaN(timestamp.getTime())) return null;
  return { timestamp, id };
}
