import type { DbPool } from '../db/connection.js';
import type { BusEvent } from '../bus/events.js';
import type { Logger } from '../logger.js';

/**
 * Write-ahead audit logger. Persists every bus event to the audit_log table
 * BEFORE the event is delivered to other subscribers. This ensures audit
 * completeness even if the process crashes mid-delivery.
 *
 * The audit log is append-only — no UPDATE or DELETE operations, with the
 * single exception of flipping `acknowledged` from false to true after
 * delivery has been attempted for all subscribers.
 */
export class AuditLogger {
  constructor(
    private pool: DbPool,
    private logger: Logger,
  ) {}

  /**
   * Log a bus event to the audit_log table.
   * Called as the write-ahead hook in the EventBus — runs before subscriber delivery.
   * Failures are logged and re-thrown (audit failures must never be silent).
   */
  async log(event: BusEvent): Promise<void> {
    // Derive source_id from the payload using the most specific identifier available.
    // Priority: agentId > channelId > sourceLayer (fallback for system events that
    // don't carry a domain-specific ID).
    //
    // We cast through `unknown` first because TypeScript won't directly allow
    // narrowing a discriminated union to Record<string, unknown> — the union's
    // member types don't have index signatures. The double cast is intentional
    // and safe here: we immediately guard each field with typeof checks below.
    const payload = event.payload as unknown as Record<string, unknown>;
    const sourceId =
      typeof payload.agentId === 'string'
        ? payload.agentId
        : typeof payload.channelId === 'string'
          ? payload.channelId
          : event.sourceLayer;

    // Extract conversationId for the dedicated column so it can be indexed separately.
    // Not all event types carry a conversationId (e.g., pure system events).
    const conversationId =
      typeof payload.conversationId === 'string' ? payload.conversationId : null;

    try {
      await this.pool.query(
        // All columns are explicitly listed so schema additions don't silently
        // shift positional parameters. task_id is omitted here (Phase 1 has no
        // task concept yet) and will default to NULL.
        `INSERT INTO audit_log (id, timestamp, event_type, source_layer, source_id, payload, conversation_id, parent_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          event.id,
          event.timestamp,
          event.type,
          event.sourceLayer,
          sourceId,
          JSON.stringify(event.payload),
          conversationId,
          event.parentEventId ?? null,
        ],
      );
    } catch (err) {
      // Audit failures must not be silent — log and re-throw so the bus can
      // decide whether to halt delivery or enter a degraded mode.
      this.logger.error({ err, eventId: event.id, eventType: event.type }, 'Audit log write failed');
      throw err;
    }
  }

  /**
   * Mark an audit_log row as acknowledged after delivery has been attempted.
   * This is the ONLY permitted UPDATE on audit_log — enforced by a database
   * trigger (migration 021) that rejects all other mutations.
   *
   * Called as the onDelivered hook in EventBus after all subscribers have been
   * attempted. Delivery is "attempted", not "succeeded" — per-subscriber errors
   * are swallowed by the bus and don't prevent acknowledgement.
   *
   * Errors are logged and re-thrown. A failed acknowledgement write is not
   * catastrophic — the row remains unacknowledged and surfaces in the startup
   * scan — but it should not be silently swallowed.
   */
  async markAcknowledged(eventId: string): Promise<void> {
    try {
      const result = await this.pool.query(
        // The WHERE clause guards against double-acknowledgement. The DB trigger
        // also rejects acknowledged = true → true flips, but the WHERE makes
        // the intent explicit in the application layer.
        `UPDATE audit_log SET acknowledged = true WHERE id = $1 AND acknowledged = false`,
        [eventId],
      );
      if ((result.rowCount ?? 0) === 0) {
        // 0 rows updated — either the row is already acknowledged (acceptable) or
        // the eventId was never inserted (would indicate the write-ahead INSERT
        // silently failed, leaving a gap in the audit trail).
        this.logger.warn({ eventId }, 'markAcknowledged matched 0 rows — row may already be acknowledged or eventId not found in audit_log');
      }
    } catch (err) {
      this.logger.error({ err, eventId }, 'Failed to mark audit log row as acknowledged');
      throw err;
    }
  }

  /**
   * Scan for audit_log rows that were written but never acknowledged.
   * Called once at startup, after migrations run and before serving requests.
   *
   * Unacknowledged rows indicate the process crashed between writing the
   * write-ahead record and completing subscriber delivery. They are flagged
   * here so operators can identify which events may not have been delivered.
   *
   * Replay of unacknowledged events is a separate feature (not yet implemented).
   * This scan is diagnostic only.
   */
  async scanForUnacknowledged(): Promise<void> {
    // Cap the number of events included in the log entry to avoid overflowing
    // log aggregator per-entry size limits (typically 64KB–256KB). The total
    // count is always logged so operators know whether rows were omitted.
    const LOG_LIMIT = 50;

    // Query the total count first — avoids materialising potentially millions
    // of rows into application memory (e.g. after a crash loop). Only if
    // unacknowledged rows exist do we fetch the first LOG_LIMIT details.
    //
    // Log at error — by the time this scan runs, the DB connection and schema
    // are already confirmed healthy (the migration runner would have exited on
    // any DB error). A failure here indicates a permissions problem, schema
    // mismatch, or query bug — not a transient connection blip. Startup
    // continues regardless (the scan is diagnostic only), but the error is
    // surfaced at the correct severity.
    let count: number;
    try {
      const countResult = await this.pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM audit_log WHERE acknowledged = false`,
      );
      count = parseInt(countResult.rows[0].count, 10);
    } catch (err) {
      this.logger.error({ err }, 'Audit log startup scan failed — could not query unacknowledged rows');
      return;
    }

    if (count === 0) {
      this.logger.debug('Audit log startup scan: no unacknowledged events');
      return;
    }

    // Fetch only the first LOG_LIMIT rows for the log entry — the total count
    // already tells operators the full scale of the problem.
    type ScanRow = { id: string; event_type: string; timestamp: Date };
    let shown: ScanRow[];
    try {
      const result = await this.pool.query<ScanRow>(
        `SELECT id, event_type, timestamp FROM audit_log WHERE acknowledged = false ORDER BY timestamp ASC LIMIT $1`,
        [LOG_LIMIT],
      );
      shown = result.rows;
    } catch (err) {
      this.logger.error({ err }, 'Audit log startup scan failed — could not fetch unacknowledged row details');
      return;
    }

    // Log at warn level — unacknowledged rows mean delivery may have been
    // incomplete on the previous run. This is not an error (crash recovery
    // is expected), but it warrants operator attention.
    this.logger.warn(
      {
        count,
        shown: shown.length,
        truncated: count > LOG_LIMIT,
        events: shown.map(r => ({ id: r.id, eventType: r.event_type, timestamp: r.timestamp })),
      },
      'Audit log startup scan: unacknowledged events detected — delivery may have been incomplete on previous run',
    );
  }
}
