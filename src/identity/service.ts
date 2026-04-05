// service.ts — OfficeIdentityService
//
// System-layer service that owns the Curia instance identity (name, tone, constraints, etc.).
// Initialized before the coordinator boots so ${office_identity_block} is always available.
//
// Load precedence at startup (initialize()):
//   1. If office_identity_current exists in DB → load from DB (runtime edits take precedence)
//   2. If no DB record → load from config/office-identity.yaml and seed as version 1
//   3. If neither exists → fail fast with a clear error message
//
// Hot reload is triggered by:
//   - chokidar file watcher on config/office-identity.yaml (writes a new DB version, then calls reload())
//   - POST /api/identity/reload endpoint
//
// Every identity change emits a config.change bus event via the audit trail.

import * as fs from 'node:fs';
import yaml from 'js-yaml';
import chokidar, { type FSWatcher } from 'chokidar';
import type { Pool } from 'pg';
import type { Logger } from '../logger.js';
import type { EventBus } from '../bus/bus.js';
import { createConfigChange } from '../bus/events.js';
import { type OfficeIdentity, type OfficeIdentityVersion, BASELINE_TONE_OPTIONS } from './types.js';

// Raw YAML shape from config/office-identity.yaml.
// Kept separate from OfficeIdentity so we control the snake_case → camelCase mapping explicitly.
interface RawOfficeIdentityYaml {
  office?: {
    assistant?: {
      name?: string;
      title?: string;
      email_signature?: string;
    };
    tone?: {
      baseline?: string[];
      verbosity?: number;
      directness?: number;
    };
    behavioral_preferences?: string[];
    decision_style?: {
      external_actions?: string;
      internal_analysis?: string;
    };
    constraints?: string[];
  };
}

// Map verbosity score to prose guidance.
// Bands are approximate — these are guidelines, not hard cutoffs.
function verbosityGuidance(score: number): string {
  if (score <= 25) return 'Keep responses as brief as possible; omit context unless asked.';
  if (score <= 50) return 'Default to concise responses; expand when detail is clearly needed.';
  if (score <= 75) return 'Adapt response length to what the situation calls for.';
  return 'Default to thorough explanations; err toward more context.';
}

// Map directness score to prose guidance.
function directnessGuidance(score: number): string {
  if (score <= 25) return 'Be measured; acknowledge uncertainty with appropriate qualification.';
  if (score <= 50) return 'Lean toward directness but hedge where genuinely uncertain.';
  if (score <= 75) return 'Be direct; minimize unnecessary hedging and qualification.';
  return 'State positions plainly; avoid softening language.';
}

// Map decision_style enum to a human-readable prose phrase.
function decisionStylePhrase(style: 'conservative' | 'balanced' | 'proactive', domain: 'external' | 'internal'): string {
  if (domain === 'external') {
    if (style === 'conservative') return 'For external actions, be conservative — verify before acting.';
    if (style === 'balanced') return 'For external actions, use balanced judgment — act when confidence is high.';
    return 'For external actions, be proactive — act on good information without waiting for confirmation.';
  } else {
    if (style === 'conservative') return 'For internal analysis, be conservative — surface only well-supported conclusions.';
    if (style === 'balanced') return 'For internal analysis, use balanced judgment — share insights with appropriate confidence levels.';
    return 'For internal analysis, be proactive — surface insights without being asked.';
  }
}

