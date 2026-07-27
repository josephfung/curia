// health-checks.ts — individual liveness probe functions for /api/health.
//
// Each function is independent, has a hard timeout for async probes, and returns
// CheckResult. 'skipped' means the service is not configured — never affects the
// overall health status. Probe-based checks (db, bus, signal, browser, mcp) run
// on every request. Time-based checks (email, scheduler) use startedAt as a
// grace-period anchor so they don't fail immediately at boot.

import type { Pool } from 'pg';
import type { EventBus } from '../bus/bus.js';
import type { CheckResult } from './types.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { Logger } from '../logger.js';

// -- Structural health interfaces --
// Using structural typing avoids hard import dependencies on concrete service
// classes, which would pull in their full dependency graphs. The health module
// only needs the specific fields/methods it probes — nothing more.

export interface EmailAdapterHealth {
  /** Date of the most recent successful poll, or null if none has completed. */
  lastSuccessfulPollAt: Date | null;
  /** Polling interval in ms — used to compute the stall threshold. */
  pollingIntervalMs: number;
}

export interface SignalRpcClientHealth {
  listGroups(): Promise<unknown[]>;
}

export interface BrowserServiceHealth {
  /**
   * The persistent browser context, or null when the service is stopped.
   * BrowserService uses launchPersistentContext — context.browser() always returns
   * null for these contexts (Playwright behavior, not an error). Liveness is
   * checked by whether the context object exists: stop() sets it to null.
   */
  browserContext: object | null;
}

export interface McpSessionHealth {
  serverId: string;
  client: {
    /** MCP SDK Client.listTools() — a lightweight round-trip that proves the subprocess is alive. */
    listTools(): Promise<{ tools?: unknown[] }>;
  };
}

/** Boot-time MCP load outcome (mirrors McpServerLoadStatus in mcp-loader). */
export type McpServerBootStatus =
  | { status: 'ok'; toolCount: number }
  | { status: 'zero_tools' }
  | { status: 'unavailable'; reason: string };

/** Health check key for an MCP server name (`google-workspace` → `google_workspace`). */
export function mcpHealthKey(serverName: string): string {
  return serverName.replace(/-/g, '_');
}

export interface NylasCalendarClientHealth {
  listCalendars(): Promise<unknown[]>;
}

// ---------------------------------------------------------------------------
// Probe implementations
// ---------------------------------------------------------------------------

/**
 * Run SELECT 1 against the database connection pool with a 2-second hard timeout.
 * Critical check — a fail drives overall status to 'down'.
 */
export async function checkDb(pool: Pool, logger: Logger): Promise<CheckResult> {
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 2_000),
      ),
    ]);
    return 'ok';
  } catch (err) {
    logger.warn({ err }, 'checkDb: DB liveness probe failed');
    return 'fail';
  }
}

/**
 * Verify the event bus has active listeners, meaning it has not been torn down.
 * Synchronous — no timeout needed.
 *
 * EventBus uses its own custom subscriber Map rather than a Node.js EventEmitter,
 * so there is no native listenerCount(). This check casts to a duck type: when a
 * test mock or future refactor exposes listenerCount(), we use it; otherwise we fall
 * back to confirming the bus object is non-null (best-effort — a live bus is always
 * non-null in a healthy process).
 */
export function checkBus(bus: EventBus): CheckResult {
  // Null guard first — if bus is null/undefined (e.g. fallback HealthService in tests),
  // dereferencing it below would throw a TypeError before we can return 'fail'.
  if (bus === null || bus === undefined) return 'fail';
  // Try the duck-typed listenerCount path first (test mocks and possible future
  // EventBus refactors that expose it). If absent, a non-null bus is our signal.
  const lc = (bus as unknown as { listenerCount?: (event: string) => number }).listenerCount;
  if (typeof lc === 'function') {
    // 'agent.task' is always subscribed at startup by the coordinator. Zero means
    // the bus internals have been torn down (stop() in integration tests, or a bug).
    return lc.call(bus, 'agent.task') > 0 ? 'ok' : 'fail';
  }
  // Fallback: bus is alive if it's a non-null object (best-effort — EventBus
  // does not expose listenerCount; follow-up: add subscriberCount() to EventBus).
  return 'ok';
}

