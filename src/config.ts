import yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Multi-account email config types
// ---------------------------------------------------------------------------

/**
 * Outbound send policy for a named email account.
 *
 * - direct:          send immediately (default for Curia's own account)
 * - draft_gate:      create a Nylas draft and notify the CEO via email; CEO reviews in
 *                    Gmail and clicks send when ready (approval interface deferred — #278)
 * - autonomy_gated:  send autonomously only when the global autonomy score meets or
 *                    exceeds the account's autonomy_threshold value
 */
export type OutboundPolicy = 'direct' | 'draft_gate' | 'autonomy_gated';

/**
 * Raw per-account email entry as read from config/default.yaml.
 * Values may be literal strings or "env:VAR_NAME" env-var references.
 */
export interface RawEmailAccountConfig {
  nylas_grant_id: string;
  self_email: string;
  outbound_policy: OutboundPolicy;
  /** Required when outbound_policy is 'autonomy_gated'. Integer 0–100. */
  autonomy_threshold?: number;
  /**
   * When true, Curia monitors this inbox as an observer rather than acting as
   * the recipient. Inbound emails bypass the contact trust flow (no provisional
   * contact creation, no hold queue) and are delivered directly to the coordinator
   * with an observationMode flag in their metadata. The coordinator treats them as
   * third-party communications to surface to the CEO, not as instructions.
   *
   * Intended for accounts like the CEO's personal email where Curia should draft
   * replies on request but never act autonomously on incoming emails.
   */
  observation_mode?: boolean;
  /**
   * Additional sender email addresses to suppress from this account's inbox,
   * beyond the account's own selfEmail. Supports env:VAR_NAME references.
   *
   * Primary use case: exclude Curia's own outbound address from a monitored
   * inbox so that Curia's sent emails don't get re-processed as observations
   * (which would cause self-reply loops).
   */
  excluded_sender_emails?: string[];
}

/**
 * Fully resolved per-account email config with env-var references expanded
 * to their actual values. This is the shape passed to NylasClient and EmailAdapter.
 */
export interface ResolvedEmailAccount {
  /** Logical name for this account as declared in the YAML (e.g. "curia", "joseph"). */
  name: string;
  nylasGrantId: string;
  selfEmail: string;
  outboundPolicy: OutboundPolicy;
  /** Minimum autonomy score (0–100) required for autonomous sends. Only set when
   *  outboundPolicy is 'autonomy_gated'. */
  autonomyThreshold?: number;
  /** See RawEmailAccountConfig.observation_mode. */
  observationMode: boolean;
  /** Resolved sender addresses to suppress in addition to selfEmail. */
  excludedSenderEmails: string[];
}

export interface Config {
  databaseUrl: string;
  anthropicApiKey: string | undefined;
  openaiApiKey: string | undefined;
  logLevel: string;
  httpPort: number;
  apiToken: string | undefined;
  webAppBootstrapSecret: string | undefined;
  // Public origin of the app (e.g. "https://curia.example.com"). Used to restrict
  // CORS to a single origin and to set the Secure flag on session cookies.
  // Leave unset in local development — CORS is disabled and cookies are HTTP-only.
  appOrigin: string | undefined;
  timezone: string;
  nylasApiKey: string | undefined;
  nylasGrantId: string | undefined;
  nylasPollingIntervalMs: number;
  nylasSelfEmail: string;
  // CEO's primary email address. When set, the startup bootstrap ensures this
  // contact exists with status=confirmed and verified=true before any email arrives.
  // Without this, the first inbound email from the CEO creates them as provisional,
  // causing their messages to be held.
  ceoPrimaryEmail: string | undefined;
  // Signal channel config. Both must be set to enable the Signal adapter.
  // signalSocketPath: path to the signal-cli daemon Unix socket (e.g. /run/signal-cli/socket).
  //   In Docker Compose, this is mounted from the signal-cli container's socket volume.
  // signalPhoneNumber: the agent's E.164 number (e.g. +12223334444). This is the Signal account
  //   that was registered via `signal-cli register` + `signal-cli verify`.
  signalSocketPath: string | undefined;
  signalPhoneNumber: string | undefined;
}

