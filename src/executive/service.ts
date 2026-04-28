// service.ts — ExecutiveProfileService
//
// System-layer service that owns the executive (CEO) profile — writing voice,
// style preferences, and (in future versions) communication preferences.
//
// This is separate from OfficeIdentityService, which owns the assistant's persona.
// The executive's identity (name, title, org) lives in the contact system; this
// service is purely about preferences and style.
//
// Load precedence at startup (initialize()):
//   1. If executive_profile_current exists in DB → load from DB (runtime edits take precedence)
//   2. If no DB record → load from config/executive-profile.yaml and seed as version 1
//   3. If neither exists → fail fast with a clear error message
//
// Hot reload is triggered by:
//   - chokidar file watcher on config/executive-profile.yaml
//   - POST /api/executive/reload endpoint
//
// Every profile change emits a config.change bus event via the audit trail.

import * as fs from 'node:fs';
import yaml from 'js-yaml';
import chokidar, { type FSWatcher } from 'chokidar';
import type { Pool } from 'pg';
import type { Logger } from '../logger.js';
import type { EventBus } from '../bus/bus.js';
import { createConfigChange } from '../bus/events.js';
import { type ExecutiveProfile, type ExecutiveProfileVersion } from './types.js';

// Raw YAML shape from config/executive-profile.yaml.
// Kept separate from ExecutiveProfile so we control the snake_case → camelCase mapping explicitly.
interface RawExecutiveProfileYaml {
  executive?: {
    writing_voice?: {
      tone?: string[];
      formality?: number;
      patterns?: string[];
      vocabulary?: {
        prefer?: string[];
        avoid?: string[];
      };
      sign_off?: string;
    };
  };
}

// Map formality score to prose guidance.
// Bands are approximate — these are guidelines, not hard cutoffs.
function formalityGuidance(score: number): string {
  if (score <= 25) return 'Keep the register casual — like a Slack message to a colleague.';
  if (score <= 50) return 'Write conversationally but with structure — like a thoughtful email to a peer.';
  if (score <= 75) return 'Professional and composed — like a well-crafted business email.';
  return 'Formal and precise — like a board communication or investor letter.';
}

// Build a human-readable diff summary for the audit event.
function buildDiffSummary(prev: ExecutiveProfile, next: ExecutiveProfile): string {
  const changes: string[] = [];
  const pv = prev.writingVoice;
  const nv = next.writingVoice;

  if (JSON.stringify(pv.tone) !== JSON.stringify(nv.tone)) {
    changes.push(`tone: [${pv.tone.join(', ')}] → [${nv.tone.join(', ')}]`);
  }
  if (pv.formality !== nv.formality) {
    changes.push(`formality: ${pv.formality} → ${nv.formality}`);
  }
  if (JSON.stringify(pv.patterns) !== JSON.stringify(nv.patterns)) {
    changes.push('patterns updated');
  }
  if (JSON.stringify(pv.vocabulary) !== JSON.stringify(nv.vocabulary)) {
    changes.push('vocabulary updated');
  }
  if (pv.signOff !== nv.signOff) {
    changes.push(`sign_off: "${pv.signOff}" → "${nv.signOff}"`);
  }

  return changes.length > 0 ? changes.join('; ') : 'no changes detected';
}

