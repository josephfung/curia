// health-service.ts — central health observability service.
//
// Responsibilities:
//   1. getStatus() — run all liveness probes and return the three-state response.
//      Called by GET /api/health. Runs every request; no cached ok state.
//   2. runCanaries() — validate external credentials and ping heartbeat URLs.
//      Called by CanarySchedule at health.canary_schedule (#2229).
//   3. start() — subscribe to bus events to maintain LlmOutcomeTracker.

import type { Pool } from 'pg';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { ModelRoutingConfig } from '../agents/llm/model-router.js';
import type { McpSession } from '../skills/mcp-client.js';
import type { McpServerLoadStatus } from '../skills/mcp-loader.js';
import type { HealthConfig } from '../config.js';
import type { LlmCallEvent, LlmErrorEvent, ToolResultEvent } from '../bus/events.js';
import type { CheckResult, HealthResponse, HealthStatus, TrackerKey, CanaryResult } from './types.js';
import { LlmOutcomeTracker } from './llm-outcome-tracker.js';
import {
  checkDb, checkBus, checkEmail, checkSignal, checkBrowser,
  checkMcpServers, checkNylasCalendar, checkSlack, checkSms, checkVoice,
  checkSignalVoice, checkScheduler,
  type EmailAdapterHealth, type SignalRpcClientHealth, type BrowserServiceHealth,
  type SlackClientHealth, type SmsChannelHealth, type VoiceLiveKitHealth,
} from './health-checks.js';
import type { NylasClient } from '../channels/email/nylas-client.js';
import type { NylasCalendarClient } from '../channels/calendar/nylas-calendar-client.js';

export interface HealthServiceDeps {
  db: Pool;
  bus: EventBus;
  logger: Logger;
  /** Only lastTickAt is accessed — avoids a hard import of the full Scheduler class. */
  scheduler: Pick<Scheduler, 'lastTickAt'>;
  emailAdapter?: EmailAdapterHealth;
  /** Optional Nylas client for the daily Nylas email-grant canary. */
  nylasClient?: NylasClient;
  /**
   * Optional Nylas calendar client bound to `ceo_nylas_grant_id` (#1561).
   * Distinct from `nylasClient` (email/messaging grant).
   */
  nylasCalendarClient?: Pick<NylasCalendarClient, 'listCalendars'>;
  signalRpcClient?: SignalRpcClientHealth;
  /**
   * Path to the PulseAudio socket shared from the signal-cli container (#1760).
   *
   * Set ONLY when the Signal call bridge was actually constructed, so health mirrors
   * what is running: absent → `skipped` (feature off, nothing to be unhealthy about),
   * present → probed on every request. Passing the raw config value instead would
   * report `fail` on instances that merely have the env var set.
   */
  signalPulseSocketPath?: string;
  browserService?: BrowserServiceHealth;
  /**
   * Slack Socket Mode client when the Slack adapter was constructed (#1567).
   * Omit (don't pass a credential-only client) when the channel is disabled.
   */
  slackClient?: SlackClientHealth;
  /**
   * SMS readiness surface when the SMS adapter was constructed (#1567).
   * Omit when the channel is disabled / uninstalled.
   */
  smsHealth?: SmsChannelHealth;
  /**
   * LiveKit management probe when the voice adapter was constructed (#1567).
   * Must target the internal management URL, not browser signaling.
   */
  voiceLiveKit?: VoiceLiveKitHealth;
  mcpSessions: McpSession[];
  /**
   * Boot outcomes for enabled MCP servers (#1500). Absent/empty → no mcp.*
   * checks (equivalent to all skipped).
   */
  mcpServerStatuses?: ReadonlyMap<string, McpServerLoadStatus>;
  modelRoutingConfig: ModelRoutingConfig;
  config: HealthConfig;
  /** Gates the image_gen canary. */
  openaiApiKey?: string;
  /** Whether entity memory runs with an embedding service; the embeddings canary is skipped without one. */
  embeddingsEnabled?: boolean;
  /**
   * Resolves the Tavily key at canary time, vault first then `TAVILY_API_KEY`, as the
   * execution layer does for web-search (#2242). null → web-search runs keyless (#2445)
   * and the tavily canary is skipped with a "keyless mode" detail.
   */
  resolveTavilyApiKey?: () => Promise<string | null>;
  /**
   * Resolved fixed_inputs per MCP server, from loadMcpServers (#2242). The
   * google_workspace canary sends these with its live Drive call, the same way a
   * tool handler does (workspace-mcp requires `user_google_email`).
   */
  mcpFixedInputs?: ReadonlyMap<string, Readonly<Record<string, string>>>;
}

