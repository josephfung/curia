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
import type { PrincipalMailboxes, PrincipalMailboxView } from '../principal-mailboxes/service.js';
import { MissingNylasApiKeyError } from '../principal-mailboxes/types.js';
import { grantSafeErrorFields, mayCarryGrantId } from '../principal-mailboxes/error-fields.js';
import { migrationFailureReason, type FlatMailboxMigrationOutcome } from '../principal-mailboxes/migrate-flat-mailbox.js';
import type { FlatMirrorOutcome } from '../principal-mailboxes/flat-mirror.js';
import type { PrincipalMailboxReadiness } from '../skills/types.js';
import type { MailboxOutageNotifier } from './mailbox-outage-notifier.js';

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
  /**
   * The principal mailbox registry (#2475). The canary probes every live mailbox (the
   * deferred-migration fallback included) under `principal_mailbox:<id>`. The default
   * mailbox's result also drives the `nylas_calendar` heartbeat, so a deployment's existing
   * monitor keeps pinging.
   */
  principalMailboxes?: Pick<
    PrincipalMailboxes,
    'list' | 'credentials' | 'gatewayClient' | 'calendarClient' | 'isFallbackActive' | 'setFallback'
    | 'pendingMigrationReason' | 'setPendingMigrationReason'
  >;
  /**
   * The grant calendar was bound to at boot, or null when none was. It picks up a different default grant only after a restart, which the setup catalog
   * reports as `restart_required`. Absent: no restart check.
   */
  calendarBoundGrant?: () => string | null;
  /** Alerts the principal once per mailbox outage episode. */
  mailboxOutageNotifier?: Pick<MailboxOutageNotifier, 'record'>;
  /**
   * Re-runs the boot migration of the flat mailbox. Called on the canary tick while the
   * deferred-migration fallback is active; on 'migrated' the fallback is cleared.
   */
  retryMailboxMigration?: () => Promise<FlatMailboxMigrationOutcome>;
  /** Re-derives the flat principal-mailbox keys from the registry's default (R28); run on
   *  each canary tick so a copy that failed part-way is repaired. */
  reconcileFlatMailboxKeys?: () => Promise<FlatMirrorOutcome>;
  /** The inbox triage heartbeat's health (R67), read on every request. Absent, or null (the
   *  heartbeat is not running): skipped. */
  inboxTriageHealth?: () => { ok: boolean; detail?: string } | null;
}

/** Tavily usage endpoint: validates the key without spending search credits. */
const TAVILY_USAGE_URL = 'https://api.tavily.com/usage';
/** Cheapest read-only workspace-mcp call that goes through Google OAuth. */
const GOOGLE_WORKSPACE_PROBE_TOOL = 'list_drive_items';
/** A stdio MCP round trip plus a Drive API call; once a day, so generous. */
const GOOGLE_WORKSPACE_PROBE_TIMEOUT_MS = 15_000;
/** Per-mailbox canary: grant lookup, one message and the calendar list, together. */
const MAILBOX_PROBE_TIMEOUT_MS = 5_000;
/** Reading the mailbox registry before the per-mailbox canaries. */
const MAILBOX_REGISTRY_TIMEOUT_MS = 5_000;
/** The deferred-migration retry: a registry read, a Nylas grant lookup and two writes. */
const MAILBOX_MIGRATION_RETRY_TIMEOUT_MS = 15_000;
/** The heartbeat a deployment already configured for the single principal calendar check. */
const DEFAULT_MAILBOX_HEARTBEAT = 'nylas_calendar';