export class ExecutiveProfileService {
  // In-memory cached profile — populated during initialize(), refreshed via reload().
  private cached: ExecutiveProfile | null = null;
  private watcher: FSWatcher | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger,
    private readonly bus: EventBus,
    // Absolute path to config/executive-profile.yaml (resolved in index.ts).
    private readonly configFilePath: string,
  ) {}

  /**
   * Initialize the service: load profile from DB or YAML, start file watcher.
   */
  async initialize(): Promise<void> {
    // Try to load from DB first — DB takes precedence over the file.
    const dbProfile = await this.loadFromDb();
    if (dbProfile) {
      this.cached = dbProfile;
      this.logger.info('Executive profile loaded from DB');
    } else {
      // No DB record — seed from YAML file as version 1.
      const fileProfile = this.loadFromFile();
      await this.update(fileProfile, 'file_load', 'Initial load from config/executive-profile.yaml');
      this.logger.info('Executive profile seeded from config/executive-profile.yaml (version 1)');
    }

    // Start the file watcher so YAML edits take effect on the next coordinator turn.
    this.startFileWatcher();
  }

  /**
   * Returns the currently active profile (cached in memory after initialize()).
   * Throws if initialize() has not been called.
   */
  get(): ExecutiveProfile {
    if (!this.cached) {
      throw new Error('ExecutiveProfileService not initialized — call initialize() before get()');
    }
    return this.cached;
  }

  /**
   * Saves a new version to the DB, updates the in-memory cache, emits a config.change audit event.
   * changedBy: 'wizard' | 'api' | 'file_load'
   *
   * The DB write is fully atomic: version number computation, row insert, and current-pointer
   * upsert all happen inside a single transaction.
   */
  async update(config: ExecutiveProfile, changedBy: string, note?: string): Promise<void> {
    this.validateProfile(config);

    // Snapshot the previous config before writing — used for the diff summary.
    const previousConfig = this.cached;

    const client = await this.pool.connect();
    let nextVersion: number;
    let previousVersion: number;

    try {
      await client.query('BEGIN');

      // Compute the next version atomically: lock the current pointer row to prevent
      // two concurrent callers from both computing the same nextVersion.
      const lockResult = await client.query<{ version: number }>(
        `SELECT v.version
         FROM executive_profile_current c
         JOIN executive_profile_versions v ON v.id = c.version_id
         FOR UPDATE OF c`,
      );
      previousVersion = lockResult.rows[0]?.version ?? 0;
      nextVersion = previousVersion + 1;

      // Insert the new version row.
      const insertResult = await client.query<{ id: number }>(
        `INSERT INTO executive_profile_versions (version, config, changed_by, note)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [nextVersion, JSON.stringify(config), changedBy, note ?? null],
      );
      if (!insertResult.rows[0]) {
        throw new Error('Failed to persist executive profile version: INSERT returned no rows');
      }
      const newVersionId = insertResult.rows[0].id;

      // Upsert the current pointer to point at the new version.
      await client.query(
        `INSERT INTO executive_profile_current (singleton, version_id, updated_at)
         VALUES (TRUE, $1, now())
         ON CONFLICT (singleton) DO UPDATE
           SET version_id = EXCLUDED.version_id,
               updated_at = EXCLUDED.updated_at`,
        [newVersionId],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
        this.logger.error({ err: rollbackErr }, 'Failed to roll back executive profile update transaction');
      });
      throw err;
    } finally {
      client.release();
    }

    // Update the in-memory cache only after the transaction commits.
    this.cached = config;

    this.logger.info({ version: nextVersion, changedBy }, 'Executive profile updated');

    // Emit config.change audit event on the bus.
    // Best-effort — don't fail the update if the bus event fails.
    const diffSummary = previousConfig
      ? buildDiffSummary(previousConfig, config)
      : 'Initial profile loaded';

    const event = createConfigChange({
      config_type: 'executive_profile',
      version: nextVersion,
      previous_version: previousVersion,
      changed_by: changedBy,
      note,
      diff_summary: diffSummary,
    });
    this.bus.publish('system', event).catch((err: unknown) => {
      this.logger.error({ err }, 'Failed to publish config.change event for executive profile update');
    });
  }

  /**
   * Forces a reload from DB (used by hot reload after file write).
   * In-flight coordinator turns complete with the previous profile.
   * The new profile takes effect on the next turn.
   */
  async reload(): Promise<void> {
    let profile: ExecutiveProfile | null;
    try {
      profile = await this.loadFromDb();
    } catch (err) {
      this.logger.error({ err }, 'Failed to load executive profile from DB during reload');
      throw err;
    }
    if (!profile) {
      throw new Error(
        'Executive profile reload failed: no record found in executive_profile_current. ' +
        'This indicates a DB inconsistency — check that migration 029 was applied and ' +
        'that the most recent update() call completed successfully.',
      );
    }
    this.cached = profile;
    this.logger.info('Executive profile reloaded from DB');
  }

  /**
   * Returns all historical versions, newest first.
   */
  async history(): Promise<ExecutiveProfileVersion[]> {
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
         FROM executive_profile_versions
         ORDER BY version DESC`,
      );

      return result.rows.map(row => ({
        id: row.id,
        version: row.version,
        config: row.config as ExecutiveProfile,
        changedBy: row.changed_by,
        note: row.note ?? undefined,
        createdAt: row.created_at,
      }));
    } catch (err) {
      this.logger.error({ err }, 'Failed to query executive profile history');
      throw err;
    }
  }

  /**
   * Compiles the writing voice config into a system prompt block.
   *
   * The executiveName parameter comes from the contact system — the executive's
   * identity lives there, not in this profile. This avoids storing the name in
   * two places and keeps the profile purely about style/preferences.
   *
   * Output order:
   *   1. Header with executive name and context instruction
   *   2. Tone guidance (free-form descriptors + formality band)
   *   3. Writing patterns (ordered list)
   *   4. Vocabulary (prefer / avoid)
   *   5. Sign-off
   */
  compileWritingVoiceBlock(executiveName: string): string {
    const profile = this.get();
    const voice = profile.writingVoice;
    const lines: string[] = [];

    lines.push('## Executive Writing Voice');
    lines.push('');
    lines.push(`When drafting emails or content under ${executiveName}'s name, follow this voice guidance.`);
    lines.push('This is NOT your (the assistant\'s) voice — this is the executive\'s voice.');
    lines.push('');

    // 1. Tone
    if (voice.tone.length > 0) {
      const tonePhrase = voice.tone.join(' and ');
      lines.push('**Tone:**');
      lines.push(`Write in a tone that is ${tonePhrase}.`);
      lines.push(formalityGuidance(voice.formality));
      lines.push('');
    }

    // 2. Writing patterns
    if (voice.patterns.length > 0) {
      lines.push('**Writing patterns (follow these closely):**');
      for (const pattern of voice.patterns) {
        lines.push(`- ${pattern}`);
      }
      lines.push('');
    }

    // 3. Vocabulary
    if (voice.vocabulary.prefer.length > 0 || voice.vocabulary.avoid.length > 0) {
      lines.push('**Vocabulary:**');
      if (voice.vocabulary.prefer.length > 0) {
        lines.push(`Prefer: ${voice.vocabulary.prefer.join(', ')}`);
      }
      if (voice.vocabulary.avoid.length > 0) {
        lines.push(`Avoid: ${voice.vocabulary.avoid.join(', ')}`);
      }
      lines.push('');
    }

    // 4. Sign-off
    if (voice.signOff) {
      lines.push('**Sign-off:**');
      lines.push(`End emails with: ${voice.signOff}`);
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
        this.logger.debug('Executive profile file watcher stopped');
      } catch (err) {
        this.logger.error({ err }, 'Error closing executive profile file watcher');
      } finally {
        this.watcher = null;
      }
    }
  }

  // -- Private helpers --

  /** Load the active profile from the DB. Returns null if no record exists. */
  private async loadFromDb(): Promise<ExecutiveProfile | null> {
    try {
      const result = await this.pool.query<{ config: unknown }>(
        `SELECT v.config
         FROM executive_profile_current c
         JOIN executive_profile_versions v ON v.id = c.version_id`,
      );
      if (result.rows.length === 0) return null;
      return result.rows[0]!.config as ExecutiveProfile;
    } catch (err) {
      // Table doesn't exist yet (pre-migration) — treat as no record.
      const pgCode = (err as { code?: string }).code;
      if (pgCode === '42P01') {
        this.logger.warn('executive_profile tables not found — is migration 029 applied?');
        return null;
      }
      throw err;
    }
  }

  /** Load the profile config from the YAML file. Throws if file is missing or invalid. */
  private loadFromFile(): ExecutiveProfile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.configFilePath, 'utf-8');
    } catch (err) {
      throw new Error(
        `Cannot read executive profile config at ${this.configFilePath}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        'Create config/executive-profile.yaml to configure the executive profile.',
      );
    }

    let parsed: RawExecutiveProfileYaml;
    try {
      parsed = yaml.load(raw) as RawExecutiveProfileYaml;
    } catch (err) {
      throw new Error(
        `Invalid YAML in ${this.configFilePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return this.mapYamlToProfile(parsed);
  }

  /** Map the raw YAML shape to the normalized ExecutiveProfile interface. */
  private mapYamlToProfile(raw: RawExecutiveProfileYaml): ExecutiveProfile {
    const e = raw?.executive;
    if (!e) {
      throw new Error('config/executive-profile.yaml is missing the top-level "executive:" key');
    }
    const wv = e.writing_voice;
    if (!wv) {
      throw new Error('config/executive-profile.yaml is missing executive.writing_voice');
    }

    return {
      writingVoice: {
        tone: wv.tone ?? [],
        formality: wv.formality ?? 50,
        patterns: wv.patterns ?? [],
        vocabulary: {
          prefer: wv.vocabulary?.prefer ?? [],
          avoid: wv.vocabulary?.avoid ?? [],
        },
        signOff: wv.sign_off ?? '',
      },
    };
  }

  /** Validate that the profile config is well-formed before persisting. */
  private validateProfile(config: ExecutiveProfile): void {
    // Guard nested fields before dereferencing — API payloads are not guaranteed
    // to match the TypeScript shape at runtime.
    if (!config.writingVoice) {
      throw new Error('Executive profile requires writingVoice');
    }
    const voice = config.writingVoice;

    if (!Array.isArray(voice.tone) || !voice.tone.every(item => typeof item === 'string')) {
      throw new Error('writingVoice.tone must be an array of strings');
    }
    if (voice.tone.length > 3) {
      throw new Error(`writingVoice.tone may contain at most 3 descriptors; got ${voice.tone.length}`);
    }
    // Tone values are free-form strings — no predefined set validation.
    // The executive's voice is personal and should not be artificially constrained.

    if (!Number.isInteger(voice.formality) || voice.formality < 0 || voice.formality > 100) {
      throw new Error(`writingVoice.formality must be an integer between 0 and 100; got ${voice.formality}`);
    }

    if (!Array.isArray(voice.patterns) || !voice.patterns.every(item => typeof item === 'string')) {
      throw new Error('writingVoice.patterns must be an array of strings');
    }

    if (
      !voice.vocabulary ||
      !Array.isArray(voice.vocabulary.prefer) ||
      !voice.vocabulary.prefer.every(item => typeof item === 'string') ||
      !Array.isArray(voice.vocabulary.avoid) ||
      !voice.vocabulary.avoid.every(item => typeof item === 'string')
    ) {
      throw new Error('writingVoice.vocabulary must have prefer and avoid string arrays');
    }

    if (typeof voice.signOff !== 'string') {
      throw new Error('writingVoice.signOff must be a string');
    }
  }

  /** Start watching the config file for changes. Writes a new DB version on change. */
  private startFileWatcher(): void {
    this.watcher = chokidar.watch(this.configFilePath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    this.watcher.on('change', () => {
      this.logger.info({ path: this.configFilePath }, 'Executive profile file changed — reloading');
      Promise.resolve()
        .then(async () => {
          let newProfile: ExecutiveProfile;
          try {
            newProfile = this.loadFromFile();
          } catch (err: unknown) {
            this.logger.error(
              { err, path: this.configFilePath },
              'Failed to parse executive profile YAML — keeping existing profile. Fix the file and save again to retry.',
            );
            return;
          }
          await this.update(newProfile, 'file_load', 'Hot reload from config/executive-profile.yaml');
        })
        .catch((err: unknown) => {
          this.logger.error(
            { err },
            'Failed to write executive profile to DB during hot reload — keeping existing profile. Check database connectivity.',
          );
        });
    });

    this.watcher.on('error', (err: unknown) => {
      this.logger.error({ err }, 'Executive profile file watcher error');
    });

    this.logger.debug({ path: this.configFilePath }, 'Executive profile file watcher started');
  }
}