/** Tavily usage endpoint: validates the key without spending search credits. */
const TAVILY_USAGE_URL = 'https://api.tavily.com/usage';
/** Cheapest read-only workspace-mcp call that goes through Google OAuth. */
const GOOGLE_WORKSPACE_PROBE_TOOL = 'list_drive_items';
/** A stdio MCP round trip plus a Drive API call; once a day, so generous. */
const GOOGLE_WORKSPACE_PROBE_TIMEOUT_MS = 15_000;

export class HealthService {
  // Exposed as a private field so integration tests can reach it via
  // `(svc as unknown as { tracker: LlmOutcomeTracker }).tracker`.
  private readonly tracker = new LlmOutcomeTracker();
  private readonly startedAt = new Date();
  /** Reverse map: model string → tier, built from modelRoutingConfig in start(). */
  private modelToTier = new Map<string, TrackerKey>();

  constructor(private readonly deps: HealthServiceDeps) {}

  /**
   * Subscribe to bus events that feed the LLM outcome tracker.
   * Call once at bootstrap — subscribing twice would double-count events.
   * The canaries are scheduled separately, by CanarySchedule.
   */
  async start(): Promise<void> {
    const { bus, logger, modelRoutingConfig } = this.deps;

    // Build the reverse map: model string → tier key for LLM outcome tracking.
    // This lets bus event handlers look up the tier from the model name in O(1).
    for (const [tier, tc] of Object.entries(modelRoutingConfig.tiers) as [string, { model: string }][]) {
      this.modelToTier.set(tc.model, tier as TrackerKey);
    }

    // Track successful LLM calls per tier.
    bus.subscribe('llm.call', 'system', (event) => {
      try {
        const e = event as LlmCallEvent;
        const tier = this.modelToTier.get(e.payload.requestedModel);
        if (tier) this.tracker.recordSuccess(tier);
      } catch (err) {
        logger.warn({ err }, 'HealthService: unexpected error in llm.call handler');
      }
    });

    // Track failed LLM calls per tier.
    bus.subscribe('llm.error', 'system', (event) => {
      try {
        const e = event as LlmErrorEvent;
        const tier = this.modelToTier.get(e.payload.requestedModel);
        if (tier) this.tracker.recordError(tier);
      } catch (err) {
        logger.warn({ err }, 'HealthService: unexpected error in llm.error handler');
      }
    });

    // Track successful embedding calls.
    bus.subscribe('embedding.call', 'system', () => {
      try {
        this.tracker.recordSuccess('embeddings');
      } catch (err) {
        logger.warn({ err }, 'HealthService: unexpected error in embedding.call handler');
      }
    });

    // Track failed embedding calls.
    bus.subscribe('embedding.error', 'system', () => {
      try {
        this.tracker.recordError('embeddings');
      } catch (err) {
        logger.warn({ err }, 'HealthService: unexpected error in embedding.error handler');
      }
    });

    // Track image-generate skill outcomes via tool.result events.
    bus.subscribe('tool.result', 'system', (event) => {
      try {
        const e = event as ToolResultEvent;
        if (e.payload.toolName !== 'image-generate') return;
        if (e.payload.result.success) {
          this.tracker.recordSuccess('image_gen');
        } else {
          this.tracker.recordError('image_gen');
        }
      } catch (err) {
        logger.warn({ err }, 'HealthService: unexpected error in tool.result handler');
      }
    });
  }

