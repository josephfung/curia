import yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

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
  // signalPhoneNumber: Nathan's E.164 number (e.g. +12223334444). This is the Signal account
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
}

/**
 * Load and parse config/default.yaml.
 *
 * @param configDir - Absolute path to the directory containing default.yaml.
 *   Pass `path.resolve(import.meta.dirname, '../config')` from index.ts.
 * @returns Parsed YAML config, or an empty object if the file is absent.
 * @throws If the file exists but cannot be parsed (YAML syntax error, permission
 *   denied, etc.) — a broken config file should cause a loud startup failure,
 *   not silently apply wrong defaults.
 */
export function loadYamlConfig(configDir: string): YamlConfig {
  const filePath = path.join(configDir, 'default.yaml');
  try {
    const parsed = yaml.load(readFileSync(filePath, 'utf-8'));

    // Empty file — treat as no config (same as absent).
    if (parsed == null) return {};

    // Root must be a mapping, not a scalar or sequence.
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('config/default.yaml must contain a YAML mapping at the root');
    }

    const config = parsed as YamlConfig;

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

    return config;
  } catch (err) {
    // File absent in test/CI environments — silently return empty config.
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    // Anything else (YAML syntax error, invalid shape, permission denied, etc.) is a
    // configuration mistake that must fail loudly rather than silently apply
    // wrong defaults. Throw so main() crashes with a readable startup error.
    throw new Error(
      `Failed to load config/default.yaml: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
