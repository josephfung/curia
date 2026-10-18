// service.ts — OfficeIdentityService
//
// System-layer service that owns the Curia instance identity (name, tone, constraints, etc.).
// Initialized before the coordinator boots so ${office_identity_block} is always available.
//
// Load precedence at startup (initialize()):
//   1. If office_identity_current exists in DB → load from DB (the authoritative source)
//   2. If no DB record → seed the DB with DEFAULT_OFFICE_IDENTITY (changedBy='system_default')
//      so the wizard has a starting point on first boot.
//
// Hot reload is triggered by POST /api/identity/reload (called by the wizard after PUT).
// The YAML-file + chokidar watcher path has been removed — the DB is the single source
// of truth and the wizard is the only edit path.
//
// Every identity change emits a config.change bus event via the audit trail.

import type { Pool } from 'pg';
import type { Logger } from '../logger.js';
import type { EventBus } from '../bus/bus.js';
import { createConfigChange } from '../bus/events.js';
import { type OfficeIdentity, type OfficeIdentityVersion, TONE_STYLE_MAX_LENGTH } from './types.js';
import { DEFAULT_OFFICE_IDENTITY } from './defaults.js';
import { LEGACY_TONE_KEYS, LEGACY_TOP_LEVEL_KEYS, normalizeIdentity } from './normalize.js';

// Map verbosity score to prose guidance.
// Bands are approximate — these are guidelines, not hard cutoffs.
function verbosityGuidance(score: number): string {
  if (score <= 25) return 'Keep responses as brief as possible; omit context unless asked.';
  if (score <= 50) return 'Default to concise responses; expand when detail is clearly needed.';
  if (score <= 75) return 'Adapt response length to what the situation calls for.';
  return 'Default to thorough explanations; err toward more context.';
}

/**
 * Fixed, code-owned lines of the identity block. No style text can talk the model out of
 * them. Exported for tests now, and for the prompt-exfiltration marker sources in tone &
 * style PR 3 (#2143).
 */
export const REGISTER_LINE = 'Match the register of any example lines above, not their content.';
export const HONESTY_LINE = "Whatever your tone, say plainly when you are unsure or don't know something.";

/**
 * Whether a config's tone can be rendered: a non-empty style and an in-range verbosity.
 * A stored row is not re-validated on read, so the renderer checks before interpolating
 * rather than writing "undefined" into every agent's prompt.
 */
function renderableTone(tone: unknown): tone is OfficeIdentity['tone'] {
  if (typeof tone !== 'object' || tone === null) return false;
  const { style, verbosity } = tone as Record<string, unknown>;
  return typeof style === 'string' && style.trim() !== ''
    && typeof verbosity === 'number' && Number.isInteger(verbosity) && verbosity >= 0 && verbosity <= 100;
}

// Build a human-readable diff summary for the audit event.
// Compares only the top-level shape to keep the summary concise and readable. Both sides
// are normalized, so a legacy-to-new diff reads as a style change, not missing fields.
function buildDiffSummary(prevRaw: OfficeIdentity, nextRaw: OfficeIdentity): string {
  const prev = normalizeIdentity(prevRaw);
  const next = normalizeIdentity(nextRaw);
  const changes: string[] = [];

  if (prev.assistant.name !== next.assistant.name) {
    changes.push(`name: "${prev.assistant.name}" → "${next.assistant.name}"`);
  }
  if (prev.assistant.title !== next.assistant.title) {
    changes.push(`title: "${prev.assistant.title}" → "${next.assistant.title}"`);
  }
  if (prev.assistant.emailSignature !== next.assistant.emailSignature) {
    changes.push('email_signature updated');
  }
  // The style is free text, possibly long: say it changed, not what it says.
  if (prev.tone.style !== next.tone.style) {
    changes.push('tone.style updated');
  }
  if (prev.tone.verbosity !== next.tone.verbosity) {
    changes.push(`tone.verbosity: ${prev.tone.verbosity} → ${next.tone.verbosity}`);
  }
  if (JSON.stringify(prev.behavioralPreferences) !== JSON.stringify(next.behavioralPreferences)) {
    changes.push('behavioral_preferences updated');
  }
  if (JSON.stringify(prev.constraints) !== JSON.stringify(next.constraints)) {
    changes.push('constraints updated');
  }

  return changes.length > 0 ? changes.join('; ') : 'no changes detected';
}

