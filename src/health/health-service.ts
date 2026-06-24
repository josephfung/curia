// health-service.ts — central health observability service.
//
// Responsibilities:
//   1. getStatus() — run all liveness probes and return the three-state response.
//      Called by GET /api/health. Runs every request; no cached ok state.
//   2. runCanaries() — validate external credentials and ping heartbeat URLs.
//      Called by the daily scheduler job.
//   3. start() — subscribe to bus events to maintain LlmOutcomeTracker;
//      register the daily canary job with SchedulerService.

import type { Pool } from 'pg';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { SchedulerService } from '../scheduler/scheduler-service.js';
import type { ModelRoutingConfig } from '../agents/llm/model-router.js';
import type { McpSession } from '../skills/mcp-client.js';
import type { HealthConfig } from '../config.js';
import type { LlmCallEvent, LlmErrorEvent, SkillResultEvent } from '../bus/events.js';
import type { CheckResult, HealthResponse, HealthStatus, TrackerKey, CanaryResult } from './types.js';
import { LlmOutcomeTracker } from './llm-outcome-tracker.js';
import {
  checkDb, checkBus, checkEmail, checkSignal, checkBrowser,
  checkMcpGoogleWorkspace, checkScheduler,
  type EmailAdapterHealth, type SignalRpcClientHealth, type BrowserServiceHealth,
} from './health-checks.js';
import type { NylasClient } from '../channels/email/nylas-client.js';

export interface HealthServiceDeps {
  db: Pool;
  bus: EventBus;
  logger: Logger;
  /** Only lastTickAt is accessed — avoids a hard import of the full Scheduler class. */
  scheduler: Pick<Scheduler, 'lastTickAt'>;
  /** Optional — only needed for canary job registration. Absent in test environments. */
  schedulerService?: SchedulerService;
  emailAdapter?: EmailAdapterHealth;
  /** Optional Nylas client for the daily Nylas grant canary. */
  nylasClient?: NylasClient;
  signalRpcClient?: SignalRpcClientHealth;
  browserService?: BrowserServiceHealth;
  mcpSessions: McpSession[];
  modelRoutingConfig: ModelRoutingConfig;
  config: HealthConfig;
  openaiApiKey?: string;
  tavilyApiKey?: string;
  /** Absolute path to the Google Workspace credential JSON file.
   *  Required for the google_workspace canary; absent means it is skipped. */
  googleWorkspaceConfigPath?: string;
}

export class HealthService {
  // Exposed as a private field so integration tests can reach it via
  // `(svc as unknown as { tracker: LlmOutcomeTracker }).tracker`.
  private readonly tracker = new LlmOutcomeTracker();
  private readonly startedAt = new Date();
  /** Reverse map: model string → tier, built from modelRoutingConfig in start(). */
  private modelToTier = new Map<string, TrackerKey>();

  constructor(private readonly deps: HealthServiceDeps) {}

  /**
   * Subscribe to bus events and register the daily canary job.
   * Call once at bootstrap — idempotent (subscribing twice would double-count events
   * but is otherwise safe; the job upsert is idempotent by design).
   */
  async start(): Promise<void> {
    const { bus, logger, config, schedulerService, modelRoutingConfig } = this.deps;

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

    // Track image-generate skill outcomes via skill.result events.
    bus.subscribe('skill.result', 'system', (event) => {
      try {
        const e = event as SkillResultEvent;
        if (e.payload.skillName !== 'image-generate') return;
        if (e.payload.result.success) {
          this.tracker.recordSuccess('image_gen');
        } else {
          this.tracker.recordError('image_gen');
        }
      } catch (err) {
        logger.warn({ err }, 'HealthService: unexpected error in skill.result handler');
      }
    });

    // Intercept the scheduler-fired health-canary task. The scheduler fires an
    // agent.task event targeting agentId 'health-service' — but no AgentRuntime
    // handles that agent. We subscribe at the system layer to run the canary directly.
    bus.subscribe('agent.task', 'system', (event) => {
      try {
        // Cast through unknown — only accessing known fields after the guard below
        const e = event as unknown as { payload: { agentId?: string } };
        if (e.payload.agentId !== 'health-service') return;
        void this.runCanaries().catch(err =>
          logger.error({ err }, 'Health canary run failed'),
        );
      } catch (err) {
        logger.warn({ err }, 'HealthService: unexpected error in agent.task handler');
      }
    });

    // Register the daily canary job if a SchedulerService is available.
    // Absent in test environments — graceful skip prevents startup failures in CI.
    if (!schedulerService) {
      logger.debug('HealthService: no schedulerService provided — canary job not registered');
      return;
    }

    try {
      await schedulerService.upsertDeclarativeJob(
        'health-service',   // sourceAgentId — identifies this code as the registrant
        'health-service',   // agentId — the "agent" that the scheduler fires the job for
        {
          cron: config.canarySchedule,
          task: 'health-canary',
          expectedDurationSeconds: 60,
        },
      );
      logger.info({ schedule: config.canarySchedule }, 'Health canary job registered');
    } catch (err) {
      // Non-fatal: canaries won't run on schedule, but liveness checks still work.
      logger.warn({ err }, 'Failed to register health canary job — canaries will not run on schedule');
    }
  }

