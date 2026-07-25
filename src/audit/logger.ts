import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import type { BusEvent, LlmCallArchiveContent } from '../bus/events.js';
import type { Logger } from '../logger.js';
import {
  createDbUnavailableAgentError,
  isDbUnavailableError,
  withDbRetry,
} from '../db/resilience.js';
import { extractStructuredFields } from './field-extraction.js';
import {
  GENESIS_HASH,
  computeEntryHash,
  toHashTimestamp,
  type HashChainFields,
} from './hash-chain.js';
import { writeLlmCallArchive } from './llm-call-archive.js';

/**
 * Recursively strip null bytes (U+0000) from all string values in an object.
 *
 * PostgreSQL cannot store U+0000 in text or JSONB columns — it rejects the
 * write with error 22P05 ("unsupported Unicode escape sequence"). Skill
 * payloads (especially web-fetch results) can carry null bytes when the
 * fetched URL returns binary or mixed-encoding content. Stripping them here,
 * at the single write-path into audit_log, is the correct choke point: it
 * covers all event types regardless of which skill produced the payload.
 *
 * Null bytes are replaced with '' (empty string) rather than a placeholder
 * like '<0x00>' to keep payloads clean for downstream consumers. The loss of
 * the byte is acceptable — audit payloads are diagnostic records, not
 * faithful binary stores.
 */
function stripNullBytes(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\u0000/g, '');
  }
  if (Array.isArray(value)) {
    return value.map(stripNullBytes);
  }
  // Only recurse into plain objects. Non-plain objects (Date, Buffer, RegExp, etc.)
  // must pass through untouched — Object.entries() on a Date returns [] which would
  // silently replace the Date with {}, corrupting timestamp fields like mergedAt.
  // JSON.stringify handles non-plain objects correctly on its own (e.g. Date.toISOString()).
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, stripNullBytes(v)]),
    );
  }
  return value;
}

/**
 * True while {@link AuditLogger} holds the hash-chain write transaction.
 * Nested `log()` (e.g. publishing a bus event from inside the write path)
 * would deadlock on the advisory lock — fail loudly instead.
 */
const auditWriteDepth = new AsyncLocalStorage<true>();

export interface AuditLoggerOptions {
  /** When false, skip llm_call_archive writes even if the event carries archive content. Default true. */
  llmCallArchiveEnabled?: boolean;
}

/**
 * Write-ahead audit logger. Persists every bus event to the audit_log table
 * BEFORE the event is delivered to other subscribers. This ensures audit
 * completeness even if the process crashes mid-delivery.
 *
 * Phase 1 hardening (#1383 / spec 10): also extracts structured columns,
 * maintains a SHA-256 hash chain (entry_hash), and atomically writes
 * llm_call_archive rows for llm.call events.
 *
 * Hash-chain writes are serialized with a transaction-scoped advisory lock
 * and ordered by the monotonic `seq` column (not wall-clock timestamp).
 * Chain head is always re-read under the lock — there is no in-memory
 * previous-hash cache (single source of truth in the DB).
 *
 * INVARIANT: never publish a bus event from inside the audit write
 * transaction. Doing so re-enters `log()` on another pooled client and
 * deadlocks on {@link AuditLogger.HASH_CHAIN_LOCK_KEY}.
 *
 * The audit log is append-only — no UPDATE or DELETE operations, with the
 * single exception of flipping `acknowledged` from false to true after
 * delivery has been attempted for all subscribers.
 */
export class AuditLogger {
  /**
   * Advisory-lock key for the global audit hash chain.
   * Stable across processes; chosen to avoid colliding with other Curia locks.
   */
  static readonly HASH_CHAIN_LOCK_KEY = 0x43555249; // 'CURI'

  private readonly llmCallArchiveEnabled: boolean;

  constructor(
    /** Real pg Pool — `.connect()` is required for the hash-chain transaction. */
    private pool: Pool,
    private logger: Logger,
    options: AuditLoggerOptions = {},
  ) {
    this.llmCallArchiveEnabled = options.llmCallArchiveEnabled !== false;
  }