export class HealthService {
  // Exposed as a private field so integration tests can reach it via
  // `(svc as unknown as { tracker: LlmOutcomeTracker }).tracker`.
  private readonly tracker = new LlmOutcomeTracker();
  private readonly startedAt = new Date();
  /** Reverse map: model string → tier, built from modelRoutingConfig in start(). */
  private modelToTier = new Map<string, TrackerKey>();
  /** Last canary outcome per live mailbox id and the grant it probed (#2475); feeds the setup
   *  catalog's readiness check. Held in memory only, never logged. */
  private readonly mailboxOk = new Map<string, { ok: boolean; grantId: string | null }>();
  /** Last logged outcome of the deferred-migration retry, so a repeat is not logged again. */
  private lastMigrationOutcome: string | null = null;
  /** The flat-key repair started by the last canary run, while it is still running. */
  private flatMirrorInFlight: Promise<void> | null = null;
  /** The deferred-migration retry still running, if one outlived its canary deadline. */
  private migrationRetryInFlight: Promise<void> | null = null;
  /** Mailboxes whose outage notice is still being sent: not sent again meanwhile. */
  private readonly notifying = new Set<string>();
  /** What the last finished flat-key repair found, reported as a canary on the next run. */
  private lastFlatMirror: { outcome: FlatMirrorOutcome } | { error: string } | null = null;

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
      principal_mailbox_triage: this.inboxTriageCheck(),
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
      nylasClient, signalRpcClient,
      mcpSessions, mcpFixedInputs, modelRoutingConfig,
    } = this.deps;
    const results: CanaryResult[] = [];

    // Wrap each canary in consistent error handling and optional heartbeat ping.
    // `heartbeatKey` names the configured heartbeat when it differs from the canary's name.
    const run = async (name: string, probe: () => Promise<CanaryResult>, heartbeatKey?: string): Promise<void> => {
      try {
        const result = await probe();
        results.push(result);

        // Ping the heartbeat URL on success if one is configured.
        if (result.status === 'ok') {
          const url = config.heartbeats[(heartbeatKey ?? name) as keyof typeof config.heartbeats];
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

    // Principal mailbox canaries (#2475): one per live mailbox, replacing the single
    // `nylas_calendar` check. First retry a deferred boot migration, so a mailbox that could
    // not be registered at boot is picked up here without a restart.
    // Each mailbox step is bounded or runs beside the canaries, so a stalled registry or vault
    // read cannot hold the Signal, Google Workspace and Tavily canaries after it. (A stalled
    // query keeps its connection until Postgres ends it; only the canary stops waiting.)
    try {
      await withDeadline(this.retryDeferredMigration(), MAILBOX_MIGRATION_RETRY_TIMEOUT_MS);
    } catch (err) {
      logger.warn({ errName: err instanceof Error ? err.name : 'unknown' }, 'Mailbox migration retry did not finish in time; the canaries go on');
    }
    await this.reportPendingMigration(results);
    // Not awaited: a stalled repair must never hold the canaries (one run at a time). The last
    // finished run's problem, if any, is reported here.
    this.startFlatMirrorReconcile();
    this.reportFlatMirror(results);
    await this.runMailboxCanaries(run, results);

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
   * The setup catalog's `principal_mailbox_ready` check. A mailbox not probed yet, whose last
   * probe was not ok, or whose grant changed since it passed (a replaced grant must pass on its
   * own) is probed now rather than reported from a stale result. `restart_required` when the
   * default mailbox passed but calendar is bound to another grant (or none) since boot.
   */
  async principalMailboxReady(): Promise<PrincipalMailboxReadiness> {
    const { principalMailboxes, calendarBoundGrant, logger } = this.deps;
    if (!principalMailboxes) return 'pending';
    try {
      const live = await withDeadline(principalMailboxes.list(), MAILBOX_REGISTRY_TIMEOUT_MS);
      for (const view of live) {
        const last = this.mailboxOk.get(view.id);
        // On demand, for setup-status: no outage email from here, only the scheduled canary sends one.
        if (last?.ok !== true || last.grantId !== (await this.currentGrant(view.id))) await this.probeMailbox(view, { notify: false });
      }
      // Every mailbox was removed after boot: calendar still holds the removed default's grant.
      if (live.length === 0) return calendarBoundGrant?.() ? 'restart_required' : 'pending';
      const passed = live.filter((m) => this.mailboxOk.get(m.id)?.ok === true);
      if (passed.length === 0) return 'pending';
      const def = passed.find((m) => m.isDefault);
      if (def && calendarBoundGrant && calendarBoundGrant() !== this.mailboxOk.get(def.id)?.grantId) {
        return 'restart_required';
      }
      return 'ready';
    } catch (err) {
      logger.warn({ err }, 'principalMailboxReady: could not evaluate mailbox health; reporting not ready');
      return 'pending';
    }
  }

  /** The mailbox's grant now, or null when it cannot be read (the probe then reports why). */
  private async currentGrant(id: string): Promise<string | null> {
    try {
      return (await this.deps.principalMailboxes!.credentials(id)).grantId;
    } catch (err) {
      // Class and status only: a Nylas error can carry the grant id (R20).
      this.deps.logger.debug({ mailboxId: id, ...grantSafeErrorFields(err) }, 'principalMailboxReady: could not read the mailbox grant; probing it');
      return null;
    }
  }

  /**
   * Starts the flat-key repair beside the canaries, never in their path: a stalled database
   * call there cannot delay or skip a canary. A run still in flight is not started again.
   */
  private startFlatMirrorReconcile(): void {
    const { reconcileFlatMailboxKeys, logger } = this.deps;
    if (!reconcileFlatMailboxKeys || this.flatMirrorInFlight) return;
    this.flatMirrorInFlight = (async () => {
      try {
        this.lastFlatMirror = { outcome: await reconcileFlatMailboxKeys() };
      } catch (err) {
        const { errName } = grantSafeErrorFields(err);
        this.lastFlatMirror = { error: errName };
        logger.error(safeErrLogFields(err), 'Could not reconcile the flat principal-mailbox keys with the registry');
      } finally {
        this.flatMirrorInFlight = null;
      }
    })();
  }

  /** A failed or `no_grant` flat-key repair is a failing check, not only a log line. */
  private reportFlatMirror(results: CanaryResult[]): void {
    const last = this.lastFlatMirror;
    if (!last) return;
    if ('error' in last) {
      results.push({ name: 'principal_mailbox_flat_mirror', status: 'fail', detail: `Could not reconcile the flat mailbox settings with the registry (${last.error})` });
    } else if (last.outcome === 'no_grant') {
      results.push({ name: 'principal_mailbox_flat_mirror', status: 'fail', detail: 'The default principal mailbox has no grant in the vault; use Replace grant on it in the console' });
    }
  }

  /** While the flat mailbox is served as a fallback, say so and why, instead of looking healthy. */
  private async reportPendingMigration(results: CanaryResult[]): Promise<void> {
    const { principalMailboxes, logger } = this.deps;
    if (!principalMailboxes) return;
    try {
      if (!(await withDeadline(principalMailboxes.isFallbackActive(), MAILBOX_REGISTRY_TIMEOUT_MS))) return;
    } catch (err) {
      logger.warn(safeErrLogFields(err), 'Could not tell whether the mailbox fallback is active');
      return;
    }
    const reason = principalMailboxes.pendingMigrationReason();
    results.push({
      name: 'principal_mailbox_migration',
      status: 'fail',
      detail: `The principal mailbox is not in the registry yet and is served from the flat settings${reason ? `: ${reason}` : ''}`,
    });
  }

  /** One retry at a time: a run that outlived its deadline is joined, never run beside. */
  private retryDeferredMigration(): Promise<void> {
    this.migrationRetryInFlight ??= this.runMigrationRetry().finally(() => {
      this.migrationRetryInFlight = null;
    });
    return this.migrationRetryInFlight;
  }

  private async runMigrationRetry(): Promise<void> {
    const { principalMailboxes, retryMailboxMigration, logger } = this.deps;
    if (!principalMailboxes || !retryMailboxMigration) return;
    let outcome: string;
    try {
      if (!(await principalMailboxes.isFallbackActive())) return;
      const result = await retryMailboxMigration();
      if (result === 'migrated') principalMailboxes.setFallback(null);
      outcome = result;
    } catch (err) {
      outcome = 'error';
      principalMailboxes.setPendingMigrationReason(migrationFailureReason(err));
      if (this.lastMigrationOutcome !== outcome) {
        logger.warn(safeErrLogFields(err), 'Mailbox migration retry failed; still serving the flat grant');
      }
      this.lastMigrationOutcome = outcome;
      return;
    }
    if (this.lastMigrationOutcome !== outcome) {
      logger.info({ outcome }, 'Mailbox migration retry outcome');
    }
    this.lastMigrationOutcome = outcome;
  }

  private async runMailboxCanaries(
    run: (name: string, probe: () => Promise<CanaryResult>, heartbeatKey?: string) => Promise<void>,
    results: CanaryResult[],
  ): Promise<void> {
    const { principalMailboxes, logger } = this.deps;
    if (!principalMailboxes) return;
    let live: PrincipalMailboxView[];
    try {
      live = await withDeadline(principalMailboxes.list(), MAILBOX_REGISTRY_TIMEOUT_MS);
    } catch (err) {
      logger.error({ err }, 'Principal mailbox canary could not list the registry');
      results.push({ name: 'principal_mailboxes', status: 'fail', detail: 'Could not read the principal mailbox registry' });
      return;
    }
    // Forget mailboxes that were removed since the last run.
    for (const id of [...this.mailboxOk.keys()]) {
      if (!live.some((m) => m.id === id)) this.mailboxOk.delete(id);
    }
    for (const view of live) {
      await run(
        `principal_mailbox:${view.id}`,
        () => this.probeMailbox(view),
        view.isDefault ? DEFAULT_MAILBOX_HEARTBEAT : undefined,
      );
    }
  }

  /**
   * Grant lookup + one message + calendar list, together, under one deadline. The detail
   * names the mailbox by label only and never carries the error text: a Nylas error can
   * echo the grant id.
   */
  private async probeMailbox(view: PrincipalMailboxView, opts: { notify?: boolean } = {}): Promise<CanaryResult> {
    const { principalMailboxes, mailboxOutageNotifier, calendarBoundGrant, logger } = this.deps;
    const name = `principal_mailbox:${view.id}`;
    let result: CanaryResult;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let grantId: string | null = null;
    let authFailure = false;
    try {
      // The deadline covers reading the credentials and building the clients too, so a slow
      // registry or vault read cannot hold the canary (or setup-status) past it.
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error(`timed out after ${MAILBOX_PROBE_TIMEOUT_MS}ms`), { name: 'TimeoutError' })),
          MAILBOX_PROBE_TIMEOUT_MS,
        );
      });
      await Promise.race([
        (async () => {
          grantId = (await principalMailboxes!.credentials(view.id)).grantId;
          const [client, calendar] = await Promise.all([
            principalMailboxes!.gatewayClient(view.id),
            principalMailboxes!.calendarClient(view.id),
          ]);
          await Promise.all([client.getGrant(), client.listMessages({ limit: 1 }), calendar.listCalendars()]);
        })(),
        deadline,
      ]);
      result = { name, status: 'ok' };
    } catch (err) {
      if (err instanceof MissingNylasApiKeyError) {
        // Nylas is not configured at all: nothing to be unhealthy about, and no outage to
        // alert on (as the old nylas_calendar canary reported it).
        this.mailboxOk.set(view.id, { ok: false, grantId });
        return { name, status: 'skipped', detail: 'No Nylas API key configured' };
      }
      const { errName, statusCode: code } = grantSafeErrorFields(err);
      authFailure = code === 401 || code === 403;
      logger.warn({ mailboxId: view.id, errorName: errName, statusCode: code }, 'Principal mailbox probe failed');
      // Reconnecting only fixes auth failures (401/403); don't prescribe it for timeouts or 5xx.
      result = {
        name,
        status: 'fail',
        detail: authFailure
          ? `Mailbox "${view.label}" grant auth failed (401/403) — reconnect it in Nylas, then use Replace grant on it in the console (Channels → Email → Principal's mailboxes)`
          : errName === 'TimeoutError'
            ? `Mailbox "${view.label}" probe timed out after ${MAILBOX_PROBE_TIMEOUT_MS / 1000} s — check Nylas connectivity`
            : `Mailbox "${view.label}" probe failed (${errName}) — check Nylas connectivity`,
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    this.mailboxOk.set(view.id, { ok: result.status === 'ok', grantId });
    // The mailbox answers, but calendar is still bound to another
    // grant, or none, since boot: not healthy for them until a restart. No heartbeat ping (the
    // result is not ok) and no outage episode either way: the mailbox itself is fine.
    if (result.status === 'ok' && view.isDefault && calendarBoundGrant && calendarBoundGrant() !== grantId) {
      return {
        name,
        status: 'fail',
        detail: `Mailbox "${view.label}" answers, but calendar still uses the grant from boot — restart Curia`,
      };
    }
    // Not awaited: a stalled notice delivery must not hold the canary run. One per mailbox at a
    // time; the notifier keeps its own retry state for the next failing probe.
    if (mailboxOutageNotifier && opts.notify !== false && !this.notifying.has(view.id)) {
      this.notifying.add(view.id);
      void (async () => {
        try {
          await mailboxOutageNotifier.record(view.id, view.label, result.status === 'ok', { authFailure });
        } catch (err) {
          logger.error({ err, mailboxId: view.id }, 'Mailbox outage notifier threw');
        } finally {
          this.notifying.delete(view.id);
        }
      })();
    }
    return result;
  }

  /**
   * Aggregate all probe results into the three-state overall health status.
   *
   * Rules:
   *   - db OR bus fail → 'down'   (the platform is not functional)
   *   - any other fail → 'degraded' (running but degraded)
   *   - all ok or skipped → 'ok'
   */
  /** principal_mailbox_triage: the heartbeat's own verdict; a failure is logged with its reason. */
  private inboxTriageCheck(): CheckResult {
    const probe = this.deps.inboxTriageHealth;
    if (!probe) return 'skipped';
    try {
      const h = probe();
      if (h === null) return 'skipped';
      if (h.ok) return 'ok';
      this.deps.logger.debug({ check: 'principal_mailbox_triage', detail: h.detail }, 'Health: inbox triage is failing');
      return 'fail';
    } catch (err) {
      this.deps.logger.error({ err }, 'Health: the inbox triage check threw');
      return 'fail';
    }
  }

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
      checks.principal_mailbox_triage,
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

/** `work`, or a rejection once `ms` have passed. Stops the wait only; the work itself runs on. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`timed out after ${ms}ms`), { name: 'TimeoutError' })), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Class and status, plus the message when the error cannot carry a grant id (R20). */
function safeErrLogFields(err: unknown): Record<string, unknown> {
  return err instanceof Error && !mayCarryGrantId(err)
    ? { ...grantSafeErrorFields(err), errMessage: err.message }
    : { ...grantSafeErrorFields(err) };
}
