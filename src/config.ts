import * as yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Multi-account email config types
// ---------------------------------------------------------------------------

/**
 * Fully resolved per-account email config. Account identity comes from the
 * email_accounts table; the grant is read from the vault. (#1101)
 */
export interface ResolvedEmailAccount {
  /** Logical account name (e.g. "curia"). */
  name: string;
  nylasGrantId: string;
  selfEmail: string;
}

export interface Config {
  databaseUrl: string;
  anthropicApiKey: string | undefined;
  openaiApiKey: string | undefined;
  openrouterApiKey: string | undefined;
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
  // CEO's Signal phone number in E.164 format (e.g. "+14155551234").
  // Used by OutboundGateway to exempt CEO-bound Signal messages from the autonomy gate.
  ceoSignalNumber: string | undefined;
  // Signal channel config. Both must be set to enable the Signal adapter.
  // signalSocketPath: path to the signal-cli daemon Unix socket (e.g. /run/signal-cli/socket).
  //   In Docker Compose, this is mounted from the signal-cli container's socket volume.
  // signalPhoneNumber: the agent's E.164 number (e.g. +12223334444). This is the Signal account
  //   that was registered via `signal-cli register` + `signal-cli verify`.
  signalSocketPath: string | undefined;
  signalPhoneNumber: string | undefined;
}

/** Per-resumable-task aggregate ceilings — progress-based circuit breaker (#1176). */
export interface ResumableCeilingsConfig {
  /** Consecutive paused slices with no forward progress before fail/escalate (K). */
  maxStalls: number;
  maxIterations: number;
  maxWallclockHours: number;
  maxCostUsd: number;
  /** Max plan-decomposition depth per subtree (#1266). */
  maxPlanDepth: number;
  /** Max adaptive re-plans per planned task (#1266). */
  maxReplansPerSubtree: number;
  /** Hours a child may stay blocked before a divergence signal (#1266). */
  blockedStepHours: number;
  /** Measured units/slice below this fraction of implied pace triggers divergence (#1266). */
  throughputDivergenceRatio: number;
}

export const DEFAULT_RESUMABLE_CEILINGS: ResumableCeilingsConfig = {
  maxStalls: 3,
  maxIterations: 100,
  maxWallclockHours: 24,
  maxCostUsd: 10,
  maxPlanDepth: 3,
  maxReplansPerSubtree: 5,
  blockedStepHours: 48,
  throughputDivergenceRatio: 0.5,
};

export interface TasksConfig {
  heartbeatIntervalMinutes: number;
  heartbeatMaxWakesPerTick: number;
  idleThresholdHours: number;
  staleWaitThresholdHours: number;
  /** Seconds until a paused resumable task's self-continuation wake fires. */
  resumableContinuationSeconds: number;
  /** Progress-based circuit-breaker defaults for resumable tasks (#1176). */
  resumableCeilings: ResumableCeilingsConfig;
}

export const DEFAULT_TASKS_CONFIG: TasksConfig = {
  heartbeatIntervalMinutes: 60,
  heartbeatMaxWakesPerTick: 5,
  idleThresholdHours: 4,
  staleWaitThresholdHours: 48,
  resumableContinuationSeconds: 30,
  resumableCeilings: DEFAULT_RESUMABLE_CEILINGS,
};

function resolveResumableCeilings(yaml: YamlConfig['tasks']): ResumableCeilingsConfig {
  const r = yaml?.resumableCeilings;
  return {
    maxStalls: r?.maxStalls ?? DEFAULT_RESUMABLE_CEILINGS.maxStalls,
    maxIterations: r?.maxIterations ?? DEFAULT_RESUMABLE_CEILINGS.maxIterations,
    maxWallclockHours: r?.maxWallclockHours ?? DEFAULT_RESUMABLE_CEILINGS.maxWallclockHours,
    maxCostUsd: r?.maxCostUsd ?? DEFAULT_RESUMABLE_CEILINGS.maxCostUsd,
    maxPlanDepth: r?.maxPlanDepth ?? DEFAULT_RESUMABLE_CEILINGS.maxPlanDepth,
    maxReplansPerSubtree: r?.maxReplansPerSubtree ?? DEFAULT_RESUMABLE_CEILINGS.maxReplansPerSubtree,
    blockedStepHours: r?.blockedStepHours ?? DEFAULT_RESUMABLE_CEILINGS.blockedStepHours,
    throughputDivergenceRatio: r?.throughputDivergenceRatio ?? DEFAULT_RESUMABLE_CEILINGS.throughputDivergenceRatio,
  };
}