  /**
   * Startup readiness check: confirm the hash-chain schema is present and log
   * the current head. Does not cache chain state — every write re-reads under
   * the advisory lock.
   */
  async seedHashChain(): Promise<void> {
    try {
      const result = await this.pool.query<{ entry_hash: string | null; seq: string }>(
        `SELECT entry_hash, seq::text AS seq FROM audit_log
         WHERE entry_hash IS NOT NULL
         ORDER BY seq DESC
         LIMIT 1`,
      );
      const latest = result.rows[0];
      this.logger.debug(
        {
          seededFrom: latest?.entry_hash ? 'latest_row' : 'genesis',
          headSeq: latest?.seq ?? null,
          hashPrefix: (latest?.entry_hash ?? GENESIS_HASH).slice(0, 12),
        },
        'Audit hash chain ready',
      );
    } catch (err) {
      // Fail closed — missing seq/entry_hash columns mean migrations have not run.
      this.logger.error({ err }, 'Audit hash chain seed failed');
      throw err;
    }
  }

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

    // Populate task_id when present in payload (additive — no backfill of historical rows).
    // schedule.fired emits agentTaskId; normalize to the canonical taskId key.
    const taskId =
      typeof payload.taskId === 'string'
        ? payload.taskId
        : typeof payload.agentTaskId === 'string'
          ? payload.agentTaskId
          : null;

    const parentEventId = event.parentEventId ?? null;

    // Structured columns — extraction failures become '[EXTRACTION_FAILED]'.
    const structured = extractStructuredFields(event.type, payload, event.id, this.logger);

    // Sanitize before the DB write in a separate try/catch so a sanitization
    // failure is logged with its own distinct message — not conflated with a
    // DB connectivity or schema error from the INSERT below.
    // TODO: JSON.stringify can also throw on circular references (pre-existing,
    // not introduced here). If that becomes a live issue, wrap it separately too.
    let sanitizedPayload: unknown;
    let serializedPayload: string;
    try {
      sanitizedPayload = stripNullBytes(event.payload);
      serializedPayload = JSON.stringify(sanitizedPayload);
    } catch (err) {
      this.logger.error({ err, eventId: event.id, eventType: event.type }, 'Audit log payload sanitization failed — event not written');
      throw err;
    }

    // Typed, non-persisted archive on llm.call — never part of payload / hash.
    const archiveContent: LlmCallArchiveContent | undefined =
      event.type === 'llm.call' && this.llmCallArchiveEnabled
        ? event.archive
        : undefined;

