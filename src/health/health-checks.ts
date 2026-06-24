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
  /** The persistent browser context, or null when the service is stopped. */
  browserContext: { isConnected(): boolean } | null;
}

export interface McpSessionHealth {
  serverId: string;
  client: {
    /** MCP SDK Client.listTools() — a lightweight round-trip that proves the subprocess is alive. */
    listTools(): Promise<unknown>;
  };
}

// ---------------------------------------------------------------------------
// Probe implementations
// ---------------------------------------------------------------------------

/**
 * Run SELECT 1 against the database connection pool with a 2-second hard timeout.
 * Critical check — a fail drives overall status to 'down'.
 */
export async function checkDb(pool: Pool): Promise<CheckResult> {
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 2_000),
      ),
    ]);
    return 'ok';
  } catch {
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
  // Try the duck-typed listenerCount path first (test mocks and possible future
  // EventBus refactors that expose it). If absent, a non-null bus is our signal.
  const lc = (bus as unknown as { listenerCount?: (event: string) => number }).listenerCount;
  if (typeof lc === 'function') {
    // 'agent.task' is always subscribed at startup by the coordinator. Zero means
    // the bus internals have been torn down (stop() in integration tests, or a bug).
    return lc.call(bus, 'agent.task') > 0 ? 'ok' : 'fail';
  }
  // Fallback: bus is alive if it's a non-null object (best-effort).
  return bus != null ? 'ok' : 'fail';
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
  } catch {
    return 'fail';
  }
}

/**
 * Check Playwright browser context connectivity. Non-critical.
 * Synchronous — isConnected() is a sync method on BrowserContext.
 * Skipped when no service is provided (browser not configured).
 */
export function checkBrowser(service: BrowserServiceHealth | undefined): CheckResult {
  if (!service) return 'skipped';
  if (!service.browserContext) return 'fail';
  return service.browserContext.isConnected() ? 'ok' : 'fail';
}

/**
 * Check the google-workspace MCP subprocess via a tools/list call.
 * Non-critical. Skipped when the server is not in the active mcpSessions list.
 * Hard 3-second timeout.
 */
export async function checkMcpGoogleWorkspace(
  mcpSessions: McpSessionHealth[],
): Promise<CheckResult> {
  const session = mcpSessions.find(s => s.serverId === 'google-workspace');
  if (!session) return 'skipped';
  try {
    await Promise.race([
      session.client.listTools(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 3_000),
      ),
    ]);
    return 'ok';
  } catch {
    return 'fail';
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