  /**
   * Run all liveness probes and return the three-state response.
   * Called on every GET /api/health request — no cached ok state.
   */
  async getStatus(): Promise<HealthResponse> {
    const {
      db, bus, emailAdapter, signalRpcClient, browserService,
      mcpSessions, scheduler, config,
    } = this.deps;
    const { liveness } = config;

    // Run all async probes concurrently to keep p99 latency low.
    const [db_check, signal_check, mcp_gw] = await Promise.all([
      checkDb(db, this.deps.logger),
      checkSignal(signalRpcClient, this.deps.logger),
      checkMcpGoogleWorkspace(mcpSessions, this.deps.logger),
    ]);

    // Synchronous probes — no need to await.
    const bus_check = checkBus(bus);
    const browser_check = checkBrowser(browserService);
    const email_check = checkEmail(emailAdapter, liveness.emailStallFactor, this.startedAt);
    const scheduler_check = checkScheduler(scheduler, liveness.schedulerMaxTickS, this.startedAt);

    const checks: HealthResponse['checks'] = {
      db: db_check,
      bus: bus_check,
      signal: signal_check,
      email: email_check,
      browser: browser_check,
      mcp: { google_workspace: mcp_gw },
      scheduler: scheduler_check,
    };

    const status = this.aggregateStatus(checks);
    const uptime_s = Math.floor((Date.now() - this.startedAt.getTime()) / 1_000);

    return { status, uptime_s, checks };
  }

  /**
   * Run daily credential canaries and ping heartbeat URLs on success.
   * Called by the scheduler job handler when a 'health-canary' task fires.
   */
  async runCanaries(): Promise<CanaryResult[]> {
    const {
      logger, config, openaiApiKey, tavilyApiKey,
      nylasClient, signalRpcClient, googleWorkspaceConfigPath,
      mcpSessions, modelRoutingConfig,
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

    // Embeddings canary — skipped when OpenAI is not configured.
    await run('embeddings', async () => {
      if (!openaiApiKey) return { name: 'embeddings', status: 'skipped' };
      return this.canaryOutcome('embeddings', 'embeddings');
    });

    // Image generation canary — skipped when OpenAI is not configured.
    await run('image_gen', async () => {
      if (!openaiApiKey) return { name: 'image_gen', status: 'skipped' };
      return this.canaryOutcome('image_gen', 'image_gen');
    });

    // Nylas canary — list one message to validate the grant credential. 5-second timeout.
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

    // Signal canary — reuse the same RPC ping as the liveness check.
    await run('signal', async () => {
      if (!signalRpcClient) return { name: 'signal', status: 'skipped' };
      const result = await checkSignal(signalRpcClient, logger);
      return { name: 'signal', status: result === 'ok' ? 'ok' : 'fail' };
    });

    // Google Workspace canary — credential file readable and refresh token not expired.
    await run('google_workspace', async () => {
      const session = mcpSessions.find(s => s.serverId === 'google-workspace');
      if (!session || !googleWorkspaceConfigPath) return { name: 'google_workspace', status: 'skipped' };
      return this.canaryGoogleWorkspace(googleWorkspaceConfigPath);
    });

    // Tavily canary — key presence is sufficient; no live API call.
    await run('tavily', async () => {
      if (!tavilyApiKey) return { name: 'tavily', status: 'skipped' };
      return { name: 'tavily', status: 'ok' };
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
      checks.mcp.google_workspace,
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
   * Read the Google Workspace credential file and check whether the refresh token
   * has expired. The file is a standard OAuth2 credentials JSON with an expiry_date
   * field (epoch milliseconds).
   */
  private async canaryGoogleWorkspace(credentialPath: string): Promise<CanaryResult> {
    const { readFile } = await import('node:fs/promises');
    try {
      const raw = await readFile(credentialPath, 'utf-8');
      // Cast through unknown — runtime JSON.parse() guarantees the value is an object,
      // but we cannot know its shape statically without a full schema validator.
      const creds = JSON.parse(raw) as unknown as { expiry_date?: number };
      if (creds.expiry_date && creds.expiry_date < Date.now()) {
        return { name: 'google_workspace', status: 'fail', detail: 'refresh token expired' };
      }
      return { name: 'google_workspace', status: 'ok' };
    } catch (err) {
      return { name: 'google_workspace', status: 'fail', detail: String(err) };
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
