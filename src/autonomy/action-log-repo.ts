// action-log-repo.ts — database operations for autonomy_action_log.
//
// All queries use parameterized SQL (no string interpolation).
// This repo is consumed by the AutonomyScoringPass and by the approval
// lifecycle skills (#427/#428/#429).

import type { Pool } from 'pg';
import type { Logger } from '../logger.js';
import type {
  ActionLogRow,
  ActionLogInsert,
  ScoringFlags,
  ResolveResult,
} from './action-log-types.js';
import { TERMINAL_OUTCOMES } from './action-log-types.js';

export class ActionLogRepo {
  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
  ) {}

  /** Insert a new row and return the generated id. */
  async insert(row: ActionLogInsert): Promise<number> {
    const result = await this.pool.query<{ id: number }>(
      `INSERT INTO autonomy_action_log
         (task_id, conversation_id, skill_name, action_risk, outcome, task_summary,
          payload, expires_at, short_ref, description, parent_action_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        row.taskId,
        row.conversationId ?? null,
        row.skillName,
        row.actionRisk,
        row.outcome,
        row.taskSummary ?? null,
        row.payload ? JSON.stringify(row.payload) : null,
        row.expiresAt ?? null,
        row.shortRef ?? null,
        row.description ?? null,
        row.parentActionId ?? null,
      ],
    );
    this.logger.debug({ id: result.rows[0]!.id, skillName: row.skillName, outcome: row.outcome }, 'action-log-repo: inserted row');
    return result.rows[0]!.id;
  }

  /**
   * Find unscored terminal rows, oldest first, up to `limit`.
   * Terminal outcomes are those the scoring pass can evaluate —
   * `pending_approval` is excluded (not terminal yet).
   */
  async findUnscoredTerminal(limit: number): Promise<ActionLogRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM autonomy_action_log
       WHERE scored_by IS NULL
         AND outcome = ANY($1)
       ORDER BY created_at ASC
       LIMIT $2`,
      [TERMINAL_OUTCOMES, limit],
    );
    return result.rows.map(mapRow);
  }

  /** Update scoring flags on a row after the judge has evaluated it. */
  async updateScoringFlags(id: number, flags: ScoringFlags): Promise<void> {
    await this.pool.query(
      `UPDATE autonomy_action_log
       SET competence_flag = $2, commitment_flag = $3, compatibility = $4, scored_by = $5
       WHERE id = $1`,
      [id, flags.competenceFlag, flags.commitmentFlag, flags.compatibility, flags.scoredBy],
    );
    this.logger.debug({ id, scoredBy: flags.scoredBy }, 'action-log-repo: scoring flags updated');
  }

  /** Count total scored rows (scored_by IS NOT NULL). */
  async countScored(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM autonomy_action_log WHERE scored_by IS NOT NULL`,
    );
    return parseInt(result.rows[0]!.count, 10);
  }

  /**
   * Compute the competence error rate among the most recent `window` scored rows.
   * Returns 0 if no scored rows exist.
   *
   * A row is counted as an "error" when competence_flag = 0 (Curia made a mistake).
   * Rows with competence_flag = 1 are successes; null rows are excluded from the window
   * by the WHERE clause (competence_flag IS NOT NULL).
   */
  async getRecentCompetenceErrorRate(window: number): Promise<number> {
    const result = await this.pool.query<{ total: string; errors: string }>(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE competence_flag = 0) AS errors
       FROM (
         SELECT competence_flag
         FROM autonomy_action_log
         WHERE scored_by IS NOT NULL AND competence_flag IS NOT NULL
         ORDER BY created_at DESC
         LIMIT $1
       ) recent`,
      [window],
    );
    const total = parseInt(result.rows[0]!.total, 10);
    if (total === 0) return 0;
    return parseInt(result.rows[0]!.errors, 10) / total;
  }

  /**
   * Load the most recent scored rows for the adjustment formula.
   * Bounded to 500 rows — rows older than ~5 half-lives (150 days at default 30d)
   * contribute less than 3% weight and are safely excluded.
   */
  async findAllScored(limit = 500): Promise<ActionLogRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM autonomy_action_log
       WHERE scored_by IS NOT NULL
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapRow);
  }

  /**
   * Find a pending_approval row for the given task + skill + payload.
   * Used by ApprovalTriggerService for deduplication — same skill with
   * same input in the same task should not generate a duplicate request.
   * Uses JSONB equality for key-order-independent payload comparison.
   */
  async findPendingByTaskAndSkill(
    taskId: string,
    skillName: string,
    payload: Record<string, unknown>,
  ): Promise<ActionLogRow | null> {
    const result = await this.pool.query(
      `SELECT * FROM autonomy_action_log
       WHERE task_id = $1
         AND skill_name = $2
         AND outcome = 'pending_approval'
         AND payload::jsonb = $3::jsonb
       LIMIT 1`,
      [taskId, skillName, JSON.stringify(payload)],
    );
    if (result.rows.length === 0) return null;
    return mapRow(result.rows[0]);
  }

  /**
   * Count rows with a non-null short_ref for this task.
   * Used by ApprovalTriggerService to generate sequential short_ref
   * counters (e.g. cal-1, email-2).
   */
  async countShortRefsForTask(taskId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM autonomy_action_log
       WHERE task_id = $1
         AND short_ref IS NOT NULL`,
      [taskId],
    );
    return parseInt(result.rows[0]!.count, 10);
  }

  /**
   * Mark that the CEO notification was successfully delivered.
   * Called after a successful sendNotification(). If notification fails,
   * this is never called — notification_sent_at stays null.
   */
  async setNotificationSentAt(id: number): Promise<void> {
    await this.pool.query(
      `UPDATE autonomy_action_log
       SET notification_sent_at = now()
       WHERE id = $1`,
      [id],
    );
    this.logger.debug({ id }, 'action-log-repo: notification_sent_at updated');
  }

  /**
   * Return all non-expired pending_approval rows, oldest first.
   * Used by list-pending-actions and by resolvePending() when no short_ref is given.
   */
  async findAllPending(): Promise<ActionLogRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM autonomy_action_log
       WHERE outcome = 'pending_approval'
         AND expires_at > now()
       ORDER BY created_at ASC`,
    );
    return result.rows.map(mapRow);
  }

  /**
   * Return all pending_approval rows that have passed their expiry time.
   * These are the inverse of findAllPending() — rows where expires_at <= now().
   * Used by the approval-expiry-sweep skill to transition stale requests.
   */
  async findExpired(): Promise<ActionLogRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM autonomy_action_log
       WHERE outcome = 'pending_approval'
         AND expires_at <= now()
       ORDER BY created_at ASC`,
    );
    return result.rows.map(mapRow);
  }

  /**
   * Batch-transition pending_approval rows to expired state.
   * Sets outcome = 'expired', resolved_by = 'system', resolved_at = now().
   * Returns the rows that were actually updated (via RETURNING *).
   *
   * The WHERE outcome = 'pending_approval' guard ensures idempotency — if a row
   * was concurrently resolved (approved/denied/dismissed), it won't be
   * double-transitioned and won't appear in the returned set.
   *
   * Empty ids array is a no-op — returns [] without issuing a query.
   */
  async expireRows(ids: number[]): Promise<ActionLogRow[]> {
    if (ids.length === 0) return [];
    const result = await this.pool.query(
      `UPDATE autonomy_action_log
       SET outcome = 'expired', resolved_by = 'system', resolved_at = now()
       WHERE id = ANY($1) AND outcome = 'pending_approval'
       RETURNING *`,
      [ids],
    );
    const rows = result.rows.map(mapRow);
    if (rows.length > 0) {
      this.logger.info({ count: rows.length, totalRequested: ids.length, ids }, 'action-log-repo: expired rows');
    } else {
      this.logger.debug({ ids }, 'action-log-repo: expireRows affected 0 rows — all may have been concurrently resolved');
    }
    return rows;
  }

  /**
   * Find a pending_approval row where a specific field in the JSONB payload
   * matches the given value. Used by send-draft to find the action_log row
   * associated with a draft being approved.
   */
  async findPendingByPayloadField(
    field: string,
    value: string,
  ): Promise<ActionLogRow | null> {
    const result = await this.pool.query(
      `SELECT * FROM autonomy_action_log
       WHERE outcome = 'pending_approval'
         AND payload->>$1 = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [field, value],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  /**
   * Transition a specific action_log row to a terminal outcome by ID.
   * Only updates if the current outcome is still pending_approval — returns
   * false on double-resolve (concurrent resolution race).
   *
   * Unlike resolveRow(), this method accepts a free-form outcome string so
   * that callers (e.g. send-draft) can pass 'approved' without needing to
   * import the union type. The WHERE guard on pending_approval ensures
   * idempotency — a row that was already resolved will not be double-transitioned.
   */
  async resolveById(id: number, outcome: string, resolvedBy: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE autonomy_action_log
       SET outcome = $2, resolved_at = NOW(), resolved_by = $3
       WHERE id = $1 AND outcome = 'pending_approval'`,
      [id, outcome, resolvedBy],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Merge additional payload fields into an existing action_log row identified
   * by short_ref. Used by the gateway's two-step draft-fallback pattern: the
   * initial row is created on gate (with source/context), then the adapter
   * links the draft ID after creating the draft.
   *
   * Returns true if a row was updated, false if no matching pending row exists.
   */
  async linkPayload(shortRef: string, additionalPayload: Record<string, unknown>): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE autonomy_action_log
       SET payload = COALESCE(payload, '{}'::jsonb) || $2::jsonb
       WHERE short_ref = $1
         AND outcome = 'pending_approval'`,
      [shortRef, JSON.stringify(additionalPayload)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Transition a pending_approval row to a terminal outcome.
   * Only updates if the current outcome is still pending_approval —
   * returns `false` on double-resolve (concurrent resolution race).
   *
   * Callers MUST check the return value and skip side effects (re-execution,
   * audit events) when `false` — otherwise a concurrently denied/dismissed
   * action could still trigger re-execution.
   */
  async resolveRow(
    id: number,
    outcome: 'approved' | 'denied' | 'resolved_externally',
    resolvedBy: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE autonomy_action_log
       SET outcome = $2, resolved_at = now(), resolved_by = $3
       WHERE id = $1 AND outcome = 'pending_approval'`,
      [id, outcome, resolvedBy],
    );
    const updated = (result.rowCount ?? 0) > 0;
    if (!updated) {
      // Row was already resolved by a concurrent call — idempotent no-op.
      this.logger.warn({ id, outcome, resolvedBy }, 'action-log-repo: resolveRow affected 0 rows — row may have been resolved concurrently');
    } else {
      this.logger.debug({ id, outcome, resolvedBy }, 'action-log-repo: row resolved');
    }
    return updated;
  }

  /**
   * Resolve a short_ref (or the sole pending row) to a single ActionLogRow.
   *
   * When short_ref is provided: look up by short_ref among pending + non-expired rows.
   * If not found there, make a second query (any outcome) to distinguish between
   * not_found, already_resolved, and expired.
   *
   * When omitted: fetch all non-expired pending rows. If exactly one, return it.
   * If multiple, return ambiguous with the full list so the caller can show options.
   */
  async resolvePending(shortRef?: string): Promise<ResolveResult> {
    if (shortRef !== undefined) {
      // Query 1: look up by short_ref — pending + non-expired only.
      // LIMIT 2 (not 1): short_ref is unique per (task_id, short_ref), so the same
      // short_ref can exist in multiple tasks. If two pending rows match, return
      // ambiguous rather than silently picking one (could approve/deny the wrong request).
      const pending = await this.pool.query(
        `SELECT * FROM autonomy_action_log
         WHERE short_ref = $1
           AND outcome = 'pending_approval'
           AND expires_at > now()
         ORDER BY created_at ASC
         LIMIT 2`,
        [shortRef],
      );
      if (pending.rows.length === 1) {
        return { found: true, row: mapRow(pending.rows[0]) };
      }
      if (pending.rows.length > 1) {
        const rows = pending.rows.map(mapRow);
        const refs = rows.map(r => `${r.shortRef} (task: ${r.taskId}): ${r.description}`).join(', ');
        return {
          found: false,
          reason: 'ambiguous',
          error: `Reference '${shortRef}' matches multiple pending requests — specify more context. Pending: ${refs}`,
          pending: rows,
        };
      }

      // Query 2: not found as pending — check if it exists at all (any outcome)
      // to give a more precise error reason (not_found vs already_resolved vs expired).
      // ORDER BY created_at DESC ensures the most recent row is returned (most relevant to CEO).
      const any = await this.pool.query(
        `SELECT * FROM autonomy_action_log
         WHERE short_ref = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [shortRef],
      );
      if (any.rows.length === 0) {
        return { found: false, reason: 'not_found', error: `No approval request found with reference '${shortRef}'` };
      }

      const row = mapRow(any.rows[0]);
      if (row.outcome !== 'pending_approval') {
        // Row exists but has already resolved to a terminal outcome
        return { found: false, reason: 'already_resolved', error: `Request '${shortRef}' is already resolved (outcome: ${row.outcome})` };
      }
      // outcome is still pending_approval but expires_at <= now() (expired)
      return { found: false, reason: 'expired', error: `Request '${shortRef}' has expired` };
    }

    // No short_ref — try to auto-resolve to the sole pending row
    const allPending = await this.findAllPending();
    if (allPending.length === 0) {
      return { found: false, reason: 'not_found', error: 'No pending approval requests' };
    }
    if (allPending.length === 1) {
      return { found: true, row: allPending[0]! };
    }
    // Multiple pending rows — caller must specify a short_ref
    const refs = allPending.map(r => `${r.shortRef}: ${r.description}`).join(', ');
    return {
      found: false,
      reason: 'ambiguous',
      error: `Multiple pending requests — specify a short_ref. Pending: ${refs}`,
      pending: allPending,
    };
  }
}

/** Map a snake_case DB row to a camelCase ActionLogRow. */
function mapRow(row: Record<string, unknown>): ActionLogRow {
  return {
    id: row.id as number,
    taskId: row.task_id as string,
    conversationId: row.conversation_id as string | null,
    skillName: row.skill_name as string,
    actionRisk: row.action_risk as string,
    outcome: row.outcome as ActionLogRow['outcome'],
    taskSummary: row.task_summary as string | null,
    competenceFlag: row.competence_flag as 0 | 1 | null,
    commitmentFlag: row.commitment_flag as 0 | 1 | null,
    compatibility: row.compatibility as 0 | 1 | null,
    scoredBy: row.scored_by as string | null,
    payload: row.payload as Record<string, unknown> | null,
    notificationSentAt: row.notification_sent_at ? new Date(row.notification_sent_at as string) : null,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at as string) : null,
    resolvedBy: row.resolved_by as string | null,
    expiresAt: row.expires_at ? new Date(row.expires_at as string) : null,
    parentActionId: row.parent_action_id as number | null,
    shortRef: row.short_ref as string | null,
    description: row.description as string | null,
    createdAt: new Date(row.created_at as string),
  };
}