/** Resolve the optional YAML tasks block to a fully-populated config with defaults. */
export function resolveTasksConfig(yaml: YamlConfig['tasks']): TasksConfig {
  return {
    heartbeatIntervalMinutes: yaml?.heartbeatIntervalMinutes ?? DEFAULT_TASKS_CONFIG.heartbeatIntervalMinutes,
    heartbeatMaxWakesPerTick: yaml?.heartbeatMaxWakesPerTick ?? DEFAULT_TASKS_CONFIG.heartbeatMaxWakesPerTick,
    idleThresholdHours: yaml?.idleThresholdHours ?? DEFAULT_TASKS_CONFIG.idleThresholdHours,
    staleWaitThresholdHours: yaml?.staleWaitThresholdHours ?? DEFAULT_TASKS_CONFIG.staleWaitThresholdHours,
    resumableContinuationSeconds: yaml?.resumableContinuationSeconds ?? DEFAULT_TASKS_CONFIG.resumableContinuationSeconds,
    resumableCeilings: resolveResumableCeilings(yaml),
  };
}

// ---------------------------------------------------------------------------
// Health observability config types
// ---------------------------------------------------------------------------

export interface HealthLivenessConfig {
  /** Fail email check if last poll is older than N × pollingIntervalMs. */
  emailStallFactor: number;
  /** Fail scheduler check if watchdog last ticked more than N seconds ago. */
  schedulerMaxTickS: number;
}

export interface HealthHeartbeats {
  llm_fast: string | null;
  llm_standard: string | null;
  llm_powerful: string | null;
  embeddings: string | null;
  image_gen: string | null;
  nylas: string | null;
  signal: string | null;
  google_workspace: string | null;
  tavily: string | null;
}

export interface HealthConfig {
  liveness: HealthLivenessConfig;
  canarySchedule: string;
  heartbeats: HealthHeartbeats;
}

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  liveness: {
    emailStallFactor: 3,
    schedulerMaxTickS: 120,
  },
  canarySchedule: '0 6 * * *',
  heartbeats: {
    llm_fast: null,
    llm_standard: null,
    llm_powerful: null,
    embeddings: null,
    image_gen: null,
    nylas: null,
    signal: null,
    google_workspace: null,
    tavily: null,
  },
};

/**
 * Validate a heartbeat URL: must be https:// to be safe to ping.
 * Returns null (without throwing) for empty, non-https, or malformed URLs.
 * The `key` parameter is reserved for future caller-side logging — this
 * function intentionally has no logger access.
 */
function validateHeartbeatUrl(raw: string | undefined | null, _key: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    // Non-https URLs are not safe to ping — discard them silently.
    if (url.protocol !== 'https:') return null;
    return raw;
  } catch {
    // Malformed URL — not parseable by the URL constructor.
    return null;
  }
}