/**
 * Typed shape for config/default.yaml.
 *
 * All fields are optional — the file may be partially populated or entirely
 * absent in test/CI environments. Callers must supply their own defaults.
 *
 * NOTE: Several fields in this interface are not yet wired up in index.ts
 * (browser, channels, agents). Those values are read with hardcoded defaults
 * instead of from the YAML. This is tracked in:
 * https://github.com/josephfung/curia/issues/204
 */
export interface YamlConfig {
  channels?: {
    cli?: { enabled?: boolean };
    /** Max inbound message content size in bytes. Default: 102400 (100KB).
     *  Messages exceeding this are rejected by the dispatcher before routing. */
    max_message_bytes?: number;
  };
  /**
   * Multi-account channel config (spec 03 - #3).
   *
   * Defines N named accounts per channel type, each with its own credentials
   * and outbound_policy. When this block is absent, the system falls back to the
   * legacy single-account env-var config (NYLAS_GRANT_ID + NYLAS_SELF_EMAIL).
   *
   * Values may be literal strings or "env:VAR_NAME" references resolved at startup.
   * The Nylas API key (NYLAS_API_KEY) is shared across all email accounts —
   * it is the application key, not per-account.
   *
   * Example:
   *   channel_accounts:
   *     email:
   *       curia:
   *         nylas_grant_id: env:NYLAS_GRANT_ID
   *         self_email: env:NYLAS_SELF_EMAIL
   *         outbound_policy: direct
   *       personal:
   *         nylas_grant_id: env:PERSONAL_NYLAS_GRANT_ID
   *         self_email: env:PERSONAL_EMAIL
   *         outbound_policy: draft_gate
   */
  channel_accounts?: {
    email?: Record<string, RawEmailAccountConfig>;
  };
  browser?: {
    sessionTtlMs?: number;
    sweepIntervalMs?: number;
  };
  agents?: {
    coordinator?: { config_path?: string };
  };
  workingMemory?: {
    summarization?: {
      /** Active turn count that triggers a summarization pass. Default: 20. Must be >= 2. */
      threshold?: number;
      /** Most-recent turns to retain as active after summarization. Default: 10. Must be < threshold. */
      keepWindow?: number;
    };
  };
  skillOutput?: {
    /** Max character length for skill results before truncation. Default: 200_000. */
    maxLength?: number;
  };
  dispatch?: {
    /** Milliseconds of inactivity before a conversation.checkpoint event is published.
     *  Defaults to 600000 (10 minutes). */
    conversationCheckpointDebounceMs?: number;
    rate_limit?: {
      /** Duration of each rate-limit window in milliseconds. Default: 60000 (1 minute). */
      window_ms?: number;
      /** Maximum messages allowed per sender per window. Default: 15. */
      max_per_sender?: number;
      /** Maximum total messages allowed per window across all senders. Default: 100. */
      max_global?: number;
    };
  };
  security?: {
    extra_injection_patterns?: Array<{ regex: string; label: string }>;
    trust_score?: {
      /** Weight for the channel trust component (0–1). Default: 0.4 */
      channel_weight?: number;
      /** Weight for the contact confidence component (0–1). Default: 0.4 */
      contact_weight?: number;
      /** Maximum penalty for injection risk (0–1). Default: 0.2 */
      max_risk_penalty?: number;
    };
    /** Minimum trust score; messages below this are held unless channel policy is 'ignore'. Default: 0.2 */
    trust_score_floor?: number;
  };
  trust_policy?: {
    financial_actions?: number;
    data_export?: number;
    scheduling?: number;
    information_queries?: number;
  };
  pii?: {
    /**
     * Extra PII patterns to scrub from LLM-facing error strings, beyond the
     * built-in defaults (email, phone, credit card, SSN).
     *
     * Each entry must have:
     *   regex       — a valid JavaScript regex string (gi flags applied automatically)
     *   replacement — the placeholder to substitute, e.g. "[EMPLOYEE_ID]"
     *
     * Changes take effect on restart.
     */
    extra_patterns?: Array<{ regex: string; replacement: string }>;
  };
  intentDrift?: {
    /** Enable intent drift detection. Default: true. */
    enabled?: boolean;
    /** Check every N bursts. Must be >= 1. Default: 1. */
    checkEveryNBursts?: number;
    /** Minimum LLM confidence required to pause the task. Default: 'high'. */
    minConfidenceToPause?: 'high' | 'medium' | 'low';
  };
  dreaming?: {
    decay?: {
      /** How often the decay pass runs in milliseconds. Default: 86400000 (daily). */
      intervalMs?: number;
      /** Confidence at or below this value triggers soft-delete. Default: 0.05. */
      archiveThreshold?: number;
      /** Half-life in days per decay class. null = never decays. */
      halfLifeDays?: {
        permanent?: null;
        slow_decay?: number;
        fast_decay?: number;
      };
    };
  };
}

