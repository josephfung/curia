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
import { NO_REF_RETRY_GUIDANCE, TERMINAL_OUTCOMES } from './action-log-types.js';
import { SAMPLE_POOL_SCORED_BY } from './sample-pool.js';
import type { SampledActionInsert } from './sample-pool.js';

export class ActionLogRepo {
  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
  ) {}

  /** Column list + positional VALUES tuple shared by insert() and insertShadowEvaluated().
   *  Kept in one place so the two insert paths cannot drift.
   *
   *  `approvalNumber` is allocated by insert() for pending approvals only (#2159 Phase 3) and is
   *  NULL everywhere else. It is the LAST column ($17) so every other param keeps its position. */
  private insertColumnsAndParams(
    row: ActionLogInsert,
    approvalNumber: number | null = null,
  ): { columns: string; values: string; params: unknown[] } {
    return {
      columns:
        '(task_id, conversation_id, skill_name, action_risk, outcome, task_summary, ' +
        'payload, expires_at, short_ref, description, parent_action_id, ' +
        'competence_flag, commitment_flag, compatibility, scored_by, send_resolution, approval_number)',
      values: 'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)',
      params: [
        row.taskId,
        row.conversationId ?? null,
        row.toolName,
        row.actionRisk,
        row.outcome,
        row.taskSummary ?? null,
        row.payload ? JSON.stringify(row.payload) : null,
        row.expiresAt ?? null,
        row.shortRef ?? null,
        row.description ?? null,
        row.parentActionId ?? null,
        row.competenceFlag ?? null,
        // commitment_flag / compatibility are never set at insert time — the Phase 3
        // scoring-pass update populates them later. Pre-scored shadow rows leave them null.
        null,
        null,
        row.scoredBy ?? null,
        row.sendResolution && row.sendResolution.length > 0 ? JSON.stringify(row.sendResolution) : null,
        approvalNumber,
      ],
    };
  }

  /**
   * Insert a new row and return the generated id.
   *
   * A `pending_approval` row also gets an approval number (#2159 Phase 3), allocated inside a
   * transaction; every other outcome is a single pool.query as before.
   */
  async insert(row: ActionLogInsert): Promise<number> {
    if (row.outcome === 'pending_approval') {
      return this.insertPendingWithNumber(row);
    }
    const { columns, values, params } = this.insertColumnsAndParams(row);
    // `id` is BIGSERIAL; node-postgres returns int8 as a STRING (no global bigint type-parser is
    // registered), so coerce to number at the repository boundary to honor the declared return
    // type. autonomy_action_log ids never approach Number.MAX_SAFE_INTEGER at single-tenant scale.
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO autonomy_action_log ${columns} ${values} RETURNING id`,
      params,
    );
    const id = Number(result.rows[0]!.id);
    this.logger.debug({ id, toolName: row.toolName, outcome: row.outcome }, 'action-log-repo: inserted row');
    return id;
  }

  /**
   * Insert a pending approval with the lowest approval number no row used in the last 7 days.
   *
   * Why the transaction and the lock: two approvals raised at the same moment would otherwise
   * both read the same free number and both insert it, and "approve 3" would then match two
   * approvals. pg_advisory_xact_lock serialises allocators (it is released at COMMIT/ROLLBACK),
   * so the free-number read and the INSERT that claims it are atomic with respect to every
   * other allocator. There is no unique index to lean on instead: numbers are deliberately
   * reused after 7 days.
   *
   * Why 7 days: approvals expire within 48h, so a number cannot be reused while its approval
   * could still be answered, nor soon enough that a late reply ("approve 3" to last week's
   * message) reaches a newer approval.
   *
   * When all 999 are in use, the row is inserted with NULL and a warning: the approval still
   * works by its short_ref, which is better than refusing to raise it.
   */
  private async insertPendingWithNumber(row: ActionLogInsert): Promise<number> {
    const client = await this.pool.connect();
    // Set only when ROLLBACK itself fails: release(err) makes the pool destroy the connection
    // instead of reusing one in an unknown transaction state.
    let brokenConnection: Error | undefined;
    try {
      // READ COMMITTED is set explicitly, not inherited: correctness depends on it (see below),
      // and a server or role default of REPEATABLE READ would otherwise silently break it.
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('autonomy_approval_number'))`);
      // Under READ COMMITTED this statement takes a fresh snapshot after the lock is granted, so
      // it sees the number the previous holder committed. A REPEATABLE READ transaction would
      // snapshot at its first statement (the lock wait) and two allocators could pick the same number.
      const free = await client.query<{ n: number }>(
        `SELECT n FROM generate_series(1, 999) AS n
         WHERE n NOT IN (SELECT approval_number FROM autonomy_action_log
                         WHERE approval_number IS NOT NULL AND created_at > now() - interval '7 days')
         ORDER BY n LIMIT 1`,
      );
      const approvalNumber = free.rows[0] ? Number(free.rows[0].n) : null;
      if (approvalNumber === null) {
        this.logger.warn(
          { taskId: row.taskId, toolName: row.toolName, shortRef: row.shortRef ?? null },
          'action-log-repo: all 999 approval numbers are in use — inserting without one; the approval falls back to its short_ref',
        );
      }
      const { columns, values, params } = this.insertColumnsAndParams(row, approvalNumber);
      const result = await client.query<{ id: string }>(
        `INSERT INTO autonomy_action_log ${columns} ${values} RETURNING id`,
        params,
      );
      await client.query('COMMIT');
      // int8 -> number at the boundary (see insert()).
      const id = Number(result.rows[0]!.id);
      this.logger.debug(
        { id, toolName: row.toolName, outcome: row.outcome, approvalNumber },
        'action-log-repo: inserted pending approval',
      );
      return id;
    } catch (err) {
      // Roll back so the advisory lock is released and no half-written row survives, then
      // rethrow the ORIGINAL error: approval-trigger retries on its 23505 code.
      this.logger.warn({ err, taskId: row.taskId, toolName: row.toolName }, 'action-log-repo: pending-approval insert failed — rolling back');
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        this.logger.error({ err: rollbackErr, originalErr: err }, 'action-log-repo: ROLLBACK failed after a pending-approval insert error');
        brokenConnection = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
      }
      throw err;
    } finally {
      client.release(brokenConnection);
    }
  }

  /** The approval number of a row, or null when it has none or the row does not exist. */
  async findApprovalNumber(id: number): Promise<number | null> {
    const result = await this.pool.query<{ approval_number: number | null }>(
      `SELECT approval_number FROM autonomy_action_log WHERE id = $1`,
      [id],
    );
    const value = result.rows[0]?.approval_number;
    return value == null ? null : Number(value);
  }

  /**
   * Insert a pre-scored shadow-eval row idempotently (#1432). The partial unique index
   * idx_aal_shadow_source (migration 074) enforces one 'shadow_evaluated' row per
   * source_message_id, so ON CONFLICT DO NOTHING makes a re-run a no-op instead of a duplicate.
   * Returns the new id, or `null` when a row for this source_message_id already exists — the
   * caller treats null as "already durably recorded", NOT an error.
   */
  async insertShadowEvaluated(row: ActionLogInsert): Promise<number | null> {
    const { columns, values, params } = this.insertColumnsAndParams(row);
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO autonomy_action_log ${columns} ${values}
       ON CONFLICT ((payload->>'source_message_id')) WHERE outcome = 'shadow_evaluated'
       DO NOTHING
       RETURNING id`,
      params,
    );
    // int8 -> number at the boundary (see insert()); a dedup no-op returns no row, preserved as null.
    const raw = result.rows[0]?.id;
    const id = raw === undefined ? null : Number(raw);
    this.logger.debug({ id, toolName: row.toolName, deduped: id === null }, 'action-log-repo: shadow insert');
    return id;
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

  /**
   * Count evidence-bearing scored rows. Unparseable dead-letters write
   * `scored_by` with all flags null so they leave the unscored queue; they
   * must not count toward `minScoredActions`.
   */
  async countScored(): Promise<number> {
    // Excluded outcomes carry no evidence about actions Curia took:
    // - 'expired': expired approvals carry no signal (#2159 Phase 3), including rows scored
    //   before the rule changed.
    // - 'shadow_evaluated': counterfactual shadow drafts, drafted only for punted messages
    //   (#2191, ADR-029). They stay in the table for checkups.
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM autonomy_action_log
       WHERE scored_by IS NOT NULL
         AND outcome NOT IN ('expired', 'shadow_evaluated')
         AND (competence_flag IS NOT NULL
           OR commitment_flag IS NOT NULL
           OR compatibility IS NOT NULL)`,
    );
    return parseInt(result.rows[0]!.count, 10);
  }

  /**
   * Compute the competence error rate among the most recent `window` scored rows that are
   * no older than `maxAgeDays`. Returns null when no row in the window carries a competence
   * flag: that is "no evidence", not "no errors", and the scoring pass blocks increases on
   * it (#2159).
   *
   * A row is counted as an "error" when competence_flag = 0 (Curia made a mistake).
   * Rows with competence_flag = 1 are successes; null rows are excluded from the window
   * by the WHERE clause (competence_flag IS NOT NULL).
   *
   * The age bound matters because competence rows are sparse: a count-only window reached
   * back five months in prod and kept old failures blocking increases (#2191). Expired and
   * shadow rows are left out for the same reasons as in countScored.
   */
  async getRecentCompetenceErrorRate(window: number, maxAgeDays: number): Promise<number | null> {
    const result = await this.pool.query<{ total: string; errors: string }>(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE competence_flag = 0) AS errors
       FROM (
         SELECT competence_flag
         FROM autonomy_action_log
         WHERE scored_by IS NOT NULL AND competence_flag IS NOT NULL
           AND outcome NOT IN ('expired', 'shadow_evaluated')
           AND created_at > now() - make_interval(days => $2)
         ORDER BY created_at DESC
         LIMIT $1
       ) recent`,
      [window, maxAgeDays],
    );
    const total = parseInt(result.rows[0]!.total, 10);
    if (total === 0) return null;
    return parseInt(result.rows[0]!.errors, 10) / total;
  }

  /**
   * Load the most recent scored rows for the adjustment formula.
   * Bounded to 500 rows — rows older than ~5 half-lives (150 days at default 30d)
   * contribute less than 3% weight and are safely excluded.
   *
   * Same evidence filter as countScored, applied before the LIMIT: coordinator-resolved
   * rows and dead-letters are scored with every flag null (#2159), and a run of them
   * must not push real evidence out of the window.
   */
  async findAllScored(limit = 500): Promise<ActionLogRow[]> {
    // Same excluded outcomes as countScored: expired approvals (#2159 Phase 3) and
    // counterfactual shadow drafts (#2191).
    const result = await this.pool.query(
      `SELECT * FROM autonomy_action_log
       WHERE scored_by IS NOT NULL
         AND outcome NOT IN ('expired', 'shadow_evaluated')
         AND (competence_flag IS NOT NULL
           OR commitment_flag IS NOT NULL
           OR compatibility IS NOT NULL)
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapRow);
  }

  /** Record an autonomous action in the spot-check pool (#2159 Phase 3). Never LLM-scored. */
  async insertSampled(row: SampledActionInsert): Promise<number> {
    return this.insert({
      taskId: row.taskId,
      ...(row.conversationId ? { conversationId: row.conversationId } : {}),
      toolName: row.toolName,
      actionRisk: row.actionRisk,
      outcome: 'success',
      description: row.summary,
      payload: { sample: { signals: row.signals, ...sampleInput(row.input), ...(row.email ? { email: row.email } : {}) } },
      // scored_by set + every flag null: findUnscoredTerminal skips the row and the scorer
      // ignores it until the principal gives a verdict.
      scoredBy: SAMPLE_POOL_SCORED_BY,
    });
  }

  /**
   * Pool rows not yet shown in a spot check, newest first. With `filter`, only one class:
   * triage rows (signals.triage true) or the rest. The sampler reads each class on its own so
   * a day of mail triage cannot fill the whole limit and push every send out of the draw.
   */
  async findSampleCandidates(since: Date, limit: number, filter?: { triage: boolean }): Promise<ActionLogRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM autonomy_action_log
       WHERE outcome = 'success'
         AND scored_by = 'sample-pool'
         AND created_at >= $1
         AND payload->'sample'->>'sampledAt' IS NULL
         AND ($3::boolean IS NULL
              OR (COALESCE(payload->'sample'->'signals'->>'triage', 'false') = 'true') = $3::boolean)
       ORDER BY created_at DESC
       LIMIT $2`,
      [since, limit, filter ? filter.triage : null],
    );
    return result.rows.map(mapRow);
  }

  /**
   * Mark pool rows as shown, so the next digest draws different ones. Returns the number of
   * rows stamped; fewer than `ids.length` means some ids no longer exist (or were never pool
   * rows), which the caller may want to know about, so it is logged here too.
   *
   * The pool predicate matches recordPrincipalVerdict's. Without it a non-pool id would count
   * as stamped, and its NULL payload would be rewritten to '{}' (jsonb_set cannot create the
   * missing 'sample' parent).
   */
  async markSampled(ids: readonly number[], at: Date): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.pool.query(
      `UPDATE autonomy_action_log
       SET payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{sample,sampledAt}', to_jsonb($2::text), true)
       WHERE id = ANY($1::bigint[])
         AND outcome = 'success'
         AND scored_by IN ('sample-pool', 'principal')`,
      [ids, at.toISOString()],
    );
    const updated = result.rowCount ?? 0;
    if (updated !== ids.length) {
      this.logger.warn({ requested: ids.length, updated, ids }, 'action-log: markSampled stamped fewer rows than requested — some spot-check rows were not found');
    }
    return updated;
  }

  /**
   * The principal's spot-check verdict (#2159 Phase 3): competence only, scored_by 'principal'.
   * A second verdict on the same row replaces the first. False when the id is not a pool row.
   */
  async recordPrincipalVerdict(id: number, good: boolean, reason: string | null): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE autonomy_action_log
       SET competence_flag = $2,
           scored_by = 'principal',
           payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{sample,verdict}', $3::jsonb, true)
       WHERE id = $1
         AND outcome = 'success'
         AND scored_by IN ('sample-pool', 'principal')
       RETURNING id`,
      [id, good ? 1 : 0, JSON.stringify({ good, reason })],
    );
    return result.rows.length > 0;
  }

  /**
   * Find a pending_approval row for the given task + skill + payload.
   * Used by ApprovalTriggerService for deduplication — same skill with
   * same input in the same task should not generate a duplicate request.
   * Uses JSONB equality for key-order-independent payload comparison.
   */
  async findPendingByTaskAndSkill(
    taskId: string,
    toolName: string,
    payload: Record<string, unknown>,
  ): Promise<ActionLogRow | null> {
    const result = await this.pool.query(
      `SELECT * FROM autonomy_action_log
       WHERE task_id = $1
         AND skill_name = $2
         AND outcome = 'pending_approval'
         AND expires_at > now()
         AND payload::jsonb = $3::jsonb
       LIMIT 1`,
      [taskId, toolName, JSON.stringify(payload)],
    );
    if (result.rows.length === 0) return null;
    return mapRow(result.rows[0]);
  }

  /**
   * Find a pending_approval row for a task whose skill is in the given set (#1733).
   * Used by the dispatcher relay so a Gate C escalate joins a reply-class approval
   * already pending on the same turn — not an unrelated calendar/etc. approval.
   */
  async findPendingByTaskAndSkills(
    taskId: string,
    skillNames: readonly string[],
  ): Promise<ActionLogRow | null> {
    if (skillNames.length === 0) return null;
    const result = await this.pool.query(
      `SELECT * FROM autonomy_action_log
       WHERE task_id = $1
         AND outcome = 'pending_approval'
         AND expires_at > now()
         AND skill_name = ANY($2::text[])
       ORDER BY created_at ASC
       LIMIT 1`,
      [taskId, [...skillNames]],
    );
    if (result.rows.length === 0) return null;
    return mapRow(result.rows[0]);
  }

  /**
   * Mark that the principal notification was successfully delivered.
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
   * Claim a pending approval's single delivery (#2159): sets notification_sent_at only when it
   * is still null. Returns false when another caller already claimed it, so two deliverers
   * (an agent and the expiry sweep's safety net) can never both ping the principal.
   */
  async claimNotification(id: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE autonomy_action_log
       SET notification_sent_at = now()
       WHERE id = $1
         AND notification_sent_at IS NULL
         AND outcome = 'pending_approval'
       RETURNING id`,
      [id],
    );
    return result.rows.length > 0;
  }

  /**
   * Live pending approvals that no one delivered and that were created before `olderThan`
   * (#2159). The expiry sweep's safety net emails these once: the agent that raised one did
   * not call deliver-approval, or the coordinator wake for a held relay was lost.
   */
  async findUndelivered(olderThan: Date): Promise<ActionLogRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM autonomy_action_log
       WHERE outcome = 'pending_approval'
         AND notification_sent_at IS NULL
         AND expires_at > now()
         AND created_at < $1
       ORDER BY created_at ASC`,
      [olderThan],
    );
    return result.rows.map(mapRow);
  }

  /** Undo claimNotification() after a failed send, so the approval can be delivered again. */
  async releaseNotification(id: number): Promise<void> {
    await this.pool.query(
      `UPDATE autonomy_action_log SET notification_sent_at = NULL WHERE id = $1`,
      [id],
    );
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
   * Used by ApprovalExpirySweep (src/autonomy/approval-expiry-sweep.ts) to transition stale requests.
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
   * When taskEventId is provided, the WHERE clause adds a secondary task_id
   * scope as a defensive belt-and-suspenders measure. short_ref is globally
   * unique (migration 033 added UNIQUE(short_ref)), so a taskEventId scope is
   * not strictly necessary, but it guards against any data inconsistency and
   * makes the intent explicit at the call site.
   *
   * When taskEventId is omitted (undefined/null), the filter is bypassed and the
   * match is by short_ref + outcome alone — kept for backwards compatibility with
   * callers that lack a taskEventId.
   *
   * Returns true if a row was updated, false if no matching pending row exists.
   */
  async linkPayload(
    shortRef: string,
    taskEventId: string | undefined,
    additionalPayload: Record<string, unknown>,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE autonomy_action_log
       SET payload = COALESCE(payload, '{}'::jsonb) || $3::jsonb
       WHERE short_ref = $1
         AND ($2::text IS NULL OR task_id = $2)
         AND outcome = 'pending_approval'`,
      [shortRef, taskEventId ?? null, JSON.stringify(additionalPayload)],
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
   * Close a pending approval because the hinted recipient no longer matches
   * the identity that was shown. `scored_by` is set so the scoring pass does
   * not treat the contact change as an agent failure (#2047).
   */
  async rejectStaleApproval(id: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE autonomy_action_log
       SET outcome = 'rejected', resolved_at = now(), resolved_by = 'system', scored_by = 'system'
       WHERE id = $1 AND outcome = 'pending_approval'`,
      [id],
    );
    const updated = (result.rowCount ?? 0) > 0;
    if (!updated) {
      this.logger.warn({ id }, 'action-log-repo: rejectStaleApproval affected 0 rows — row may have been resolved concurrently');
    }
    return updated;
  }

  /**
   * Resolve an approval number, a short_ref, or (with no ref) the sole pending row to a
   * single ActionLogRow.
   *
   * When ref is 1 to 3 digits: it is an approval number (#2159 Phase 3); see
   * resolvePendingByNumber(). A short_ref is 8 hex characters, so the two never overlap.
   *
   * When ref is a short_ref: look up by short_ref among pending + non-expired rows.
   * If not found there, make a second query (any outcome) to distinguish between
   * not_found, already_resolved, and expired.
   *
   * When omitted: fetch all non-expired pending rows. If exactly one, return it.
   * If multiple, return ambiguous with the full list so the caller can show options.
   */
  async resolvePending(ref?: string): Promise<ResolveResult> {
    if (ref !== undefined && APPROVAL_NUMBER_PATTERN.test(ref)) {
      return this.resolvePendingByNumber(Number(ref));
    }
    const shortRef = ref;
    if (shortRef !== undefined) {
      // Query 1: look up by short_ref — pending + non-expired only.
      // LIMIT 2 (not 1): short_ref is globally unique (migration 033), so two
      // pending rows with the same ref should never occur under normal operation.
      // The LIMIT 2 + ambiguous path is a defensive safety net — if duplicates
      // somehow exist (e.g. manual DB insert, constraint not yet applied), return
      // ambiguous rather than silently approving/denying the wrong request.
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
        const refs = rows.map(r => describeForChoice(r, { withTask: true })).join(', ');
        return {
          found: false,
          reason: 'ambiguous',
          error: `Reference '${shortRef}' matches multiple pending requests — specify more context. Pending: ${refs}`,
          pending: rows,
        };
      }

      // Query 2: not found as pending — check if it exists at all (any outcome)
      // to give a more precise error reason (not_found vs already_resolved vs expired).
      // ORDER BY created_at DESC ensures the most recent row is returned (most relevant to principal).
      const any = await this.pool.query(
        `SELECT * FROM autonomy_action_log
         WHERE short_ref = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [shortRef],
      );
      if (any.rows.length === 0) {
        return { found: false, reason: 'not_found', error: `No approval request found with reference '${shortRef}'. ${NO_REF_RETRY_GUIDANCE}` };
      }

      const row = mapRow(any.rows[0]);
      if (row.outcome !== 'pending_approval') {
        // Row exists but has already resolved to a terminal outcome
        return { found: false, reason: 'already_resolved', error: `Request '${shortRef}' is already resolved (outcome: ${row.outcome}). ${NO_REF_RETRY_GUIDANCE}` };
      }
      // outcome is still pending_approval but expires_at <= now() (expired)
      return { found: false, reason: 'expired', error: `Request '${shortRef}' has expired. ${NO_REF_RETRY_GUIDANCE}` };
    }

    // No short_ref — try to auto-resolve to the sole pending row
    const allPending = await this.findAllPending();
    if (allPending.length === 0) {
      return { found: false, reason: 'not_found', error: 'No pending approval requests' };
    }
    if (allPending.length === 1) {
      return { found: true, row: allPending[0]! };
    }
    // Multiple pending rows — the caller must name one. Ask for the identifier the principal was
    // shown: the approval number, or the reference only when no listed row has a number (#2159).
    const refs = allPending.map(r => describeForChoice(r)).join(', ');
    const ask = allPending.some(r => r.approvalNumber != null)
      ? 'specify the approval number'
      : 'specify the reference (short_ref)';
    return {
      found: false,
      reason: 'ambiguous',
      error: `Multiple pending requests — ${ask}. Pending: ${refs}`,
      pending: allPending,
    };
  }

  /**
   * Resolve an approval number the principal typed ("approve 3") to its pending row.
   *
   * Every lookup is restricted to rows created in the last 7 days, the window in which
   * insert() keeps numbers unique. An older row with the same number belongs to an earlier
   * approval that the number has since been reused from, so it must never match, not even to
   * explain an error. Mirrors the short_ref path: a second query over the same window tells
   * not_found, already_resolved and expired apart.
   */
  private async resolvePendingByNumber(approvalNumber: number): Promise<ResolveResult> {
    const live = await this.liveRowsByApprovalNumber(approvalNumber);
    if (live.length === 1) {
      return { found: true, row: live[0]! };
    }
    if (live.length > 1) {
      // Refuse to pick (ambiguous) rather than act on what may be the wrong approval.
      // Every listed row carries the same number, so only the reference tells them apart.
      const refs = live.map(r => describeForChoice(r, { withTask: true })).join(', ');
      return {
        found: false,
        reason: 'ambiguous',
        error: `Approval ${approvalNumber} matches multiple pending requests — use the reference instead. Pending: ${refs}`,
        pending: live,
      };
    }

    // Not live: find the most recent row in the window carrying the number, to say why.
    const any = await this.pool.query(
      `SELECT * FROM autonomy_action_log
       WHERE approval_number = $1
         AND created_at > now() - interval '7 days'
       ORDER BY created_at DESC
       LIMIT 1`,
      [approvalNumber],
    );
    if (any.rows.length === 0) {
      return { found: false, reason: 'not_found', error: `No approval request found with number ${approvalNumber}. ${NO_REF_RETRY_GUIDANCE}` };
    }
    const row = mapRow(any.rows[0]);
    if (row.outcome !== 'pending_approval') {
      return { found: false, reason: 'already_resolved', error: `Approval ${approvalNumber} is already resolved (outcome: ${row.outcome}). ${NO_REF_RETRY_GUIDANCE}` };
    }
    return { found: false, reason: 'expired', error: `Approval ${approvalNumber} has expired. ${NO_REF_RETRY_GUIDANCE}` };
  }

  /**
   * The live approvals carrying `approvalNumber`: pending, non-expired, and created in the last
   * 7 days, the window in which insert() keeps numbers unique. An older row with the number is
   * an earlier approval the number was reused from and must never match.
   *
   * The ONE definition of "which approval does number n mean", shared by resolvePending()
   * ("approve 3") and findPendingByApprovalNumber() (reaction binding), so the two can never
   * disagree about which row a number names.
   *
   * LIMIT 2: allocation makes a second live row with the same number impossible. If one ever
   * appears it is logged here, and each caller refuses to pick between them.
   */
  private async liveRowsByApprovalNumber(approvalNumber: number): Promise<ActionLogRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM autonomy_action_log
       WHERE approval_number = $1
         AND outcome = 'pending_approval'
         AND expires_at > now()
         AND created_at > now() - interval '7 days'
       ORDER BY created_at ASC
       LIMIT 2`,
      [approvalNumber],
    );
    const rows = result.rows.map(mapRow);
    if (rows.length > 1) {
      this.logger.error(
        { approvalNumber, ids: rows.map((r) => r.id) },
        'action-log-repo: two live approvals share an approval number — allocation invariant broken',
      );
    }
    return rows;
  }

  /**
   * Terminal autonomy rows in a half-open [since, until) window for activity recap enrichment.
   *
   * Newest first, with a generous limit: since #2159 Phase 3 the spot-check pool writes a
   * success row for every autonomous triage action (ceo-inbox triage runs every 15 minutes),
   * so a busy window easily exceeds a few hundred rows. Ascending order cut off the NEWEST
   * rows, which are the ones the recap most needs to match. The caller matches rows by tool
   * and time window, so order carries no meaning beyond which rows survive the limit.
   */
  async findTerminalBetween(since: Date, until: Date, limit = 1000): Promise<ActionLogRow[]> {
    const result = await this.pool.query(
      `SELECT * FROM autonomy_action_log
       WHERE created_at >= $1
         AND created_at < $2
         AND outcome = ANY($3)
       ORDER BY created_at DESC
       LIMIT $4`,
      [since, until, TERMINAL_OUTCOMES, limit],
    );
    return result.rows.map(mapRow);
  }

  /**
   * Bind a delivered provider message id to a pending approval row (#1479).
   * Idempotent on (channel, message_id) — re-bind of the same pair is a no-op.
   * Returns true when a new binding was inserted.
   */
  async bindDeliveryMessage(
    actionLogId: number,
    channel: string,
    messageId: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO approval_message_bindings (action_log_id, channel, message_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (channel, message_id) DO NOTHING
       RETURNING id`,
      [actionLogId, channel, messageId],
    );
    const inserted = result.rows.length > 0;
    this.logger.debug(
      { actionLogId, channel, messageId, inserted },
      'action-log-repo: bindDeliveryMessage',
    );
    return inserted;
  }

  /**
   * Look up a still-pending (non-expired) approval by the delivered provider
   * message id the principal reacted to. Correlation is (channel, message_id)
   * only — conversationId must not be used (ADR-033 / #1479).
   */
  async findPendingByDeliveryMessage(
    channel: string,
    messageId: string,
  ): Promise<ActionLogRow | null> {
    const result = await this.pool.query(
      `SELECT a.*
       FROM approval_message_bindings b
       JOIN autonomy_action_log a ON a.id = b.action_log_id
       WHERE b.channel = $1
         AND b.message_id = $2
         AND a.outcome = 'pending_approval'
         AND a.expires_at > now()
       LIMIT 1`,
      [channel, messageId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  /**
   * Resolve a pending approval by its short_ref among non-expired pending rows.
   * Used when binding from outbound.delivered content that embeds `Reference: <ref>`.
   */
  async findPendingByShortRef(shortRef: string): Promise<ActionLogRow | null> {
    const result = await this.pool.query(
      `SELECT * FROM autonomy_action_log
       WHERE short_ref = $1
         AND outcome = 'pending_approval'
         AND expires_at > now()
       ORDER BY created_at ASC
       LIMIT 1`,
      [shortRef],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  /**
   * Find the live approval carrying `approvalNumber` (#2159 Phase 3). Used when binding from
   * outbound.delivered content that shows `Approval <n>`, so a reaction on that message can
   * resolve the approval.
   *
   * Uses the same lookup as resolvePending()'s number path (liveRowsByApprovalNumber), so the
   * mapper binds exactly the row "approve <n>" would resolve. Two live rows sharing a number
   * break the allocation invariant; then nothing is returned rather than a guess, since binding
   * the wrong row would let a reaction approve an action the principal never saw.
   */
  async findPendingByApprovalNumber(approvalNumber: number): Promise<ActionLogRow | null> {
    const live = await this.liveRowsByApprovalNumber(approvalNumber);
    return live.length === 1 ? live[0]! : null;
  }
}

// A ref of 1 to 3 digits is an approval number (#2159 Phase 3). short_refs are 8 hex
// characters (generateShortRef), so an all-digit ref this short can only be a number.
const APPROVAL_NUMBER_PATTERN = /^\d{1,3}$/;

/**
 * One pending row in an ambiguity list the coordinator relays to the principal (#2159 Phase 3):
 * `Approval 3 (a3f7c12b): <description>` for a numbered row, `a3f7c12b: <description>` otherwise.
 * The number leads because it is what the notification showed; the reference follows so two rows
 * sharing a number can still be told apart.
 */
function describeForChoice(row: ActionLogRow, opts: { withTask?: boolean } = {}): string {
  const task = opts.withTask ? `task: ${row.taskId}` : null;
  if (row.approvalNumber != null) {
    const inParens = task ? `${row.shortRef}, ${task}` : row.shortRef;
    return `Approval ${row.approvalNumber} (${inParens}): ${row.description}`;
  }
  return task ? `${row.shortRef} (${task}): ${row.description}` : `${row.shortRef}: ${row.description}`;
}

// Largest tool input (as JSON) kept on a spot-check pool row. Enough for message ids, labels
// and short titles; a long event description or email body is not worth the row size.
const SAMPLE_INPUT_MAX_CHARS = 2000;

/**
 * The tool input to persist on a pool row, or nothing when absent or too large. Keeping it
 * lets the spot-check digest resolve what a triage action touched (subject, sender) from the
 * message id, which is all a triage tool's input carries (#2159 Phase 3).
 */
function sampleInput(input: Record<string, unknown> | undefined): { input?: Record<string, unknown> } {
  if (!input) return {};
  return JSON.stringify(input).length <= SAMPLE_INPUT_MAX_CHARS ? { input } : {};
}

/** Map a snake_case DB row to a camelCase ActionLogRow. */
function mapRow(row: Record<string, unknown>): ActionLogRow {
  return {
    // pg returns int8 (BIGSERIAL) as a string; the spot-check map stores these ids as numbers.
    id: Number(row.id),
    taskId: row.task_id as string,
    conversationId: row.conversation_id as string | null,
    toolName: row.skill_name as string,
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
    parentActionId: row.parent_action_id == null ? null : Number(row.parent_action_id),
    shortRef: row.short_ref as string | null,
    // SMALLINT arrives as a number; `== null` also covers rows read before migration 098 ran.
    approvalNumber: row.approval_number == null ? null : Number(row.approval_number),
    description: row.description as string | null,
    sendResolution: readSendResolution(row.send_resolution),
    createdAt: new Date(row.created_at as string),
  };
}

function readSendResolution(value: unknown): ActionLogRow['sendResolution'] {
  if (value == null) return null;
  if (!Array.isArray(value)) return null;
  const pins: NonNullable<ActionLogRow['sendResolution']> = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object') return null;
    const rec = item as Record<string, unknown>;
    if (typeof rec.ref !== 'string' || typeof rec.identityId !== 'string' || typeof rec.identityName !== 'string') {
      return null;
    }
    pins.push({ ref: rec.ref, identityId: rec.identityId, identityName: rec.identityName });
  }
  return pins;
}