  /**
   * Run all liveness probes and return the three-state response.
   * Called on every GET /api/health request — no cached ok state.
   */
  async getStatus(): Promise<HealthResponse> {
    const {
      db, bus, emailAdapter, signalRpcClient, browserService,
      mcpSessions, scheduler, config, nylasCalendarClient,
      slackClient, smsHealth, voiceLiveKit, signalPulseSocketPath,
    } = this.deps;
    const { liveness } = config;
    const mcpServerStatuses = this.deps.mcpServerStatuses ?? new Map();

    // Run all async probes concurrently to keep p99 latency low.
    const [
      db_check, signal_check, mcp_checks, nylas_cal, voice_check, signal_voice_check,
      // Moved out of the synchronous block in #1762: checkBrowser now round-trips to
      // Chrome instead of testing an object reference, so it must be awaited. It joins
      // the concurrent set rather than being awaited on its own — every probe here has
      // its own timeout, so the whole block stays bounded by the slowest single probe.
      browser_check,
    ] = await Promise.all([
      checkDb(db, this.deps.logger),
      checkSignal(signalRpcClient, this.deps.logger),
      checkMcpServers(mcpServerStatuses, mcpSessions, this.deps.logger),
      checkNylasCalendar(nylasCalendarClient, this.deps.logger),
      checkVoice(voiceLiveKit, this.deps.logger),
      checkSignalVoice(signalPulseSocketPath, this.deps.logger),
      checkBrowser(browserService, this.deps.logger),
    ]);

    // Synchronous probes — no need to await.
    const bus_check = checkBus(bus);
    const email_check = checkEmail(emailAdapter, liveness.emailStallFactor, this.startedAt);
    const slack_check = checkSlack(slackClient, this.startedAt);
    const sms_check = checkSms(smsHealth);
    const scheduler_check = checkScheduler(scheduler, liveness.schedulerMaxTickS, this.startedAt);

    const checks: HealthResponse['checks'] = {
      db: db_check,
      bus: bus_check,
      signal: signal_check,
      email: email_check,
      browser: browser_check,
      mcp: mcp_checks,
      nylas_calendar: nylas_cal.status,
      slack: slack_check,
      sms: sms_check,
      voice: voice_check,
      signal_voice: signal_voice_check,
      scheduler: scheduler_check,
    };

    const status = this.aggregateStatus(checks);
    const uptime_s = Math.floor((Date.now() - this.startedAt.getTime()) / 1_000);

    return { status, uptime_s, checks };
  }

  /**
   * Run daily credential canaries and ping heartbeat URLs on success.
   * Called by CanarySchedule at health.canary_schedule.
   */
  async runCanaries(): Promise<CanaryResult[]> {
    const {
      logger, config, openaiApiKey, embeddingsEnabled, resolveTavilyApiKey,
      nylasClient, nylasCalendarClient, signalRpcClient,
      mcpSessions, mcpFixedInputs, modelRoutingConfig,
    } = this.deps;
    const results: CanaryResult[] = [];

    // Wrap each canary in consistent error handling and optional heartbeat ping.
    const run = async (name: string, probe: () => Promise<CanaryResult>): Promise<void> => {
      try {
        const result = await probe();
        results.push(result);

        // Ping the heartbeat URL on success if one is configured.
        if (result.status === 'ok') {
          const url = config.heartbeats[name as keyof typeof config.heartbeats];
          if (url) await this.pingHeartbeat(url, name);
        }

        const level = result.status === 'fail' ? 'error' : 'info';
        logger[level]({ canary: name, status: result.status, detail: result.detail }, 'Health canary result');
      } catch (err) {
        // Unexpected throw from a probe — treat as a fail and log loudly.
        logger.error({ err, canary: name }, 'Canary probe threw unexpectedly');
        results.push({ name, status: 'fail', detail: String(err) });
      }
    };

    // LLM tier canaries — read from the tracker, no billed probe calls.
    for (const tier of ['fast', 'standard', 'powerful'] as const) {
      await run(`llm_${tier}`, async () => this.canaryLlmTier(tier, modelRoutingConfig));
    }

    // Embeddings canary — skipped when entity memory has no embedding service, whichever
    // endpoint (OpenAI or the operator's own) would serve it.
    await run('embeddings', async () => {
      if (!embeddingsEnabled) return { name: 'embeddings', status: 'skipped' };
      return this.canaryOutcome('embeddings', 'embeddings');
    });

    // Image generation canary — skipped when OpenAI is not configured.
    await run('image_gen', async () => {
      if (!openaiApiKey) return { name: 'image_gen', status: 'skipped' };
      return this.canaryOutcome('image_gen', 'image_gen');
    });

    // Nylas email/messaging grant canary — list one message. 5-second timeout.
    await run('nylas', async () => {
      if (!nylasClient) return { name: 'nylas', status: 'skipped' };
      try {
        await Promise.race([
          nylasClient.listMessages({ limit: 1 }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 5_000),
          ),
        ]);
        return { name: 'nylas', status: 'ok' };
      } catch (err) {
        return { name: 'nylas', status: 'fail', detail: String(err) };
      }
    });