/**
 * Recursively merge two plain objects. `override` wins on all scalar and
 * array conflicts; nested plain objects are merged recursively.
 *
 * Neither input is mutated — a new object is always returned.
 * Arrays are replaced, not concatenated: config arrays (e.g.
 * extra_injection_patterns) are self-contained lists, not additive.
 */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, overrideVal] of Object.entries(override)) {
    // Guard against prototype pollution via crafted YAML keys.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const baseVal = result[key];
    if (
      overrideVal !== null &&
      typeof overrideVal === 'object' &&
      !Array.isArray(overrideVal) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      // Both sides are plain objects — merge recursively.
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      );
    } else {
      // Scalar, array, or type mismatch — override wins outright.
      result[key] = overrideVal;
    }
  }
  return result;
}

/**
 * Load and parse config/default.yaml, then deep-merge config/local.yaml on
 * top if it exists. local.yaml is gitignored in this repo and supplied by
 * deployment repos (e.g. curia-deploy) at deploy time.
 *
 * @param configDir - Absolute path to the directory containing default.yaml.
 *   Pass `path.resolve(import.meta.dirname, '../config')` from index.ts.
 * @returns Merged and validated YAML config, or an empty object if
 *   default.yaml is absent (test/CI environments).
 * @throws If either file exists but cannot be parsed, or if the merged config
 *   fails validation — a broken config should cause a loud startup failure,
 *   not silently apply wrong defaults.
 */
