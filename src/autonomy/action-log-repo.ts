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
   * Transition a pending_approval row to a terminal outcome.
   * Only updates if the current outcome is still pending_approval —
   * silently no-ops on double-resolve (idempotent).
   */
  async resolveRow(
    id: number,
    outcome: 'approved' | 'denied' | 'resolved_externally',
    resolvedBy: string,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE autonomy_action_log
       SET outcome = $2, resolved_at = now(), resolved_by = $3
       WHERE id = $1 AND outcome = 'pending_approval'`,
      [id, outcome, resolvedBy],
    );
    if ((result.rowCount ?? 0) === 0) {
      // Row was already resolved by a concurrent call — idempotent no-op.
      this.logger.warn({ id, outcome, resolvedBy }, 'action-log-repo: resolveRow affected 0 rows — row may have been resolved concurrently');
    } else {
      this.logger.debug({ id, outcome, resolvedBy }, 'action-log-repo: row resolved');
    }
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
      // Query 1: look up by short_ref — pending + non-expired only
      // ORDER BY created_at ASC ensures deterministic resolution of oldest pending row
      // when multiple rows share the same short_ref across different tasks.
      const pending = await this.pool.query(
        `SELECT * FROM autonomy_action_log
         WHERE short_ref = $1
           AND outcome = 'pending_approval'
           AND expires_at > now()
         ORDER BY created_at ASC
         LIMIT 1`,
        [shortRef],
      );
      if (pending.rows.length > 0) {
        return { found: true, row: mapRow(pending.rows[0]) };
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