/**
 * Check email adapter stall state. Non-critical.
 *
 * Boot-correct: within the grace window (emailStallFactor × pollingIntervalMs from
 * startedAt), a null lastSuccessfulPollAt is acceptable — the first poll may not have
 * completed yet. Outside the grace window, a null value is a stall.
 *
 * @param adapter      The email adapter to probe, or undefined when not configured.
 * @param emailStallFactor  Multiplier on pollingIntervalMs to derive the stall threshold.
 * @param startedAt    When the process started — used as the grace period anchor.
 */
export function checkEmail(
  adapter: EmailAdapterHealth | undefined,
  emailStallFactor: number,
  startedAt: Date,
): CheckResult {
  if (!adapter) return 'skipped';

  const { lastSuccessfulPollAt, pollingIntervalMs } = adapter;
  const now = Date.now();
  const graceMs = emailStallFactor * pollingIntervalMs;

  if (lastSuccessfulPollAt === null) {
    // Still within the startup grace window — no successful poll yet is expected.
    return now - startedAt.getTime() < graceMs ? 'ok' : 'fail';
  }
  return now - lastSuccessfulPollAt.getTime() < graceMs ? 'ok' : 'fail';
}

/**
 * Check Signal RPC socket connectivity via a lightweight listGroups() call.
 * Non-critical. Skipped when no client is provided (Signal not configured).
 * Hard 3-second timeout.
 */
export async function checkSignal(
  client: SignalRpcClientHealth | undefined,
  logger: Logger,
): Promise<CheckResult> {
  if (!client) return 'skipped';
  try {
    await Promise.race([
      client.listGroups(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 3_000),
      ),
    ]);
    return 'ok';
  } catch (err) {
    logger.warn({ err }, 'checkSignal: Signal liveness probe failed');
    return 'fail';
  }
}

/**
 * Check Playwright browser context liveness. Non-critical.
 * Synchronous — liveness is determined by whether the context object exists.
 * Skipped when no service is provided (browser not configured).
 */
export function checkBrowser(service: BrowserServiceHealth | undefined): CheckResult {
  if (!service) return 'skipped';
  // BrowserService uses launchPersistentContext: context.browser() always returns null
  // for persistent contexts (it's not an error). Liveness = context object exists;
  // BrowserService sets context to null on stop() and during failed relaunch.
  return service.browserContext !== null ? 'ok' : 'fail';
}

/**
 * Check every **enabled** MCP server that was attempted at boot (#1500).
 *
 * - Boot `zero_tools` / `unavailable` → fail (no live probe needed)
 * - Boot `ok` → live tools/list; fail if the call errors or returns 0 tools
 * - Disabled servers are absent from `serverStatuses` and never appear here
 *
 * Hard 3-second timeout per live probe.
 */
export async function checkMcpServers(
  serverStatuses: ReadonlyMap<string, McpServerBootStatus>,
  mcpSessions: McpSessionHealth[],
  logger: Logger,
): Promise<Record<string, CheckResult>> {
  // Probe every server concurrently: a liveness endpoint must stay bounded, not
  // scale at ~3s × server count when several servers stall (each probe already has
  // its own 3s cap, so the whole check is ~3s regardless of how many stall). Assemble
  // the record from the resolved outcomes, preserving serverStatuses order.
  const entries = await Promise.all(
    [...serverStatuses].map(async ([serverName, boot]): Promise<[string, CheckResult]> => {
      const key = mcpHealthKey(serverName);
      if (boot.status === 'zero_tools' || boot.status === 'unavailable') {
        return [key, 'fail'];
      }

      const session = mcpSessions.find((s) => s.serverId === serverName);
      if (!session) {
        // Boot said ok but session is gone — treat as fail.
        return [key, 'fail'];
      }

      try {
        const toolList = await Promise.race([
          session.client.listTools(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 3_000),
          ),
        ]);
        const count = toolList.tools?.length ?? 0;
        return [key, count > 0 ? 'ok' : 'fail'];
      } catch (err) {
        logger.warn({ err, server: serverName }, 'checkMcpServers: MCP probe failed');
        return [key, 'fail'];
      }
    }),
  );

  return Object.fromEntries(entries);
}