export function loadYamlConfig(configDir: string): YamlConfig {
  // ── Step 1: parse default.yaml ──────────────────────────────────────────
  // Separate I/O (ENOENT-able) from parsing and structural validation so that
  // a "must contain a YAML mapping" error isn't caught and re-wrapped with the
  // "Failed to load" prefix (which would produce a doubled message).
  // ENOENT → empty config (test/CI environments where the file is absent).
  // Any other error → hard startup failure.
  let base: Record<string, unknown>;
  let defaultRaw: string;
  try {
    defaultRaw = readFileSync(path.join(configDir, 'default.yaml'), 'utf-8');
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw new Error(
      `Failed to load config/default.yaml: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let defaultParsed: unknown;
  try {
    defaultParsed = yaml.load(defaultRaw);
  } catch (err) {
    throw new Error(
      `Failed to load config/default.yaml: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (defaultParsed === undefined) {
    // Empty file (yaml.load returns undefined for '') — treat as no config.
    base = {};
  } else if (defaultParsed === null || typeof defaultParsed !== 'object' || Array.isArray(defaultParsed)) {
    // Explicit YAML null, a scalar, or a sequence — all invalid for a config root.
    throw new Error('config/default.yaml must contain a YAML mapping at the root');
  } else {
    base = defaultParsed as Record<string, unknown>;
  }

  // ── Step 2: merge config/local.yaml if present ──────────────────────────
  // local.yaml is gitignored and provided by deployment repos at deploy time.
  // ENOENT → silently skip (expected in dev, CI, and non-deployment envs).
  // Any other error → hard startup failure.
  // Same I/O/parse/validate separation as default.yaml above.
  const localPath = path.join(configDir, 'local.yaml');
  let localRaw: string | null = null;
  try {
    localRaw = readFileSync(localPath, 'utf-8');
  } catch (err) {
    if (!(err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT')) {
      throw new Error(
        `Failed to load config/local.yaml: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // ENOENT: local.yaml absent — proceed with default.yaml only.
  }
  if (localRaw !== null) {
    let localParsed: unknown;
    try {
      localParsed = yaml.load(localRaw);
    } catch (err) {
      throw new Error(
        `Failed to load config/local.yaml: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (localParsed === undefined) {
      // Empty file (yaml.load returns undefined for '') — treat as no override.
    } else if (localParsed === null || typeof localParsed !== 'object' || Array.isArray(localParsed)) {
      // Explicit YAML null, a scalar, or a sequence — all invalid for a config root.
      throw new Error('config/local.yaml must contain a YAML mapping at the root');
    } else {
      base = deepMerge(base, localParsed as Record<string, unknown>);
    }
  }

  // ── Step 3: validate the merged config ──────────────────────────────────
  // All validation below is identical to the original — it now runs on the
  // merged object so local.yaml additions are subject to the same checks.
  const config = base as YamlConfig;

  // Validate skillOutput.maxLength if present — a non-positive or non-integer value
  // would silently distort truncation behavior (e.g., negative would truncate to zero,
  // a float would be misinterpreted by slice()).
  const maxLength = config.skillOutput?.maxLength;
  if (maxLength !== undefined && (!Number.isInteger(maxLength) || maxLength <= 0)) {
    throw new Error(`skillOutput.maxLength must be a positive integer, got: ${maxLength}`);
  }

  const checkpointDebounceMs = config.dispatch?.conversationCheckpointDebounceMs;
  if (checkpointDebounceMs !== undefined && (!Number.isInteger(checkpointDebounceMs) || checkpointDebounceMs <= 0)) {
    throw new Error(
      `dispatch.conversationCheckpointDebounceMs must be a positive integer, got: ${checkpointDebounceMs}`,
    );
  }

  const rateLimit = config.dispatch?.rate_limit;
  if (rateLimit !== undefined) {
    const { window_ms, max_per_sender, max_global } = rateLimit;
    if (window_ms !== undefined && (!Number.isInteger(window_ms) || window_ms <= 0)) {
      throw new Error(`dispatch.rate_limit.window_ms must be a positive integer, got: ${window_ms}`);
    }
    if (max_per_sender !== undefined && (!Number.isInteger(max_per_sender) || max_per_sender <= 0)) {
      throw new Error(`dispatch.rate_limit.max_per_sender must be a positive integer, got: ${max_per_sender}`);
    }
    if (max_global !== undefined && (!Number.isInteger(max_global) || max_global <= 0)) {
      throw new Error(`dispatch.rate_limit.max_global must be a positive integer, got: ${max_global}`);
    }
    // Cross-validate: global must be at least as large as per-sender, otherwise no single
    // sender can ever reach their per-sender quota — the global becomes the effective ceiling
    // for everyone, making per-sender meaningless. This is almost certainly a misconfiguration.
    // Uses effective values (same defaults as index.ts) so a partial config is also caught.
    const effectiveMaxPerSender = max_per_sender ?? 15;
    const effectiveMaxGlobal = max_global ?? 100;
    if (effectiveMaxGlobal < effectiveMaxPerSender) {
      throw new Error(
        `dispatch.rate_limit.max_global (${effectiveMaxGlobal}) must be >= max_per_sender (${effectiveMaxPerSender})`,
      );
    }
  }

  if (config.workingMemory?.summarization !== undefined) {
    const summarizationThreshold = config.workingMemory.summarization.threshold;
    if (summarizationThreshold !== undefined && (!Number.isInteger(summarizationThreshold) || summarizationThreshold < 2)) {
      throw new Error(`workingMemory.summarization.threshold must be an integer >= 2, got: ${summarizationThreshold}`);
    }

    const summarizationKeepWindow = config.workingMemory.summarization.keepWindow;
    if (summarizationKeepWindow !== undefined && (!Number.isInteger(summarizationKeepWindow) || summarizationKeepWindow < 1)) {
      throw new Error(`workingMemory.summarization.keepWindow must be a positive integer, got: ${summarizationKeepWindow}`);
    }

    // Cross-validate using effective values (same defaults as index.ts bootstrap) so a
    // config like { keepWindow: 25 } (no explicit threshold) is caught here rather than
    // silently passing validation and failing at runtime.
    const effectiveThreshold = summarizationThreshold ?? 20;
    const effectiveKeepWindow = summarizationKeepWindow ?? 10;
    if (effectiveKeepWindow >= effectiveThreshold) {
      throw new Error(
        `workingMemory.summarization.keepWindow (${effectiveKeepWindow}) must be less than threshold (${effectiveThreshold})`,
      );
    }
  }

  // Validate channel_accounts if present
  const channelAccounts = config.channel_accounts?.email;
  if (channelAccounts !== undefined) {
    if (channelAccounts === null || typeof channelAccounts !== 'object' || Array.isArray(channelAccounts)) {
      throw new Error('channel_accounts.email must be a YAML mapping');
    }
    const validPolicies: OutboundPolicy[] = ['direct', 'draft_gate', 'autonomy_gated'];
    for (const [accountName, rawAccount] of Object.entries(channelAccounts)) {
      if (typeof rawAccount !== 'object' || rawAccount === null || Array.isArray(rawAccount)) {
        throw new Error(`channel_accounts.email.${accountName} must be a YAML mapping`);
      }
      if (typeof rawAccount.nylas_grant_id !== 'string' || !rawAccount.nylas_grant_id) {
        throw new Error(`channel_accounts.email.${accountName}.nylas_grant_id must be a non-empty string`);
      }
      if (typeof rawAccount.self_email !== 'string' || !rawAccount.self_email) {
        throw new Error(`channel_accounts.email.${accountName}.self_email must be a non-empty string`);
      }
      if (!validPolicies.includes(rawAccount.outbound_policy)) {
        throw new Error(
          `channel_accounts.email.${accountName}.outbound_policy must be one of: ${validPolicies.join(', ')}, got: "${rawAccount.outbound_policy}"`,
        );
      }
      if (rawAccount.outbound_policy === 'autonomy_gated') {
        if (rawAccount.autonomy_threshold === undefined) {
          throw new Error(
            `channel_accounts.email.${accountName}: outbound_policy 'autonomy_gated' requires autonomy_threshold`,
          );
        }
        if (!Number.isInteger(rawAccount.autonomy_threshold) || rawAccount.autonomy_threshold < 0 || rawAccount.autonomy_threshold > 100) {
          throw new Error(
            `channel_accounts.email.${accountName}.autonomy_threshold must be an integer 0–100, got: ${rawAccount.autonomy_threshold}`,
          );
        }
      }
      if (rawAccount.autonomy_threshold !== undefined && rawAccount.outbound_policy !== 'autonomy_gated') {
        throw new Error(
          `channel_accounts.email.${accountName}: autonomy_threshold is only valid when outbound_policy is 'autonomy_gated'`,
        );
      }
      if (rawAccount.observation_mode !== undefined && typeof rawAccount.observation_mode !== 'boolean') {
        throw new Error(
          `channel_accounts.email.${accountName}.observation_mode must be a boolean, got: ${typeof rawAccount.observation_mode}`,
        );
      }
      // Observation mode monitors someone else's inbox — replies must never be sent
      // directly. Enforce draft_gate so a human always reviews before sending.
      if (rawAccount.observation_mode === true && rawAccount.outbound_policy !== 'draft_gate') {
        throw new Error(
          `channel_accounts.email.${accountName}: observation_mode requires outbound_policy 'draft_gate'`,
        );
      }
      if (rawAccount.excluded_sender_emails !== undefined) {
        if (!Array.isArray(rawAccount.excluded_sender_emails)) {
          throw new Error(
            `channel_accounts.email.${accountName}.excluded_sender_emails must be a list of strings`,
          );
        }
        for (const entry of rawAccount.excluded_sender_emails) {
          if (typeof entry !== 'string' || !entry) {
            throw new Error(
              `channel_accounts.email.${accountName}.excluded_sender_emails entries must be non-empty strings`,
            );
          }
        }
      }
    }
  }

  const drift = config.intentDrift;
  if (drift !== undefined) {
    // Reject non-object roots (e.g. `intentDrift: false`, `intentDrift: "off"`, `intentDrift: []`).
    // Without this check, those values would pass the leaf validations below, then reach
    // index.ts where `yamlConfig.intentDrift?.enabled !== false` evaluates truthy-by-default,
    // silently enabling drift detection despite a clearly invalid config.
    if (typeof drift !== 'object' || drift === null || Array.isArray(drift)) {
      throw new Error('intentDrift must be a YAML mapping');
    }
    if (drift.enabled !== undefined && typeof drift.enabled !== 'boolean') {
      throw new Error(`intentDrift.enabled must be a boolean, got: ${String(drift.enabled)}`);
    }
    if (drift.checkEveryNBursts !== undefined) {
      if (!Number.isInteger(drift.checkEveryNBursts) || drift.checkEveryNBursts < 1) {
        throw new Error(
          `intentDrift.checkEveryNBursts must be a positive integer, got: ${drift.checkEveryNBursts}`,
        );
      }
    }
    const validConfidences = ['high', 'medium', 'low'];
    if (
      drift.minConfidenceToPause !== undefined &&
      !validConfidences.includes(drift.minConfidenceToPause)
    ) {
      throw new Error(
        `intentDrift.minConfidenceToPause must be one of: ${validConfidences.join(', ')}, got: "${drift.minConfidenceToPause}"`,
      );
    }
  }

  const dreaming = config.dreaming;
  if (dreaming !== undefined) {
    if (typeof dreaming !== 'object' || dreaming === null || Array.isArray(dreaming)) {
      throw new Error('dreaming must be a YAML mapping');
    }
    const decay = dreaming.decay;
    if (decay !== undefined) {
      if (typeof decay !== 'object' || decay === null || Array.isArray(decay)) {
        throw new Error('dreaming.decay must be a YAML mapping');
      }
      if (decay.intervalMs !== undefined && (!Number.isInteger(decay.intervalMs) || decay.intervalMs <= 0)) {
        throw new Error(`dreaming.decay.intervalMs must be a positive integer, got: ${decay.intervalMs}`);
      }
      if (decay.archiveThreshold !== undefined && (typeof decay.archiveThreshold !== 'number' || decay.archiveThreshold < 0 || decay.archiveThreshold > 1)) {
        throw new Error(`dreaming.decay.archiveThreshold must be a number between 0 and 1, got: ${decay.archiveThreshold}`);
      }
      const halfLifeDays = decay.halfLifeDays;
      if (halfLifeDays !== undefined) {
        if (typeof halfLifeDays !== 'object' || halfLifeDays === null || Array.isArray(halfLifeDays)) {
          throw new Error('dreaming.decay.halfLifeDays must be a YAML mapping');
        }
        for (const key of ['slow_decay', 'fast_decay'] as const) {
          const val = halfLifeDays[key];
          if (val !== undefined && (!Number.isInteger(val) || val <= 0)) {
            throw new Error(`dreaming.decay.halfLifeDays.${key} must be a positive integer, got: ${val}`);
          }
        }
        // permanent must be null (meaning it never decays) — any non-null value
        // would be silently ignored by the decay engine, which only loops over
        // slow_decay and fast_decay, making a non-null permanent a misconfiguration.
        if (halfLifeDays.permanent !== undefined && halfLifeDays.permanent !== null) {
          throw new Error(`dreaming.decay.halfLifeDays.permanent must be null (permanent nodes never decay), got: ${String(halfLifeDays.permanent)}`);
        }
      }
    }
  }

  return config;
}

// ---------------------------------------------------------------------------
// Multi-account resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an "env:VAR_NAME" reference to its actual env-var value, or pass
 * through a literal string unchanged.
 *
 * Throws at startup if a referenced env var is not set — a missing credential
 * should fail loudly rather than produce a silent no-op.
 */
function resolveEnvValue(value: string, context: string): string {
  if (value.startsWith('env:')) {
    const varName = value.slice(4);
    const resolved = process.env[varName];
    if (!resolved) {
      throw new Error(`${context}: env var "${varName}" is not set`);
    }
    return resolved;
  }
  return value;
}

/**
 * Resolve the final list of email accounts to bootstrap, merging YAML multi-account
 * config with the legacy env-var single-account fallback.
 *
 * Resolution order:
 *   1. If channel_accounts.email is present in YAML → use it (multi-account mode)
 *   2. Otherwise → fall back to NYLAS_GRANT_ID + NYLAS_SELF_EMAIL env vars with
 *      a synthetic "curia" account (single-account backward-compat mode)
 *
 * Returns an empty array when neither source provides credentials — in that case
 * the email channel is simply disabled at startup, matching existing behaviour.
 *
 * The Nylas API key (NYLAS_API_KEY) is always read from env and shared across all
 * accounts; it lives in Config, not per-account config.
 */
export function resolveChannelAccounts(yamlConfig: YamlConfig, config: Config): ResolvedEmailAccount[] {
  const emailAccounts = yamlConfig.channel_accounts?.email;

  // Multi-account mode: YAML block is present (even if empty).
  // An explicit empty mapping ({ }) means "no configured email accounts" — do NOT
  // fall through to the legacy env-var path, so operators can intentionally
  // disable email in YAML without the legacy account silently reappearing.
  if (emailAccounts !== undefined) {
    return Object.entries(emailAccounts).map(([name, raw]) => {
      const nylasGrantId = resolveEnvValue(
        raw.nylas_grant_id,
        `channel_accounts.email.${name}.nylas_grant_id`,
      );
      const selfEmail = resolveEnvValue(
        raw.self_email,
        `channel_accounts.email.${name}.self_email`,
      );
      const excludedSenderEmails = (raw.excluded_sender_emails ?? []).map((entry, i) =>
        resolveEnvValue(entry, `channel_accounts.email.${name}.excluded_sender_emails[${i}]`),
      );
      return {
        name,
        nylasGrantId,
        selfEmail,
        outboundPolicy: raw.outbound_policy,
        autonomyThreshold: raw.autonomy_threshold,
        observationMode: raw.observation_mode ?? false,
        excludedSenderEmails,
      };
    });
  }

  // Backward-compat mode: fall back to the legacy single-account env vars.
  // This path is only taken when channel_accounts.email is absent entirely,
  // ensuring existing single-account deployments require no config changes.
  if (config.nylasGrantId && config.nylasSelfEmail) {
    return [{
      name: 'curia',
      nylasGrantId: config.nylasGrantId,
      selfEmail: config.nylasSelfEmail,
      outboundPolicy: 'direct',
      observationMode: false,
      excludedSenderEmails: [],
    }];
  }

  // No credentials available — email channel will be disabled
  return [];
}

export function loadConfig(): Config {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  const httpPort = parseInt(process.env.HTTP_PORT ?? '3000', 10);
  if (isNaN(httpPort) || httpPort < 1 || httpPort > 65535) {
    throw new Error(`HTTP_PORT must be a valid port number (1-65535), got: ${process.env.HTTP_PORT}`);
  }

  const nylasPollingIntervalMs = parseInt(process.env.NYLAS_POLL_INTERVAL_MS ?? '30000', 10);
  if (isNaN(nylasPollingIntervalMs) || nylasPollingIntervalMs < 1000) {
    throw new Error(`NYLAS_POLL_INTERVAL_MS must be a number >= 1000, got: ${process.env.NYLAS_POLL_INTERVAL_MS}`);
  }

  return {
    databaseUrl,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    logLevel: process.env.LOG_LEVEL ?? 'info',
    httpPort,
    apiToken: process.env.API_TOKEN,
    webAppBootstrapSecret: process.env.WEB_APP_BOOTSTRAP_SECRET,
    appOrigin: process.env.APP_ORIGIN || undefined,
    timezone: process.env.TIMEZONE ?? 'America/Toronto',
    nylasApiKey: process.env.NYLAS_API_KEY,
    nylasGrantId: process.env.NYLAS_GRANT_ID,
    nylasPollingIntervalMs,
    nylasSelfEmail: process.env.NYLAS_SELF_EMAIL ?? '',
    ceoPrimaryEmail: process.env.CEO_PRIMARY_EMAIL?.trim().toLowerCase() || undefined,
    // .trim() prevents a whitespace-only value (e.g. "  ") from activating the
    // Signal adapter with a bogus socket path or phone number.
    signalSocketPath: process.env.SIGNAL_SOCKET_PATH?.trim() || undefined,
    signalPhoneNumber: process.env.SIGNAL_PHONE_NUMBER?.trim() || undefined,
  };
}