// Build a human-readable diff summary for the audit event.
// Compares only the top-level shape to keep the summary concise and readable.
function buildDiffSummary(prev: OfficeIdentity, next: OfficeIdentity): string {
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
  if (JSON.stringify(prev.tone.baseline) !== JSON.stringify(next.tone.baseline)) {
    changes.push(`tone.baseline: [${prev.tone.baseline.join(', ')}] → [${next.tone.baseline.join(', ')}]`);
  }
  if (prev.tone.verbosity !== next.tone.verbosity) {
    changes.push(`tone.verbosity: ${prev.tone.verbosity} → ${next.tone.verbosity}`);
  }
  if (prev.tone.directness !== next.tone.directness) {
    changes.push(`tone.directness: ${prev.tone.directness} → ${next.tone.directness}`);
  }
  if (prev.decisionStyle.externalActions !== next.decisionStyle.externalActions) {
    changes.push(`decision_style.external_actions: ${prev.decisionStyle.externalActions} → ${next.decisionStyle.externalActions}`);
  }
  if (prev.decisionStyle.internalAnalysis !== next.decisionStyle.internalAnalysis) {
    changes.push(`decision_style.internal_analysis: ${prev.decisionStyle.internalAnalysis} → ${next.decisionStyle.internalAnalysis}`);
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
  private watcher: FSWatcher | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
    private readonly bus: EventBus,
    // Absolute path to config/office-identity.yaml (resolved in index.ts).
    private readonly configFilePath: string,
  ) {}

  /**
   * Initialize the service: load identity from DB or YAML, start file watcher.
   * Must be called before the coordinator boots.
   */
  async initialize(): Promise<void> {
    // Try to load from DB first — DB takes precedence over the file.
    const dbIdentity = await this.loadFromDb();
    if (dbIdentity) {
      this.cached = dbIdentity;
      this.logger.info('Office identity loaded from DB');
    } else {
      // No DB record — seed from YAML file as version 1.
      const fileIdentity = this.loadFromFile();
      await this.update(fileIdentity, 'file_load', 'Initial load from config/office-identity.yaml');
      this.logger.info('Office identity seeded from config/office-identity.yaml (version 1)');
    }

    // Start the file watcher so YAML edits take effect on the next coordinator turn.
    this.startFileWatcher();
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
   * changedBy: 'wizard' | 'api' | 'file_load'
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
        config: row.config as OfficeIdentity,
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
   *   3. Tone guidance (baseline + verbosity + directness)
   *   4. Decision style guidance
   *   5. Behavioral preferences (ordered list)
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

    // 3. Tone guidance.
    lines.push('**Communication style:**');
    // Join baseline words with " and " — matches the spec example output.
    const tonePhrase = id.tone.baseline.length > 0
      ? id.tone.baseline.join(' and ')
      : 'professional';
    lines.push(`Your tone is ${tonePhrase}.`);
    lines.push(verbosityGuidance(id.tone.verbosity));
    lines.push(directnessGuidance(id.tone.directness));
    lines.push('');

    // 4. Decision style.
    lines.push('**Decision posture:**');
    lines.push(decisionStylePhrase(id.decisionStyle.externalActions, 'external'));
    lines.push(decisionStylePhrase(id.decisionStyle.internalAnalysis, 'internal'));
    lines.push('');

    // 5. Behavioral preferences.
    lines.push('**Behavioral preferences:**');
    for (const pref of id.behavioralPreferences) {
      lines.push(`- ${pref}`);
    }

    return lines.join('\n');
  }

  /**
   * Stop the file watcher. Called during graceful shutdown.
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      try {
        await this.watcher.close();
        this.logger.debug('Office identity file watcher stopped');
      } catch (err) {
        this.logger.error({ err }, 'Error closing office identity file watcher');
        // Don't rethrow — callers (shutdown handler, tests) must be able to proceed
        // even if the watcher close fails. The process is going away anyway.
      } finally {
        // Null out even if close() throws so repeated stop() calls don't try to
        // close an already-errored watcher.
        this.watcher = null;
      }
    }
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
      return result.rows[0]!.config as OfficeIdentity;
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

  /** Load the identity config from the YAML file. Throws if file is missing or invalid. */
  private loadFromFile(): OfficeIdentity {
    let raw: string;
    try {
      raw = fs.readFileSync(this.configFilePath, 'utf-8');
    } catch (err) {
      throw new Error(
        `Cannot read office identity config at ${this.configFilePath}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        'Create config/office-identity.yaml to configure the office identity.',
      );
    }

    let parsed: RawOfficeIdentityYaml;
    try {
      parsed = yaml.load(raw) as RawOfficeIdentityYaml;
    } catch (err) {
      throw new Error(
        `Invalid YAML in ${this.configFilePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return this.mapYamlToIdentity(parsed);
  }

  /** Map the raw YAML shape to the normalized OfficeIdentity interface. */
  private mapYamlToIdentity(raw: RawOfficeIdentityYaml): OfficeIdentity {
    const o = raw?.office;
    if (!o) {
      throw new Error('config/office-identity.yaml is missing the top-level "office:" key');
    }
    if (!o.assistant?.name) {
      throw new Error('config/office-identity.yaml is missing office.assistant.name');
    }

    const externalActions = (o.decision_style?.external_actions ?? 'conservative') as 'conservative' | 'balanced' | 'proactive';
    const internalAnalysis = (o.decision_style?.internal_analysis ?? 'proactive') as 'conservative' | 'balanced' | 'proactive';

    return {
      assistant: {
        name: o.assistant.name,
        title: o.assistant.title ?? '',
        emailSignature: o.assistant.email_signature ?? '',
      },
      tone: {
        baseline: o.tone?.baseline ?? [],
        verbosity: o.tone?.verbosity ?? 50,
        directness: o.tone?.directness ?? 75,
      },
      behavioralPreferences: o.behavioral_preferences ?? [],
      decisionStyle: {
        externalActions,
        internalAnalysis,
      },
      constraints: o.constraints ?? [],
    };
  }

  /** Validate that the identity config is well-formed before persisting. */
  private validateIdentity(config: OfficeIdentity): void {
    if (!config.assistant?.name) {
      throw new Error('Office identity requires assistant.name');
    }
    // Guard nested fields before dereferencing — API payloads are not guaranteed
    // to match the TypeScript shape at runtime, and a null/missing tone would
    // throw a TypeError rather than a controlled validation error.
    if (!config.tone || !Array.isArray(config.tone.baseline)) {
      throw new Error('Office identity requires tone.baseline to be an array of 1–3 words');
    }
    if (config.tone.baseline.length > 3) {
      throw new Error(`tone.baseline may contain at most 3 words; got ${config.tone.baseline.length}`);
    }
    for (const word of config.tone.baseline) {
      if (!(BASELINE_TONE_OPTIONS as readonly string[]).includes(word)) {
        throw new Error(
          `tone.baseline word "${word}" is not in BASELINE_TONE_OPTIONS. ` +
          `Valid options: ${BASELINE_TONE_OPTIONS.join(', ')}`,
        );
      }
    }
    if (!Number.isInteger(config.tone.verbosity) || config.tone.verbosity < 0 || config.tone.verbosity > 100) {
      throw new Error(`tone.verbosity must be an integer between 0 and 100; got ${config.tone.verbosity}`);
    }
    if (!Number.isInteger(config.tone.directness) || config.tone.directness < 0 || config.tone.directness > 100) {
      throw new Error(`tone.directness must be an integer between 0 and 100; got ${config.tone.directness}`);
    }
    const validDecisionStyles = ['conservative', 'balanced', 'proactive'];
    if (!validDecisionStyles.includes(config.decisionStyle.externalActions)) {
      throw new Error(`decision_style.external_actions must be conservative | balanced | proactive`);
    }
    if (!validDecisionStyles.includes(config.decisionStyle.internalAnalysis)) {
      throw new Error(`decision_style.internal_analysis must be conservative | balanced | proactive`);
    }
  }

  /** Start watching the config file for changes. Writes a new DB version on change. */
  private startFileWatcher(): void {
    // chokidar watches the config file and triggers a reload on any change.
    // The write-then-reload sequence ensures the DB is always authoritative:
    // the file change writes a new DB version, then reload() reads from DB.
    this.watcher = chokidar.watch(this.configFilePath, {
      // Ignore initial add event — we've already loaded the file.
      ignoreInitial: true,
      // Stabilization delay to avoid multiple rapid events from a single save.
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    this.watcher.on('change', () => {
      this.logger.info({ path: this.configFilePath }, 'Office identity file changed — reloading');
      // Two-step: parse the file first, then write to DB.
      // Separated so parse errors (operator-fixable by editing the file again) are
      // distinguished from DB write errors (infrastructure failure requiring separate attention).
      Promise.resolve()
        .then(async () => {
          // Step 1: parse the updated YAML.
          // On failure (bad YAML, missing required fields), log and abort. The existing
          // in-memory identity is kept. The operator can fix the file and save again.
          let newIdentity: OfficeIdentity;
          try {
            newIdentity = this.loadFromFile();
          } catch (err: unknown) {
            this.logger.error(
              { err, path: this.configFilePath },
              'Failed to parse office identity YAML — keeping existing identity. Fix the file and save again to retry.',
            );
            return;
          }

          // Step 2: persist to DB. This is a more serious failure — the file was valid
          // but we couldn't commit the new version. Likely a DB connectivity issue.
          await this.update(newIdentity, 'file_load', 'Hot reload from config/office-identity.yaml');
        })
        .catch((err: unknown) => {
          this.logger.error(
            { err },
            'Failed to write office identity to DB during hot reload — keeping existing identity. Check database connectivity.',
          );
        });
    });

    this.watcher.on('error', (err: unknown) => {
      this.logger.error({ err }, 'Office identity file watcher error');
    });

    this.logger.debug({ path: this.configFilePath }, 'Office identity file watcher started');
  }
}