export class OfficeIdentityService {
  // In-memory cached identity — populated during initialize(), refreshed via reload().
  private cached: OfficeIdentity | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
    private readonly bus: EventBus,
  ) {}

  /**
   * Initialize the service: load identity from DB, or seed in-code defaults if absent.
   * Must be called before the coordinator boots.
   */
  async initialize(): Promise<void> {
    const dbIdentity = await this.loadFromDb();
    if (dbIdentity) {
      this.cached = dbIdentity;
      this.logger.info('Office identity loaded from DB');
      return;
    }
    // No DB record — seed with the in-code defaults so the wizard has a starting
    // point and so ${office_identity_block} can compile to something sensible
    // before the operator first edits.
    await this.update(DEFAULT_OFFICE_IDENTITY, 'system_default', 'Initial seed from in-code defaults');
    this.logger.info('Office identity seeded from in-code defaults (version 1)');
  }

  /**
   * Returns the currently active identity (cached in memory after initialize()).
   * Throws if initialize() has not been called.
   */
  get(): OfficeIdentity {
    if (!this.cached) {
      throw new Error('OfficeIdentityService not initialized — call initialize() before get()');
    }
    return this.cached;
  }

  /**
   * Saves a new version to the DB, updates the in-memory cache, emits a config.change audit event.
   * changedBy: 'wizard' | 'api' | 'file_load' | 'tool' | 'system_default'
   *
   * The DB write is fully atomic: version number computation, row insert, and current-pointer
   * upsert all happen inside a single transaction. The UNIQUE constraint on `version` provides
   * a last-resort guard against duplicate version numbers if two callers race.
   */
  async update(config: OfficeIdentity, changedBy: string, note?: string): Promise<void> {
    this.validateIdentity(config);

    // Snapshot the previous config before writing — used for the diff summary.
    const previousConfig = this.cached;

    const client = await this.pool.connect();
    let nextVersion: number;
    let previousVersion: number;

    try {
      await client.query('BEGIN');

      // Compute the next version atomically: lock the current pointer row to prevent
      // two concurrent callers from both computing the same nextVersion.
      // If no current record exists (first seed), the FOR UPDATE returns 0 rows and
      // we start at version 1.
      const lockResult = await client.query<{ version: number }>(
        `SELECT v.version
         FROM office_identity_current c
         JOIN office_identity_versions v ON v.id = c.version_id
         FOR UPDATE OF c`,
      );
      previousVersion = lockResult.rows[0]?.version ?? 0;
      nextVersion = previousVersion + 1;

      // Insert the new version row.
      const insertResult = await client.query<{ id: number }>(
        `INSERT INTO office_identity_versions (version, config, changed_by, note)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [nextVersion, JSON.stringify(config), changedBy, note ?? null],
      );
      // INSERT ... RETURNING always yields exactly one row on success, but an explicit
      // check is clearer than a non-null assertion and makes the failure mode obvious.
      if (!insertResult.rows[0]) {
        throw new Error('Failed to persist office identity version: INSERT returned no rows');
      }
      const newVersionId = insertResult.rows[0].id;

      // Upsert the current pointer to point at the new version.
      await client.query(
        `INSERT INTO office_identity_current (singleton, version_id, updated_at)
         VALUES (TRUE, $1, now())
         ON CONFLICT (singleton) DO UPDATE
           SET version_id = EXCLUDED.version_id,
               updated_at = EXCLUDED.updated_at`,
        [newVersionId],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
        this.logger.error({ err: rollbackErr }, 'Failed to roll back office identity update transaction');
      });
      throw err;
    } finally {
      client.release();
    }

    // Update the in-memory cache only after the transaction commits.
    this.cached = config;

    this.logger.info({ version: nextVersion, changedBy }, 'Office identity updated');

    // Emit config.change audit event on the bus.
    // Best-effort — don't fail the update if the bus event fails.
    const diffSummary = previousConfig
      ? buildDiffSummary(previousConfig, config)
      : 'Initial identity loaded';

    const event = createConfigChange({
      config_type: 'office_identity',
      version: nextVersion,
      previous_version: previousVersion,
      changed_by: changedBy,
      note,
      diff_summary: diffSummary,
    });
    this.bus.publish('system', event).catch((err: unknown) => {
      this.logger.error({ err }, 'Failed to publish config.change event for office identity update');
    });
  }

  /**
   * Forces a reload from DB (used by hot reload after file write).
   * In-flight coordinator turns complete with the previous identity.
   * The new identity takes effect on the next turn.
   */
  async reload(): Promise<void> {
    let identity: OfficeIdentity | null;
    try {
      identity = await this.loadFromDb();
    } catch (err) {
      this.logger.error({ err }, 'Failed to load office identity from DB during reload');
      throw err;
    }
    if (!identity) {
      // After initialize() completes successfully, office_identity_current always has a record.
      // A null return here indicates DB inconsistency (missing pointer row) or a failed prior
      // update(). Throwing rather than silently keeping the stale cache ensures the HTTP route
      // returns 500 instead of 200 with the wrong identity — callers (e.g. the wizard) must
      // not believe a reload succeeded when the cache was not actually refreshed.
      throw new Error(
        'Office identity reload failed: no record found in office_identity_current. ' +
        'This indicates a DB inconsistency — check that migration 013 was applied and ' +
        'that the most recent update() call completed successfully.',
      );
    }
    this.cached = identity;
    this.logger.info('Office identity reloaded from DB');
  }

  /**
   * Returns all historical versions, newest first.
   */
  async history(): Promise<OfficeIdentityVersion[]> {
    try {
      const result = await this.pool.query<{
        id: number;
        version: number;
        config: unknown;
        changed_by: string;
        note: string | null;
        created_at: Date;
      }>(
        `SELECT id, version, config, changed_by, note, created_at
         FROM office_identity_versions
         ORDER BY version DESC`,
      );

      return result.rows.map(row => ({
        id: row.id,
        version: row.version,
        config: normalizeIdentity(row.config),
        changedBy: row.changed_by,
        note: row.note ?? undefined,
        createdAt: row.created_at,
      }));
    } catch (err) {
      this.logger.error({ err }, 'Failed to query office identity history');
      throw err;
    }
  }

  /**
   * Compiles the identity config into a system prompt block.
   *
   * Output order (constraints-first, per spec):
   *   1. Hard constraints (labeled section, placed first)
   *   2. Identity header (name, title)
   *   3. How you sound: the operator's style text, then the fixed register line
   *   4. Length: the Detail band's guidance
   *   5. The fixed honesty line
   *   6. Standing preferences (ordered list)
   *
   * Tone data that cannot be rendered (a stored row is not re-validated on read) is
   * logged at error and its sections (3 and 4) are left out. Everything else still
   * renders: throwing would make buildBaseSystemPrompt() drop the whole block, hard
   * constraints included.
   */
  compileSystemPromptBlock(): string {
    const id = this.get();
    const lines: string[] = [];

    lines.push('## Identity & Communication Contract');
    lines.push('');

    // 1. Hard constraints — first, labeled, non-negotiable.
    lines.push('**Hard constraints (non-negotiable):**');
    for (const constraint of id.constraints) {
      lines.push(`- ${constraint}`);
    }
    lines.push('');

    // 2. Identity header.
    lines.push('**Who you are:**');
    lines.push(`You are ${id.assistant.name}, ${id.assistant.title}.`);
    lines.push('');

    // 3–4. Style and length, only when the tone can be rendered.
    if (renderableTone(id.tone)) {
      lines.push('**How you sound:**');
      lines.push(id.tone.style.trim());
      lines.push(REGISTER_LINE);
      lines.push('');
      lines.push(`**Length:** ${verbosityGuidance(id.tone.verbosity)}`);
    } else {
      this.logger.error(
        { tone: id.tone },
        'Office identity tone is not renderable (style must be non-empty, verbosity 0–100) — tone and length guidance omitted',
      );
    }

    // 5. Honesty — code-owned, whatever the style says.
    lines.push(HONESTY_LINE);
    lines.push('');

    // 6. Standing preferences.
    lines.push('**Standing preferences:**');
    for (const pref of id.behavioralPreferences) {
      lines.push(`- ${pref}`);
    }

    return lines.join('\n');
  }

  /**
   * Graceful-shutdown hook. Currently a no-op (no background watchers or timers).
   * Kept on the API so existing shutdown sequences in src/index.ts continue to
   * compile and so future background work (e.g. periodic DB-pointer integrity
   * checks) has a place to land.
   */
  async stop(): Promise<void> {
    // intentionally empty
  }

  // -- Private helpers --

  /** Load the active identity from the DB. Returns null if no record exists. */
  private async loadFromDb(): Promise<OfficeIdentity | null> {
    try {
      const result = await this.pool.query<{ config: unknown }>(
        `SELECT v.config
         FROM office_identity_current c
         JOIN office_identity_versions v ON v.id = c.version_id`,
      );
      if (result.rows.length === 0) return null;
      return normalizeIdentity(result.rows[0]!.config);
    } catch (err) {
      // Table doesn't exist yet (pre-migration) — treat as no record.
      const pgCode = (err as { code?: string }).code;
      if (pgCode === '42P01') {
        this.logger.warn('office_identity tables not found — is migration 013 applied?');
        return null;
      }
      throw err;
    }
  }

  /**
   * Validate that the identity config is well-formed before persisting. Protected so the
   * test-mode stack's fixture identity (scenario style cases) is held to the same rules.
   */
  protected validateIdentity(config: OfficeIdentity): void {
    if (!config.assistant?.name) {
      throw new Error('Office identity requires assistant.name');
    }
    // Legacy fields mean a stale client: fail loudly rather than silently dropping them.
    const legacyTop = LEGACY_TOP_LEVEL_KEYS.filter(k => Object.hasOwn(config, k));
    const legacyTone = config.tone && typeof config.tone === 'object'
      ? LEGACY_TONE_KEYS.filter(k => Object.hasOwn(config.tone, k)).map(k => `tone.${k}`)
      : [];
    const legacy = [...legacyTone, ...legacyTop];
    if (legacy.length > 0) {
      throw new Error(
        `Office identity no longer accepts ${legacy.join(', ')}: tone words and directness are now ` +
        'one written tone.style, and decision style is set by the autonomy level. Reload the console and try again.',
      );
    }
    // Guard nested fields before dereferencing — API payloads are not guaranteed
    // to match the TypeScript shape at runtime, and a null/missing tone would
    // throw a TypeError rather than a controlled validation error.
    if (!config.tone || typeof config.tone.style !== 'string' || config.tone.style.trim() === '') {
      throw new Error('Office identity requires tone.style: a non-empty description of how the assistant sounds');
    }
    if (config.tone.style.length > TONE_STYLE_MAX_LENGTH) {
      throw new Error(`tone.style may be at most ${TONE_STYLE_MAX_LENGTH} characters; got ${config.tone.style.length}`);
    }
    if (!Number.isInteger(config.tone.verbosity) || config.tone.verbosity < 0 || config.tone.verbosity > 100) {
      throw new Error(`tone.verbosity must be an integer between 0 and 100; got ${config.tone.verbosity}`);
    }
    // Rendered as bullet lists: a string here would come out one character per bullet.
    for (const key of ['behavioralPreferences', 'constraints'] as const) {
      const list: unknown = config[key];
      if (!Array.isArray(list) || list.some(item => typeof item !== 'string')) {
        throw new Error(`Office identity requires ${key} to be a list of strings`);
      }
    }
  }
}