/**
 * @deprecated Prefer checkMcpServers. Kept as a thin wrapper for callers that
 * only care about google-workspace until they migrate.
 */
export async function checkMcpGoogleWorkspace(
  mcpSessions: McpSessionHealth[],
  logger: Logger,
): Promise<CheckResult> {
  const session = mcpSessions.find(s => s.serverId === 'google-workspace');
  if (!session) return 'skipped';
  try {
    const toolList = await Promise.race([
      session.client.listTools(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 3_000),
      ),
    ]);
    return (toolList.tools?.length ?? 0) > 0 ? 'ok' : 'fail';
  } catch (err) {
    logger.warn({ err }, 'checkMcpGoogleWorkspace: MCP probe failed');
    return 'fail';
  }
}

/** Outcome of the principal calendar grant probe, distinguishing auth failures. */
export interface NylasCalendarProbe {
  status: CheckResult;
  /** True only for a Nylas auth failure (401/403) — the sole case a grant reconnect resolves. */
  authFailure: boolean;
}

/**
 * Probe the principal calendar grant (`ceo_nylas_grant_id`) via listCalendars (#1561).
 * Distinct from the email/messaging `nylas` canary. Skipped when no calendar client.
 * Hard 5-second timeout. Classifies auth failures (401/403) so callers can offer
 * grant-reconnect guidance only when it would actually help — a timeout or 5xx is not
 * a grant problem.
 */
export async function checkNylasCalendar(
  calendarClient: NylasCalendarClientHealth | undefined,
  logger: Logger,
): Promise<NylasCalendarProbe> {
  if (!calendarClient) return { status: 'skipped', authFailure: false };
  try {
    await Promise.race([
      calendarClient.listCalendars(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 5_000),
      ),
    ]);
    return { status: 'ok', authFailure: false };
  } catch (err) {
    logger.warn({ err }, 'checkNylasCalendar: calendar grant probe failed');
    // Nylas SDK surfaces HTTP status on `statusCode` (see isNylasAuthFailure in the
    // calendar-list-events handler); 401/403 mean the grant itself is bad.
    const code = typeof err === 'object' && err !== null
      ? (err as { statusCode?: unknown }).statusCode
      : undefined;
    return { status: 'fail', authFailure: code === 401 || code === 403 };
  }
}

/**
 * Check scheduler watchdog liveness. Non-critical.
 *
 * Boot-correct: within the grace window (schedulerMaxTickS seconds from startedAt),
 * a null lastTickAt is acceptable — the scheduler may not have fired its first tick yet.
 *
 * @param scheduler          The scheduler to probe (only lastTickAt is accessed).
 * @param schedulerMaxTickS  Grace window in seconds — should exceed the scheduler poll interval.
 * @param startedAt          When the process started — used as the grace period anchor.
 */
export function checkScheduler(
  scheduler: Pick<Scheduler, 'lastTickAt'>,
  schedulerMaxTickS: number,
  startedAt: Date,
): CheckResult {
  const now = Date.now();
  const graceMs = schedulerMaxTickS * 1_000;

  if (scheduler.lastTickAt === null) {
    return now - startedAt.getTime() < graceMs ? 'ok' : 'fail';
  }
  return now - scheduler.lastTickAt.getTime() < graceMs ? 'ok' : 'fail';
}