    try {
      // Critical path: fail fast on DB unavailability (no long retry loop).
      // Spec 05 / #1381 — audit is write-ahead; an outage must surface as a
      // classified error to publishers rather than hang or swallow.
      await this.withTransaction(async (client) => {
        // Serialize hash-chain appends across processes / parallel test workers.
        await client.query('SELECT pg_advisory_xact_lock($1)', [AuditLogger.HASH_CHAIN_LOCK_KEY]);

        const head = await client.query<{ entry_hash: string | null }>(
          `SELECT entry_hash FROM audit_log
           WHERE entry_hash IS NOT NULL
           ORDER BY seq DESC
           LIMIT 1`,
        );
        const previousHash = typeof head.rows[0]?.entry_hash === 'string' && head.rows[0].entry_hash.length > 0
          ? head.rows[0].entry_hash
          : GENESIS_HASH;

        // timestamp is the factual event time — never mutated for chain ordering.
        // Chain/verify order is the BIGSERIAL `seq` column (migration 080).
        const hashFields: HashChainFields = {
          id: event.id,
          timestamp: toHashTimestamp(event.timestamp),
          event_type: event.type,
          source_layer: event.sourceLayer,
          source_id: sourceId,
          payload: sanitizedPayload,
          conversation_id: conversationId,
          task_id: taskId,
          parent_event_id: parentEventId,
          action: structured.action,
          outcome: structured.outcome,
          target_type: structured.target_type,
          target_id: structured.target_id,
          initiator_type: structured.initiator_type,
          initiator_id: structured.initiator_id,
        };
        const entryHash = computeEntryHash(hashFields, previousHash);

        await client.query(
          `INSERT INTO audit_log (
             id, timestamp, event_type, source_layer, source_id, payload,
             conversation_id, task_id, parent_event_id,
             action, outcome, target_type, target_id,
             initiator_type, initiator_id, entry_hash
           ) VALUES (
             $1, $2, $3, $4, $5, $6,
             $7, $8, $9,
             $10, $11, $12, $13,
             $14, $15, $16
           )`,
          [
            event.id,
            event.timestamp,
            event.type,
            event.sourceLayer,
            sourceId,
            serializedPayload,
            conversationId,
            taskId,
            parentEventId,
            structured.action,
            structured.outcome,
            structured.target_type,
            structured.target_id,
            structured.initiator_type,
            structured.initiator_id,
            entryHash,
          ],
        );

        if (archiveContent !== undefined) {
          await writeLlmCallArchive(client, event.id, archiveContent, this.logger);
        }
      });
    } catch (err) {
      // Audit failures must not be silent — log and re-throw so the bus can
      // decide whether to halt delivery or enter a degraded mode.
      if (isDbUnavailableError(err)) {
        const agentErr = createDbUnavailableAgentError('audit', err);
        this.logger.error(
          { err: agentErr, eventId: event.id, eventType: event.type },
          'Audit log write failed — database unavailable',
        );
        throw Object.assign(new Error(agentErr.message), {
          code: agentErr.context.code,
          agentError: agentErr,
        });
      }
      this.logger.error({ err, eventId: event.id, eventType: event.type }, 'Audit log write failed');
      throw err;
    }
  }

  /**
   * Run `fn` inside BEGIN/COMMIT with the audit-write depth flag set.
   * Nested entry (bus publish → log → withTransaction) throws instead of
   * deadlocking on the advisory lock.
   */
  private async withTransaction(fn: (client: PoolClient) => Promise<void>): Promise<void> {
    if (auditWriteDepth.getStore()) {
      throw new Error(
        'BUG: nested AuditLogger.log() inside the audit write transaction — ' +
          'never publish a bus event from within the hash-chain write path',
      );
    }

    await auditWriteDepth.run(true, async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await fn(client);
        await client.query('COMMIT');
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          this.logger.error({ err: rollbackErr }, 'Audit log transaction rollback failed');
        }
        throw err;
      } finally {
        client.release();
      }
    });
  }

  /**
   * Mark an audit_log row as acknowledged after delivery has been attempted.
   * This is the ONLY permitted UPDATE on audit_log — enforced by a database
   * trigger (migration 021, extended in 078/080) that rejects all other mutations.
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
      // Non-critical path: acknowledgement can retry briefly on transient
      // outages. Delivery already completed; a delayed ack is preferable to
      // an immediate throw that the bus would only log anyway (#1381).
      const result = await withDbRetry(() =>
        this.pool.query(
          // The WHERE clause guards against double-acknowledgement. The DB trigger
          // also rejects acknowledged = true → true flips, but the WHERE makes
          // the intent explicit in the application layer.
          `UPDATE audit_log SET acknowledged = true WHERE id = $1 AND acknowledged = false`,
          [eventId],
        ),
      );
      if ((result.rowCount ?? 0) === 0) {
        // 0 rows updated — either the row is already acknowledged (acceptable) or
        // the eventId was never inserted (would indicate the write-ahead INSERT
        // silently failed, leaving a gap in the audit trail).
        this.logger.warn({ eventId }, 'markAcknowledged matched 0 rows — row may already be acknowledged or eventId not found in audit_log');
      }
    } catch (err) {
      if (isDbUnavailableError(err)) {
        const agentErr = createDbUnavailableAgentError('audit', err);
        this.logger.error(
          { err: agentErr, eventId },
          'Failed to mark audit log row as acknowledged — database unavailable',
        );
        throw Object.assign(new Error(agentErr.message), {
          code: agentErr.context.code,
          agentError: agentErr,
        });
      }
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
      // COUNT(*) always returns exactly one row, but TypeScript's pg typings
      // type rows as T[] (no tuple inference), so rows[0] is technically T|undefined.
      // The `?? '0'` fallback satisfies the type checker without altering behaviour.
      count = parseInt(countResult.rows[0]?.count ?? '0', 10);
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