/** Resolve the optional YAML health block to a fully-populated config with defaults. */
export function resolveHealthConfig(
  yamlHealth: YamlConfig['health'] | undefined,
): HealthConfig {
  const hb = yamlHealth?.heartbeats;
  return {
    liveness: {
      emailStallFactor:
        yamlHealth?.liveness?.email_stall_factor ??
        DEFAULT_HEALTH_CONFIG.liveness.emailStallFactor,
      schedulerMaxTickS:
        yamlHealth?.liveness?.scheduler_max_tick_s ??
        DEFAULT_HEALTH_CONFIG.liveness.schedulerMaxTickS,
    },
    canarySchedule: yamlHealth?.canary_schedule ?? DEFAULT_HEALTH_CONFIG.canarySchedule,
    heartbeats: {
      llm_fast: validateHeartbeatUrl(hb?.llm_fast, 'llm_fast'),
      llm_standard: validateHeartbeatUrl(hb?.llm_standard, 'llm_standard'),
      llm_powerful: validateHeartbeatUrl(hb?.llm_powerful, 'llm_powerful'),
      embeddings: validateHeartbeatUrl(hb?.embeddings, 'embeddings'),
      image_gen: validateHeartbeatUrl(hb?.image_gen, 'image_gen'),
      nylas: validateHeartbeatUrl(hb?.nylas, 'nylas'),
      signal: validateHeartbeatUrl(hb?.signal, 'signal'),
      google_workspace: validateHeartbeatUrl(hb?.google_workspace, 'google_workspace'),
      tavily: validateHeartbeatUrl(hb?.tavily, 'tavily'),
    },
  };
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
  browser?: {
    sessionTtlMs?: number;
    sweepIntervalMs?: number;
    /**
     * Persistent browser profile directory. Empty/absent → ${HOME}/.curia/browser-profile.
     * Must be on a mounted volume in production so cookies/session survive restarts.
     */
    profileDir?: string;
    /** Browser channel, e.g. "chrome" for real Chrome. Empty/absent → bundled Chromium. */
    channel?: string;
    /** Context locale (BCP 47). Default "en-US". */
    locale?: string;
  };
  agents?: {
    coordinator?: { config_path?: string };
  };
  workingMemory?: {
    /** Days before a working memory turn expires and is purged by the nightly DreamEngine pass. Default: 30. */
    ttlDays?: number;
    summarization?: {
      /** Active turn count that triggers a summarization pass. Default: 20. Must be >= 2. */
      threshold?: number;
      /** Most-recent turns to retain as active after summarization. Default: 10. Must be < threshold. */
      keepWindow?: number;
    };
  };
  documentWorkspace?: {
    /** Days of inactivity before `/scratch/<conversation-id>/…` documents are archived by DreamEngine. Default: 7. */
    scratchTtlDays?: number;
    /** KG promotion when a planned parent completes (#1241). */
    kgPromotion?: {
      enabled?: boolean;
      maxFacts?: number;
      maxRelationships?: number;
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
    /** Action threshold values compiled into the ${security_context_block} prompt injection. */
    trust_thresholds?: {
      information_query: number;
      scheduling: number;
      data_export: number;
      financial: number;
    };
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
    /**
     * Outbound PII redaction policy - controls which PII patterns are redacted
     * in outbound channel messages (email, Signal).
     *
     * Detection uses the same openredaction library as the log/LLM scrubber.
     * This config controls only the policy: which detected patterns are allowed
     * on which channels. Patterns not in a channel's allow list are redacted.
     */
    outbound_redaction?: {
      /** Kill switch. Default: true. */
      enabled?: boolean;
      /** Default action for unlisted pattern/channel combos. Default: 'block'. */
      default?: 'block' | 'allow';
      /** Per-channel allow lists. Patterns listed here pass through unredacted. */
      channel_policies?: Record<string, {
        /** Pattern labels (lowercase) allowed on this channel. */
        allow?: string[];
      }>;
    };
  };
  /**
   * Outbound content filter — Stage 2 LLM-as-judge (audience-leak detection).
   * Stage 1 (deterministic rules) has no config and always runs.
   */
  filter?: {
    llmJudge?: {
      /** Kill switch. When false, Stage 2 is skipped entirely. Default: true. */
      enabled?: boolean;
      /**
       * Model the judge runs on. A dedicated model string (NOT a tier reference)
       * so the judge can use a different vendor independently of the agent tiers.
       * Validated against the model registry at startup. Default: 'claude-haiku-4-5'.
       */
      model?: string;
      /** Hard timeout for the judge call in ms. Default: 5000. */
      timeout_ms?: number;
      /**
       * Failure handling. Default: 'split'.
       *   'split'  — judge unreachable (timeout/API error) → deliver; malformed verdict → block.
       *   'open'   — any judge failure → deliver.
       *   'closed' — any judge failure → block.
       */
      failMode?: 'split' | 'open' | 'closed';
    };
  };
  /** Bulk export gates for attachments and MCP record exports (#201). */
  exportControls?: {
    confidentialThreshold?: number;
    allowedDestinations?: {
      driveFolderIds?: string[];
      urls?: string[];
      filePaths?: string[];
    };
  };
  /**
   * Escalation-line policy judge (issue #948).
   * Classifies disclosure sensitivity and action consequence, then maps
   * tier × class → allow / escalate. Consumed by disclosure gate (#949)
   * and action gate (#950). Fail-closed by design.
   */
  escalation?: {
    judge?: {
      /** Kill switch. When false, both classifiers escalate without calling the model. Default: true. */
      enabled?: boolean;
      /**
       * Model for the judge. A dedicated string (NOT a tier reference) so it can
       * differ from the coordinator model. Validated against the registry at startup.
       * Default: 'claude-haiku-4-5'.
       */
      model?: string;
      /** Hard timeout per call in ms. Default: 5000. */
      timeout_ms?: number;
    };
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
      /** Percentile (0–1) for computing edge-count threshold. Default: 0.95 (top 5%). */
      edgeCountPercentile?: number;
      /** Minimum edge count threshold. Default: 5. */
      edgeCountFloor?: number;
      /** Days a warned node is held back from archiving. Default: 7. */
      warnHoldBackDays?: number;
    };
    autonomy_scoring?: {
      intervalMs?: number;
      model_tier?: string;
      batchSize?: number;
      minScoredActions?: number;
      halfLifeDays?: number;
      weakExpiredWeight?: number;
      ceoCooldownDays?: number;
      errorRateThreshold?: number;
    };
  };
  contact_creation_limits?: {
    /** Maximum new contacts created from a single email's participant list. Default: 10. */
    max_per_message?: number;
    /** Maximum new contacts created per hour, per email account. Default: 100. */
    max_per_hour?: number;
  };
  /** Capability-tier model routing (ADR-014).
   *  Maps tier names to model names. Provider is resolved from the ModelRegistry.
   *  Agents declare a tier in their YAML; the operator controls which model each tier resolves to. */
  model_routing?: {
    tiers: {
      fast: { model: string };
      standard: { model: string };
      powerful: { model: string };
    };
    default_tier: 'fast' | 'standard' | 'powerful';
  };

  contextBridge?: {
    /** TTL in hours for auto-registered entries (no explicit context_bridge param). Default: 6. */
    defaultExpiryHours?: number;
    /** TTL in hours for entries with explicit context_bridge metadata. Default: 24. */
    explicitExpiryHours?: number;
  };

  /** Meeting debrief agent configuration (spec §17-meeting-debrief.md). */
  debrief?: {
    /** Channel for debrief prompts. Default: 'signal'. */
    channel?: 'signal' | 'email';
    /** Minutes before a reminder is sent for unanswered debriefs. Default: 120. */
    reminderDelayMinutes?: number;
    /** TTL in hours for context bridge entries linking replies to the debrief agent. Default: 48. */
    contextBridgeTtlHours?: number;
  };

  delegate?: {
    /** Default timeout in ms for specialist delegations when no timeout_ms is passed. Default: 90000.
     *  Override in local.yaml to match your deployment's standard-tier model latency. */
    defaultTimeoutMs?: number;
  };
  scheduler?: {
    /** Default assumed duration in seconds for scheduled jobs that declare no expectedDurationSeconds.
     *  Used by the watchdog to compute recovery timeouts. Default: 600. */
    defaultExpectedDurationSeconds?: number;
  };
  tasks?: {
    /** BacklogHeartbeat tick interval in minutes. Default 60. */
    heartbeatIntervalMinutes?: number;
    /** Max task wakes enqueued per heartbeat tick (global cap). Default 5. */
    heartbeatMaxWakesPerTick?: number;
    /** Hours an unblocked curia-owned task may sit untouched before the heartbeat
     *  pokes it. Default 4. */
    idleThresholdHours?: number;
    /** Hours a waiting/blocked task with no pending wake may sit before the
     *  heartbeat surfaces it as an orphaned wait. Default 48. */
    staleWaitThresholdHours?: number;
    /** Seconds until a paused resumable task's self-continuation wake fires. Default 30. */
    resumableContinuationSeconds?: number;
    /** Progress-based circuit-breaker ceilings for resumable tasks (#1176). */
    resumableCeilings?: {
      /** Consecutive no-progress pauses before fail/escalate (K). Default 3. */
      maxStalls?: number;
      /** Max continuation slices. Default 100. */
      maxIterations?: number;
      /** Max wallclock hours from first pause. Default 24. */
      maxWallclockHours?: number;
      /** Max aggregate LLM cost (USD) across slices. Default 10. */
      maxCostUsd?: number;
      /** Max plan-decomposition depth per subtree. Default 3. */
      maxPlanDepth?: number;
      /** Max adaptive re-plans per planned task. Default 5. */
      maxReplansPerSubtree?: number;
      /** Hours a blocked child may sit before a divergence signal. Default 48. */
      blockedStepHours?: number;
      /** Throughput divergence ratio threshold (0–1). Default 0.5. */
      throughputDivergenceRatio?: number;
    };
  };
  health?: {
    liveness?: {
      email_stall_factor?: number;
      scheduler_max_tick_s?: number;
    };
    canary_schedule?: string;
    heartbeats?: {
      llm_fast?: string;
      llm_standard?: string;
      llm_powerful?: string;
      embeddings?: string;
      image_gen?: string;
      nylas?: string;
      signal?: string;
      google_workspace?: string;
      tavily?: string;
    };
  };
  autonomy?: {
    /**
     * Bypass-ladder thresholds (#1125) — raw autonomy scores governing how much LINEAGE
     * standing a heartbeat-woken task inherits. The live score can only ever DOWNGRADE
     * inherited standing, never grant it. Defaults: same_task 70, derived_child 90.
     */
    bypass_ladder?: {
      /** Min live score for a same-task heartbeat wake to keep lineage standing (posture B).
       *  Should not drop below 60 (see effective-standing.ts). Default 70. */
      same_task?: number;
      /** Min live score for a freshly-derived child task to keep lineage standing (posture D).
       *  Default 90. */
      derived_child?: number;
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
  // js-yaml v5 throws on empty input instead of returning undefined; guard here
  // to preserve the "empty file = no config" contract.
  if (defaultRaw.trim() === '') {
    defaultParsed = undefined;
  } else {
    try {
      defaultParsed = yaml.load(defaultRaw);
    } catch (err) {
      throw new Error(
        `Failed to load config/default.yaml: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (defaultParsed === undefined) {
    // Empty file — treat as no config.
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
    // js-yaml v5 throws on empty input; guard here to preserve the "empty file = no override" contract.
    if (localRaw.trim() === '') {
      localParsed = undefined;
    } else {
      try {
        localParsed = yaml.load(localRaw);
      } catch (err) {
        throw new Error(
          `Failed to load config/local.yaml: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (localParsed === undefined) {
      // Empty file — treat as no override.
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

  // Validate the browser block. config/local.yaml is deep-merged above but not
  // schema-validated, so a bad override (e.g. sweepIntervalMs: 0 or -1) would otherwise
  // reach BrowserService and schedule near-continuous sweeps. Reject malformed values here.
  const browser = config.browser;
  if (browser !== undefined) {
    const { sessionTtlMs, sweepIntervalMs, profileDir, channel, locale } = browser;
    if (sessionTtlMs !== undefined && (!Number.isInteger(sessionTtlMs) || sessionTtlMs <= 0)) {
      throw new Error(`browser.sessionTtlMs must be a positive integer, got: ${sessionTtlMs}`);
    }
    if (sweepIntervalMs !== undefined && (!Number.isInteger(sweepIntervalMs) || sweepIntervalMs <= 0)) {
      throw new Error(`browser.sweepIntervalMs must be a positive integer, got: ${sweepIntervalMs}`);
    }
    for (const [key, value] of [['profileDir', profileDir], ['channel', channel], ['locale', locale]] as const) {
      if (value !== undefined && typeof value !== 'string') {
        throw new Error(`browser.${key} must be a string, got: ${typeof value}`);
      }
    }
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

  const workingMemory = config.workingMemory;
  if (workingMemory !== undefined) {
    if (workingMemory === null || typeof workingMemory !== 'object' || Array.isArray(workingMemory)) {
      throw new Error('workingMemory must be a YAML mapping');
    }

    if (workingMemory.ttlDays !== undefined) {
      const ttlDays = workingMemory.ttlDays;
      // Upper bound of 36500 (100 years) prevents JS date arithmetic overflow
      // (Date.now() + ttlDays * 86_400_000 must stay within the safe Date range).
      if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 36500) {
        throw new Error(`workingMemory.ttlDays must be a positive integer no greater than 36500, got: ${ttlDays}`);
      }
    }

    if (workingMemory.summarization !== undefined) {
      const summarizationThreshold = workingMemory.summarization.threshold;
      if (summarizationThreshold !== undefined && (!Number.isInteger(summarizationThreshold) || summarizationThreshold < 2)) {
        throw new Error(`workingMemory.summarization.threshold must be an integer >= 2, got: ${summarizationThreshold}`);
      }

      const summarizationKeepWindow = workingMemory.summarization.keepWindow;
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
  }

  const documentWorkspace = config.documentWorkspace;
  if (documentWorkspace !== undefined) {
    if (documentWorkspace === null || typeof documentWorkspace !== 'object' || Array.isArray(documentWorkspace)) {
      throw new Error('documentWorkspace must be a YAML mapping');
    }

    if (documentWorkspace.scratchTtlDays !== undefined) {
      const scratchTtlDays = documentWorkspace.scratchTtlDays;
      if (!Number.isInteger(scratchTtlDays) || scratchTtlDays < 1 || scratchTtlDays > 36500) {
        throw new Error(
          `documentWorkspace.scratchTtlDays must be a positive integer no greater than 36500, got: ${scratchTtlDays}`,
        );
      }
    }

    const kgPromotion = documentWorkspace.kgPromotion;
    if (kgPromotion !== undefined) {
      if (kgPromotion === null || typeof kgPromotion !== 'object' || Array.isArray(kgPromotion)) {
        throw new Error('documentWorkspace.kgPromotion must be a YAML mapping');
      }
      if (kgPromotion.enabled !== undefined && typeof kgPromotion.enabled !== 'boolean') {
        throw new Error(`documentWorkspace.kgPromotion.enabled must be a boolean, got: ${String(kgPromotion.enabled)}`);
      }
      if (kgPromotion.maxFacts !== undefined) {
        if (!Number.isInteger(kgPromotion.maxFacts) || kgPromotion.maxFacts < 0) {
          throw new Error(`documentWorkspace.kgPromotion.maxFacts must be a non-negative integer, got: ${String(kgPromotion.maxFacts)}`);
        }
      }
      if (kgPromotion.maxRelationships !== undefined) {
        if (!Number.isInteger(kgPromotion.maxRelationships) || kgPromotion.maxRelationships < 0) {
          throw new Error(
            `documentWorkspace.kgPromotion.maxRelationships must be a non-negative integer, got: ${String(kgPromotion.maxRelationships)}`,
          );
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
      if (decay.edgeCountPercentile !== undefined && (!Number.isFinite(decay.edgeCountPercentile) || decay.edgeCountPercentile < 0 || decay.edgeCountPercentile > 1)) {
        throw new Error(`dreaming.decay.edgeCountPercentile must be a number between 0 and 1, got: ${decay.edgeCountPercentile}`);
      }
      if (decay.edgeCountFloor !== undefined && (!Number.isInteger(decay.edgeCountFloor) || decay.edgeCountFloor < 0)) {
        throw new Error(`dreaming.decay.edgeCountFloor must be a non-negative integer, got: ${decay.edgeCountFloor}`);
      }
      if (decay.warnHoldBackDays !== undefined && (!Number.isInteger(decay.warnHoldBackDays) || decay.warnHoldBackDays < 0)) {
        throw new Error(`dreaming.decay.warnHoldBackDays must be a non-negative integer, got: ${decay.warnHoldBackDays}`);
      }
    }
    const autonomyScoring = dreaming.autonomy_scoring;
    if (autonomyScoring !== undefined) {
      if (typeof autonomyScoring !== 'object' || autonomyScoring === null || Array.isArray(autonomyScoring)) {
        throw new Error('dreaming.autonomy_scoring must be a YAML mapping');
      }
      // Reject the deprecated autonomy_scoring.model key so operators don't silently
      // use a config key that is no longer read. The replacement is model_tier.
      if ('model' in (autonomyScoring as object)) {
        throw new Error('dreaming.autonomy_scoring.model is deprecated — use dreaming.autonomy_scoring.model_tier instead');
      }
      if (autonomyScoring.intervalMs !== undefined && (!Number.isInteger(autonomyScoring.intervalMs) || autonomyScoring.intervalMs <= 0)) {
        throw new Error(`dreaming.autonomy_scoring.intervalMs must be a positive integer, got: ${autonomyScoring.intervalMs}`);
      }
      if (autonomyScoring.model_tier !== undefined && (typeof autonomyScoring.model_tier !== 'string' || autonomyScoring.model_tier.trim().length === 0)) {
        throw new Error(`dreaming.autonomy_scoring.model_tier must be a non-empty string, got: ${String(autonomyScoring.model_tier)}`);
      }
      if (autonomyScoring.batchSize !== undefined && (!Number.isInteger(autonomyScoring.batchSize) || autonomyScoring.batchSize <= 0)) {
        throw new Error(`dreaming.autonomy_scoring.batchSize must be a positive integer, got: ${autonomyScoring.batchSize}`);
      }
      if (autonomyScoring.minScoredActions !== undefined && (!Number.isInteger(autonomyScoring.minScoredActions) || autonomyScoring.minScoredActions <= 0)) {
        throw new Error(`dreaming.autonomy_scoring.minScoredActions must be a positive integer, got: ${autonomyScoring.minScoredActions}`);
      }
      if (autonomyScoring.halfLifeDays !== undefined && (typeof autonomyScoring.halfLifeDays !== 'number' || autonomyScoring.halfLifeDays <= 0)) {
        throw new Error(`dreaming.autonomy_scoring.halfLifeDays must be a positive number, got: ${autonomyScoring.halfLifeDays}`);
      }
      if (autonomyScoring.weakExpiredWeight !== undefined && (typeof autonomyScoring.weakExpiredWeight !== 'number' || autonomyScoring.weakExpiredWeight < 0 || autonomyScoring.weakExpiredWeight > 1)) {
        throw new Error(`dreaming.autonomy_scoring.weakExpiredWeight must be a number between 0 and 1, got: ${autonomyScoring.weakExpiredWeight}`);
      }
      if (autonomyScoring.ceoCooldownDays !== undefined && (!Number.isInteger(autonomyScoring.ceoCooldownDays) || autonomyScoring.ceoCooldownDays < 0)) {
        throw new Error(`dreaming.autonomy_scoring.ceoCooldownDays must be a non-negative integer, got: ${autonomyScoring.ceoCooldownDays}`);
      }
      if (autonomyScoring.errorRateThreshold !== undefined && (typeof autonomyScoring.errorRateThreshold !== 'number' || autonomyScoring.errorRateThreshold < 0 || autonomyScoring.errorRateThreshold > 1)) {
        throw new Error(`dreaming.autonomy_scoring.errorRateThreshold must be a number between 0 and 1, got: ${autonomyScoring.errorRateThreshold}`);
      }
    }
  }

  // Validate contextBridge if present
  if (config.contextBridge != null && typeof config.contextBridge === 'object') {
    const { defaultExpiryHours, explicitExpiryHours } = config.contextBridge;
    if (defaultExpiryHours !== undefined && (!Number.isInteger(defaultExpiryHours) || defaultExpiryHours < 1)) {
      throw new Error(`contextBridge.defaultExpiryHours must be a positive integer, got: ${defaultExpiryHours}`);
    }
    if (explicitExpiryHours !== undefined && (!Number.isInteger(explicitExpiryHours) || explicitExpiryHours < 1)) {
      throw new Error(`contextBridge.explicitExpiryHours must be a positive integer, got: ${explicitExpiryHours}`);
    }
  }

  // Validate contact_creation_limits if present
  const contactLimits = config.contact_creation_limits;
  if (contactLimits !== undefined) {
    if (typeof contactLimits !== 'object' || contactLimits === null || Array.isArray(contactLimits)) {
      throw new Error('contact_creation_limits must be a YAML mapping');
    }
    const maxPerMessage = contactLimits.max_per_message;
    if (maxPerMessage !== undefined && (!Number.isInteger(maxPerMessage) || maxPerMessage <= 0)) {
      throw new Error(`contact_creation_limits.max_per_message must be a positive integer, got: ${maxPerMessage}`);
    }
    const maxPerHour = contactLimits.max_per_hour;
    if (maxPerHour !== undefined && (!Number.isInteger(maxPerHour) || maxPerHour <= 0)) {
      throw new Error(`contact_creation_limits.max_per_hour must be a positive integer, got: ${maxPerHour}`);
    }
  }

  // Validate debrief config if present
  const debrief = config.debrief;
  if (debrief !== undefined) {
    if (typeof debrief !== 'object' || debrief === null || Array.isArray(debrief)) {
      throw new Error('debrief must be a YAML mapping');
    }
    if (debrief.channel !== undefined && debrief.channel !== 'signal' && debrief.channel !== 'email') {
      throw new Error(`debrief.channel must be 'signal' or 'email', got: "${String(debrief.channel)}"`);
    }
    if (debrief.reminderDelayMinutes !== undefined && (!Number.isInteger(debrief.reminderDelayMinutes) || debrief.reminderDelayMinutes < 1)) {
      throw new Error(`debrief.reminderDelayMinutes must be a positive integer, got: ${debrief.reminderDelayMinutes}`);
    }
    if (debrief.contextBridgeTtlHours !== undefined && (!Number.isInteger(debrief.contextBridgeTtlHours) || debrief.contextBridgeTtlHours < 1)) {
      throw new Error(`debrief.contextBridgeTtlHours must be a positive integer, got: ${debrief.contextBridgeTtlHours}`);
    }
  }

  // Validate delegate if present.
  // Guard: if set to a scalar (e.g. `delegate: 90000`) optional chaining would silently
  // return undefined and the override would be dropped — fail loudly instead.
  if (config.delegate !== undefined && (typeof config.delegate !== 'object' || Array.isArray(config.delegate) || config.delegate === null)) {
    throw new Error(`delegate must be a YAML mapping, got: ${typeof config.delegate}`);
  }
  const delegateTimeoutMs = config.delegate?.defaultTimeoutMs;
  if (delegateTimeoutMs !== undefined) {
    // A zero or negative value would let every delegation time out immediately.
    if (!Number.isInteger(delegateTimeoutMs) || delegateTimeoutMs <= 0) {
      throw new Error(`delegate.defaultTimeoutMs must be a positive integer (milliseconds), got: ${delegateTimeoutMs}`);
    }
    // Node.js setTimeout silently overflows values > 2^31-1, treating them as ~0 ms.
    const NODE_MAX_TIMER_MS = 2_147_483_647;
    if (delegateTimeoutMs > NODE_MAX_TIMER_MS) {
      throw new Error(
        `delegate.defaultTimeoutMs exceeds Node.js timer limit (${NODE_MAX_TIMER_MS} ms), got: ${delegateTimeoutMs}`,
      );
    }
  }

  // Validate scheduler if present.
  // Guard: same scalar-config pitfall as delegate above.
  if (config.scheduler !== undefined && (typeof config.scheduler !== 'object' || Array.isArray(config.scheduler) || config.scheduler === null)) {
    throw new Error(`scheduler must be a YAML mapping, got: ${typeof config.scheduler}`);
  }
  const schedulerDefaultDuration = config.scheduler?.defaultExpectedDurationSeconds;
  if (schedulerDefaultDuration !== undefined && (!Number.isInteger(schedulerDefaultDuration) || schedulerDefaultDuration <= 0)) {
    // A zero or negative duration would make the watchdog immediately flag all jobs as stuck.
    throw new Error(
      `scheduler.defaultExpectedDurationSeconds must be a positive integer (seconds), got: ${schedulerDefaultDuration}`,
    );
  }

  // Validate tasks config if present.
  // Guard against non-object roots (e.g. `tasks: 60`) for the same reason as scheduler above.
  if (config.tasks !== undefined && (typeof config.tasks !== 'object' || Array.isArray(config.tasks) || config.tasks === null)) {
    throw new Error(`tasks must be a YAML mapping, got: ${typeof config.tasks}`);
  }
  if (config.tasks !== undefined) {
    const t = config.tasks;
    // A zero or negative interval would cause setInterval(fn, <=0) to fire in a tight loop.
    if (t.heartbeatIntervalMinutes !== undefined && (
      !Number.isInteger(t.heartbeatIntervalMinutes) || t.heartbeatIntervalMinutes < 1
    )) {
      throw new Error(`tasks.heartbeatIntervalMinutes must be a positive integer, got: ${String(t.heartbeatIntervalMinutes)}`);
    }
    if (t.heartbeatMaxWakesPerTick !== undefined && (
      !Number.isInteger(t.heartbeatMaxWakesPerTick) || t.heartbeatMaxWakesPerTick < 1
    )) {
      throw new Error(`tasks.heartbeatMaxWakesPerTick must be a positive integer, got: ${String(t.heartbeatMaxWakesPerTick)}`);
    }
    if (t.idleThresholdHours !== undefined && (
      !Number.isFinite(t.idleThresholdHours) || t.idleThresholdHours < 0
    )) {
      throw new Error(`tasks.idleThresholdHours must be a non-negative finite number, got: ${String(t.idleThresholdHours)}`);
    }
    if (t.staleWaitThresholdHours !== undefined && (
      !Number.isFinite(t.staleWaitThresholdHours) || t.staleWaitThresholdHours < 0
    )) {
      throw new Error(`tasks.staleWaitThresholdHours must be a non-negative finite number, got: ${String(t.staleWaitThresholdHours)}`);
    }
    if (t.resumableContinuationSeconds !== undefined && (
      !Number.isInteger(t.resumableContinuationSeconds) || t.resumableContinuationSeconds < 1
    )) {
      throw new Error(`tasks.resumableContinuationSeconds must be a positive integer, got: ${String(t.resumableContinuationSeconds)}`);
    }
    if (t.resumableCeilings !== undefined) {
      const c = t.resumableCeilings;
      if (typeof c !== 'object' || c === null || Array.isArray(c)) {
        throw new Error(`tasks.resumableCeilings must be an object, got: ${String(c)}`);
      }
      if (c.maxStalls !== undefined && (!Number.isInteger(c.maxStalls) || c.maxStalls < 1)) {
        throw new Error(`tasks.resumableCeilings.maxStalls must be a positive integer, got: ${String(c.maxStalls)}`);
      }
      if (c.maxIterations !== undefined && (!Number.isInteger(c.maxIterations) || c.maxIterations < 1)) {
        throw new Error(`tasks.resumableCeilings.maxIterations must be a positive integer, got: ${String(c.maxIterations)}`);
      }
      if (c.maxWallclockHours !== undefined && (!Number.isFinite(c.maxWallclockHours) || c.maxWallclockHours <= 0)) {
        throw new Error(`tasks.resumableCeilings.maxWallclockHours must be a positive number, got: ${String(c.maxWallclockHours)}`);
      }
      if (c.maxCostUsd !== undefined && (!Number.isFinite(c.maxCostUsd) || c.maxCostUsd <= 0)) {
        throw new Error(`tasks.resumableCeilings.maxCostUsd must be a positive number, got: ${String(c.maxCostUsd)}`);
      }
      if (c.maxPlanDepth !== undefined && (!Number.isInteger(c.maxPlanDepth) || c.maxPlanDepth < 1)) {
        throw new Error(`tasks.resumableCeilings.maxPlanDepth must be a positive integer, got: ${String(c.maxPlanDepth)}`);
      }
      if (c.maxReplansPerSubtree !== undefined && (!Number.isInteger(c.maxReplansPerSubtree) || c.maxReplansPerSubtree < 1)) {
        throw new Error(`tasks.resumableCeilings.maxReplansPerSubtree must be a positive integer, got: ${String(c.maxReplansPerSubtree)}`);
      }
      if (c.blockedStepHours !== undefined && (!Number.isFinite(c.blockedStepHours) || c.blockedStepHours <= 0)) {
        throw new Error(`tasks.resumableCeilings.blockedStepHours must be a positive number, got: ${String(c.blockedStepHours)}`);
      }
      if (c.throughputDivergenceRatio !== undefined && (
        !Number.isFinite(c.throughputDivergenceRatio) || c.throughputDivergenceRatio <= 0 || c.throughputDivergenceRatio > 1
      )) {
        throw new Error(`tasks.resumableCeilings.throughputDivergenceRatio must be in (0, 1], got: ${String(c.throughputDivergenceRatio)}`);
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
export function resolveEnvValue(value: string, context: string): string {
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

  // Validate IANA timezone before any consumer sees it — bad config should fail at
  // startup, not silently produce wrong timestamps at runtime.
  const timezone = process.env.TIMEZONE ?? 'America/Toronto';
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    throw new Error(`Invalid TIMEZONE configuration: "${timezone}" is not a recognized IANA timezone`);
  }

  return {
    databaseUrl,
    // Bootstrap/config secrets are resolved from the vault by applyVaultSecrets()
    // after the vault is constructed (#911). loadConfig() no longer reads them from
    // env — vault-only, no fallback. They are undefined here and overwritten at boot.
    anthropicApiKey: undefined,
    openaiApiKey: undefined,
    openrouterApiKey: undefined,
    logLevel: process.env.LOG_LEVEL ?? 'info',
    httpPort,
    apiToken: undefined,
    webAppBootstrapSecret: undefined,
    appOrigin: process.env.APP_ORIGIN || undefined,
    timezone,
    nylasApiKey: undefined,
    nylasGrantId: undefined,
    nylasPollingIntervalMs,
    nylasSelfEmail: '',
    ceoSignalNumber: process.env.CEO_SIGNAL_NUMBER?.trim() || undefined,
    // .trim() prevents a whitespace-only value (e.g. "  ") from activating the
    // Signal adapter with a bogus socket path or phone number.
    signalSocketPath: process.env.SIGNAL_SOCKET_PATH?.trim() || undefined,
    signalPhoneNumber: undefined,
  };
}
