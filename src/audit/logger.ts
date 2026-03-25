import type { DbPool } from '../db/connection.js';
import type { BusEvent } from '../bus/events.js';
import type { Logger } from '../logger.js';

/**
 * Write-ahead audit logger. Persists every bus event to the audit_log table
 * BEFORE the event is delivered to other subscribers. This ensures audit
 * completeness even if the process crashes mid-delivery.
 *
 * The audit log is append-only — no UPDATE or DELETE operations.
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
}