    // Principal calendar grant canary (`ceo_nylas_grant_id`) — distinct from email (#1561).
    await run('nylas_calendar', async () => {
      if (!nylasCalendarClient) return { name: 'nylas_calendar', status: 'skipped' };
      const result = await checkNylasCalendar(nylasCalendarClient, logger);
      if (result.status === 'ok') return { name: 'nylas_calendar', status: 'ok' };
      if (result.status === 'skipped') return { name: 'nylas_calendar', status: 'skipped' };
      // Reconnecting the grant only fixes auth failures (401/403). For timeouts,
      // network errors, or 5xx, surface a neutral probe-failure detail so the
      // dashboard doesn't prescribe a reconnect that won't help (#1561 review).
      return {
        name: 'nylas_calendar',
        status: 'fail',
        detail: result.authFailure
          ? 'Principal calendar grant auth failed (401/403) — reconnect ceo_nylas_grant_id in Nylas'
          : 'Principal calendar grant probe failed (listCalendars) — check Nylas connectivity',
      };
    });

    // Signal canary — reuse the same RPC ping as the liveness check.
    await run('signal', async () => {
      if (!signalRpcClient) return { name: 'signal', status: 'skipped' };
      const result = await checkSignal(signalRpcClient, logger);
      return { name: 'signal', status: result === 'ok' ? 'ok' : 'fail' };
    });

    // Google Workspace canary — one live Drive call through the MCP session, so an
    // expired or revoked OAuth grant fails it (#2242). Also fail when the enabled
    // server is unavailable or advertises 0 tools (#1500), so Better Stack heartbeats
    // stop pinging instead of staying green.
    await run('google_workspace', async () => {
      const boot = this.deps.mcpServerStatuses?.get('google-workspace');
      if (boot?.status === 'zero_tools') {
        return { name: 'google_workspace', status: 'fail', detail: 'MCP server advertises 0 tools' };
      }
      if (boot?.status === 'unavailable') {
        return { name: 'google_workspace', status: 'fail', detail: boot.reason };
      }
      const session = mcpSessions.find(s => s.serverId === 'google-workspace');
      if (!session) return { name: 'google_workspace', status: 'skipped' };
      return this.canaryGoogleWorkspace(session, mcpFixedInputs?.get('google-workspace') ?? {});
    });

    // Tavily canary — the usage endpoint authenticates the key without spending credits.
    await run('tavily', async () => {
      const apiKey = resolveTavilyApiKey ? await resolveTavilyApiKey() : null;
      // No key: web-search runs keyless (#2445). A keyless probe would spend one of the
      // install's few free hourly searches, so report the mode instead of probing.
      if (!apiKey) return { name: 'tavily', status: 'skipped', detail: 'keyless mode (no API key set)' };
      return this.canaryTavily(apiKey);
    });

    return results;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Aggregate all probe results into the three-state overall health status.
   *
   * Rules:
   *   - db OR bus fail → 'down'   (the platform is not functional)
   *   - any other fail → 'degraded' (running but degraded)
   *   - all ok or skipped → 'ok'
   */
  private aggregateStatus(checks: HealthResponse['checks']): HealthStatus {
    if (checks.db === 'fail' || checks.bus === 'fail') return 'down';

    const nonCritical: CheckResult[] = [
      checks.signal,
      checks.email,
      checks.browser,
      ...Object.values(checks.mcp),
      checks.nylas_calendar,
      checks.slack,
      checks.sms,
      checks.voice,
      checks.signal_voice,
      checks.scheduler,
    ];
    if (nonCritical.some(c => c === 'fail')) return 'degraded';

    return 'ok';
  }

