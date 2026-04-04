// autonomy-service.ts — manages the global autonomy score for the Curia instance.
//
// The autonomy score (0–100) determines how independently Nathan operates.
// It maps to one of five bands, each with a behavioral description that is
// injected into the coordinator's system prompt on every task.
//
// Phase 1: CEO-controlled via get-autonomy / set-autonomy skills.
// Phase 2: Automatic adjustment based on action log data (future).

import type { Pool } from 'pg';
import type { Logger } from '../logger.js';

export type AutonomyBand =
  | 'full'
  | 'spot-check'
  | 'approval-required'
  | 'draft-only'
  | 'restricted';

export interface AutonomyConfig {
  score: number;
  band: AutonomyBand;
  updatedAt: Date;
  updatedBy: string;
}

export interface AutonomyHistoryEntry {
  id: number;
  score: number;
  previousScore: number | null;
  band: AutonomyBand;
  changedBy: string;
  reason: string | null;
  changedAt: Date;
}

// Static map of band labels to their behavioral descriptions.
// These are injected verbatim into the coordinator system prompt.
const BAND_DESCRIPTIONS: Record<AutonomyBand, string> = {
  'full':
    'Act independently. No confirmation needed for standard operations. Flag only genuinely ' +
    'novel, irreversible, or high-stakes actions — where the downside of acting without ' +
    'checking outweighs the cost of the pause.',
  'spot-check':
    'Proceed on routine tasks. For consequential actions — sending external communications, ' +
    'creating commitments, or acting on behalf of the CEO — note what you are doing in your ' +
    'response so the CEO maintains visibility. No need to stop and ask.',
  'approval-required':
    'For any consequential action, present your plan and explicitly ask for confirmation ' +
    'before proceeding. Routine reporting, summarization, and information retrieval can ' +
    'proceed without approval. When in doubt, draft and ask.',
  'draft-only':
    'Prepare drafts, plans, and analysis, but do not send, publish, schedule, or act on ' +
    'behalf of the CEO without an explicit instruction to do so. Surface your work for review; ' +
    'execution requires a direct go-ahead.',
  'restricted':
    'Present options and analysis only. Take no independent action. All outputs are advisory. ' +
    'Every step that would have an external effect requires explicit CEO instruction.',
};

// Human-readable band labels for display.
const BAND_LABELS: Record<AutonomyBand, string> = {
  'full': 'Full',
  'spot-check': 'Spot-check',
  'approval-required': 'Approval Required',
  'draft-only': 'Draft Only',
  'restricted': 'Restricted',
};

export class AutonomyService {
  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
  ) {}

  /** Derive the autonomy band from a numeric score. */
  static bandForScore(score: number): AutonomyBand {
    if (score >= 90) return 'full';
    if (score >= 80) return 'spot-check';
    if (score >= 70) return 'approval-required';
    if (score >= 60) return 'draft-only';
    return 'restricted';
  }

  /** Return the behavioral description for a band. */
  static bandDescription(band: AutonomyBand): string {
    return BAND_DESCRIPTIONS[band];
  }

  /**
   * Format the autonomy block for injection into the coordinator system prompt.
   * Returns a Markdown section with the current score, band label, and behavioral guidance.
   */
  static formatPromptBlock(config: AutonomyConfig): string {
    const label = BAND_LABELS[config.band];
    const description = BAND_DESCRIPTIONS[config.band];
    return [
      '## Autonomy Level',
      '',
      `Your current autonomy score is ${config.score} (${label}).`,
      '',
      description,
    ].join('\n');
  }

  /** Read the current autonomy config. Returns null if the row does not exist (pre-migration). */
  async getConfig(): Promise<AutonomyConfig | null> {
    try {
      const result = await this.pool.query<{
        score: number;
        band: string;
        updated_at: Date;
        updated_by: string;
      }>('SELECT score, band, updated_at, updated_by FROM autonomy_config WHERE id = 1');

      if (result.rows.length === 0) return null;

      const row = result.rows[0]!;
      return {
        score: row.score,
        band: row.band as AutonomyBand,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      };
    } catch (err) {
      // Log but don't throw — a missing table (pre-migration) should degrade gracefully.
      // The coordinator will just run without the autonomy block until the migration runs.
      this.logger.warn({ err }, 'autonomy-service: failed to read autonomy_config — is migration 011 applied?');
      return null;
    }
  }

  /**
   * Update the autonomy score. Upserts autonomy_config and appends to autonomy_history.
   * Throws if score is out of range [0, 100].
   */
  async setScore(score: number, changedBy: string, reason?: string): Promise<AutonomyConfig> {
    if (!Number.isInteger(score) || score < 0 || score > 100) {
      throw new Error(`Invalid autonomy score: ${score}. Must be an integer between 0 and 100.`);
    }

    const band = AutonomyService.bandForScore(score);

    // Read the current score before updating so history has previous_score.
    const current = await this.getConfig();
    const previousScore = current?.score ?? null;

    // Upsert the live config row.
    await this.pool.query(
      `INSERT INTO autonomy_config (id, score, band, updated_at, updated_by)
       VALUES (1, $1, $2, now(), $3)
       ON CONFLICT (id) DO UPDATE SET score = $1, band = $2, updated_at = now(), updated_by = $3`,
      [score, band, changedBy],
    );

    // Append to the append-only audit trail.
    await this.pool.query(
      `INSERT INTO autonomy_history (score, previous_score, band, changed_by, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [score, previousScore, band, changedBy, reason ?? null],
    );

    this.logger.info({ score, band, changedBy, previousScore }, 'Autonomy score updated');

    return { score, band, updatedAt: new Date(), updatedBy: changedBy };
  }

  /** Return the most recent history entries, newest first. */
  async getHistory(limit = 3): Promise<AutonomyHistoryEntry[]> {
    const result = await this.pool.query<{
      id: number;
      score: number;
      previous_score: number | null;
      band: string;
      changed_by: string;
      reason: string | null;
      changed_at: Date;
    }>(
      'SELECT id, score, previous_score, band, changed_by, reason, changed_at FROM autonomy_history ORDER BY changed_at DESC LIMIT $1',
      [limit],
    );

    return result.rows.map(row => ({
      id: row.id,
      score: row.score,
      previousScore: row.previous_score,
      band: row.band as AutonomyBand,
      changedBy: row.changed_by,
      reason: row.reason,
      changedAt: row.changed_at,
    }));
  }
}