  /**
   * Canary for a single LLM tier.
   * Reads the LlmOutcomeTracker — makes NO billed probe calls.
   */
  private canaryLlmTier(
    tier: 'fast' | 'standard' | 'powerful',
    modelRoutingConfig: ModelRoutingConfig,
  ): CanaryResult {
    const name = `llm_${tier}`;

    // Verify the tier has a model configured — a missing tier means the operator
    // YAML is incomplete and we can't meaningfully assess health for this tier.
    const model = modelRoutingConfig.tiers[tier]?.model;
    if (!model) return { name, status: 'skipped' };

    return this.canaryOutcome(tier, name);
  }

  /**
   * Derive canary status from the in-memory outcome tracker.
   * Fails if the most recent recorded outcome (tracker.lastOutcome) was an error.
   */
  private canaryOutcome(key: TrackerKey, label: string): CanaryResult {
    const { lastErrorAt, lastOutcome } = this.tracker.getOutcome(key);

    // Report fail only when the most recent recorded outcome was an error. Use the explicit
    // lastOutcome discriminator rather than `lastErrorAt > lastSuccessAt`: the timestamp
    // comparison ties when both land in the same millisecond (Date is 1ms-granular), which
    // would silently report a same-ms error as healthy. lastErrorAt is non-null whenever
    // lastOutcome === 'error', so the detail timestamp is always available here.
    if (lastOutcome === 'error') {
      return { name: label, status: 'fail', detail: `last call errored at ${lastErrorAt!.toISOString()}` };
    }

    // No calls recorded yet, or the most recent outcome was a success — healthy.
    return { name: label, status: 'ok' };
  }

  /**
   * List one Drive item through the google-workspace MCP session (#2242). This goes
   * through workspace-mcp's OAuth refresh, so a revoked or expired grant fails here.
   *
   * The detail never carries the server's error text or a thrown message: either can
   * echo the fixed_inputs back, and canary detail is logged (same rule as
   * buildMcpToolHandler in mcp-loader).
   */
  private async canaryGoogleWorkspace(
    session: McpSession,
    fixedInputs: Readonly<Record<string, string>>,
  ): Promise<CanaryResult> {
    try {
      const result = await session.client.callTool(
        // page_size last: a fixed input must not widen the one-item probe.
        { name: GOOGLE_WORKSPACE_PROBE_TOOL, arguments: { ...fixedInputs, page_size: 1 } },
        undefined,
        { timeout: GOOGLE_WORKSPACE_PROBE_TIMEOUT_MS },
      );
      if (result.isError === true) {
        return { name: 'google_workspace', status: 'fail', detail: `${GOOGLE_WORKSPACE_PROBE_TOOL} returned an error result` };
      }
      return { name: 'google_workspace', status: 'ok' };
    } catch (err) {
      const errorName = err instanceof Error ? err.name : typeof err;
      return { name: 'google_workspace', status: 'fail', detail: `${GOOGLE_WORKSPACE_PROBE_TOOL} call threw ${errorName}` };
    }
  }

  /**
   * Authenticate the Tavily key against the usage endpoint (#2242). Reports the HTTP
   * status only, never the key.
   */
  private async canaryTavily(apiKey: string): Promise<CanaryResult> {
    try {
      const response = await fetch(TAVILY_USAGE_URL, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        return { name: 'tavily', status: 'fail', detail: `usage endpoint returned HTTP ${response.status}` };
      }
      return { name: 'tavily', status: 'ok' };
    } catch (err) {
      const errorName = err instanceof Error ? err.name : typeof err;
      return { name: 'tavily', status: 'fail', detail: `usage request failed (${errorName})` };
    }
  }

  /**
   * Ping a heartbeat URL with a 5-second timeout. Non-fatal — a failed ping is
   * logged at warn but never propagates (the canary result was already ok).
   */
  private async pingHeartbeat(url: string, name: string): Promise<void> {
    try {
      await Promise.race([
        fetch(url),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 5_000),
        ),
      ]);
      this.deps.logger.debug({ canary: name, url }, 'Heartbeat pinged');
    } catch (err) {
      this.deps.logger.warn({ err, canary: name, url }, 'Heartbeat ping failed (non-fatal)');
    }
  }
}
