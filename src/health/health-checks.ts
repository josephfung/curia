// health-checks.ts — individual liveness probe functions for /api/health.
//
// Each function is independent, has a hard timeout for async probes, and returns
// CheckResult. 'skipped' means the service is not configured — never affects the
// overall health status. Probe-based checks (db, bus, signal, signal_voice, browser,
// mcp) run
// on every request. Time-based checks (email, scheduler) use startedAt as a
// grace-period anchor so they don't fail immediately at boot.

import { connect as netConnect } from 'node:net';
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
   *
   * Only `cookies()` is required: it is the cheapest read-only call that actually
   * crosses the process boundary into Chrome (a `Storage.getCookies` protocol
   * round-trip), which is what makes it a liveness probe rather than a reference check.
   */
  browserContext: {
    cookies(urls?: string): Promise<unknown[]>;
  } | null;
}

export interface McpSessionHealth {
  serverId: string;
  client: {
    /**
     * MCP SDK `Client.ping()` — the protocol's liveness RPC. Proves the subprocess
     * is alive with an empty-result JSON-RPC round-trip.
     *
     * Deliberately NOT `listTools()`: the SDK recompiles an Ajv validator for every
     * tool's `outputSchema` on every `listTools()` call and retains it on a shared,
     * process-lifetime Ajv instance (its cache is keyed by schema object reference,
     * and each response is freshly parsed → cache miss every time). With the Docker
     * healthcheck hitting `/api/health` every 30s, that leaked ~145 MB/hr and OOM-
     * restarted prod (#1663). `ping()` returns no schemas, so it triggers no
     * compilation. Tool discovery still uses `listTools()`, but only at boot.
     */
    ping(): Promise<unknown>;
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

/** Slack Socket Mode surface for /api/health (#1567). */
export interface SlackClientHealth {
  isStarted(): boolean;
  isSocketConnected(): boolean;
}

/**
 * SMS channel surface for /api/health (#1567).
 * Credentials are implied by adapter construction; liveness = webhook installed.
 */
export interface SmsChannelHealth {
  isWebhookInstalled(): boolean;
}

/** LiveKit management reachability for the voice channel (#1567). */
export interface VoiceLiveKitHealth {
  listRooms(): Promise<unknown[]>;
}

/** Boot grace before Slack Socket Mode's first `connected` event (#1567). */
export const SLACK_CONNECT_GRACE_MS = 60_000;

// ---------------------------------------------------------------------------
// Shared probe plumbing
// ---------------------------------------------------------------------------

/**
 * Await `work`, rejecting with `timeout` if it outlives `ms`.
 *
 * Every async probe here needs a hard bound, and each used to inline
 * `Promise.race([work, new Promise((_, reject) => setTimeout(reject, ms))])`. That
 * pattern leaks the losing timer: when `work` wins, the setTimeout stays scheduled
 * until it fires. The Docker healthcheck hits /api/health every 30s and each request
 * ran several probes, so every request left a handful of timers pending for seconds
 * (PR #1763 review). Individually harmless, but it is the same slow-accumulation shape
 * as the MCP Ajv leak that OOM-restarted prod (#1663), and clearing in `finally` costs
 * nothing.
 *
 * A rejection from `work` propagates unchanged rather than being flattened into a
 * timeout, so callers still log the real cause (ECONNREFUSED, Target closed, ...).
 *
 * The timeout does NOT cancel `work` — nothing here can. A probe that loses the race
 * is abandoned, not aborted; it settles later and is ignored.
 */
export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
    await withTimeout(pool.query('SELECT 1'), 2_000);
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
    await withTimeout(client.listGroups(), 3_000);
    return 'ok';
  } catch (err) {
    logger.warn({ err }, 'checkSignal: Signal liveness probe failed');
    return 'fail';
  }
}

/** Default budget for the browser round-trip. Local Chrome over a pipe — a healthy
 * browser answers in single-digit ms; anything near this is wedged. */
export const BROWSER_PROBE_TIMEOUT_MS = 3_000;

/**
 * Playwright/Patchright browser liveness (#1762). Non-critical.
 *
 * This used to be `service.browserContext !== null` — an object-reference existence
 * test. Chrome runs in a separate process, so holding a reference proves nothing about
 * whether that process is alive: exactly the shape that let a dead PulseAudio daemon
 * report healthy (#1760), and this subsystem has form for silent death (the stale
 * Chrome SingletonLock, #1017).
 *
 * The old comment justified the shortcut by asserting that `context.browser()` always
 * returns null for persistent contexts, so no probe was possible. That was wrong, and
 * it mattered — it is the stated reason the check was never strengthened. Production
 * disproves it: `attachDisconnectedHandler` logs "crash recovery disabled" on a null
 * `browser()`, and that warning has never appeared on an instance that logged
 * "Persistent browser context launched". A third comment, on the `browserContext`
 * getter, claimed this probe called `isConnected()`, which it never did. All three
 * claims are now reconciled by making the probe real.
 *
 * `cookies()` is used rather than `isConnected()`: the latter is synchronous cached
 * transport state, so a wedged-but-connected renderer still reports true. A bounded
 * round-trip catches both a dead process (the call rejects) and a hung one (it never
 * settles, and the timeout fires).
 *
 * Scoped to a single URL so a routine liveness check does not pull an entire real
 * browsing profile's cookie jar — session tokens included — into memory every 30s.
 */
export async function checkBrowser(
  service: BrowserServiceHealth | undefined,
  logger: Logger,
  timeoutMs: number = BROWSER_PROBE_TIMEOUT_MS,
): Promise<CheckResult> {
  if (!service) return 'skipped';
  const context = service.browserContext;
  // Null means stopped, or a crash-recovery relaunch that failed. Already definitive —
  // no probe needed, and nothing to probe.
  if (context === null) return 'fail';

  try {
    // Any well-formed URL works; nothing is expected to match. The call is the point.
    await withTimeout(context.cookies('http://127.0.0.1/'), timeoutMs);
    return 'ok';
  } catch (err) {
    logger.warn({ err }, 'checkBrowser: browser liveness probe failed');
    return 'fail';
  }
}

/**
 * Check every **enabled** MCP server that was attempted at boot (#1500).
 *
 * - Boot `zero_tools` / `unavailable` → fail (no live probe needed)
 * - Boot `ok` → live `ping()` liveness probe; fail if it errors or times out
 * - Disabled servers are absent from `serverStatuses` and never appear here
 *
 * Hard 3-second timeout per live probe. The probe is `ping()`, not `listTools()`,
 * so it triggers no MCP-SDK Ajv validator recompilation (the ~145 MB/hr leak, #1663).
 * The boot-time `zero_tools` gate above still catches servers that expose no tools.
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
        // Liveness only: a resolved ping proves the subprocess is up and answering
        // JSON-RPC. Zero-tools/unavailable servers were already failed by the boot
        // gate above, so we don't re-count tools here (and must not — see the
        // McpSessionHealth doc: listTools() leaks compiled validators, #1663).
        await withTimeout(session.client.ping(), 3_000);
        return [key, 'ok'];
      } catch (err) {
        logger.warn({ err, server: serverName }, 'checkMcpServers: MCP probe failed');
        return [key, 'fail'];
      }
    }),
  );

  return Object.fromEntries(entries);
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
    await withTimeout(calendarClient.listCalendars(), 5_000);
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
 * Slack Socket Mode connection state (#1567). Non-critical.
 * Skipped when the Slack adapter was not constructed (disabled / no credentials).
 * Allows a short boot grace before the first `connected` event; after that,
 * a disconnected socket is `fail` (Socket Mode reconnects are visible as degraded).
 *
 * Cached state rather than a round-trip, and deliberately so (#1762): the flag is
 * maintained by the Socket Mode client from real socket events, and Socket Mode runs
 * its own ping/pong underneath, so this is event-driven liveness rather than an
 * existence check. A half-open socket could still read as connected; the exposure was
 * judged small enough not to warrant an extra probe. Recorded so a later audit knows
 * this was considered rather than overlooked.
 */
export function checkSlack(
  client: SlackClientHealth | undefined,
  startedAt: Date,
  graceMs: number = SLACK_CONNECT_GRACE_MS,
): CheckResult {
  if (!client) return 'skipped';
  if (!client.isStarted()) return 'fail';
  if (client.isSocketConnected()) return 'ok';
  return Date.now() - startedAt.getTime() < graceMs ? 'ok' : 'fail';
}

/**
 * SMS (Telnyx) adapter readiness (#1567). Non-critical.
 * Skipped when the SMS adapter was not constructed.
 *
 * WHAT `ok` MEANS HERE: the inbound webhook handler is installed in this process.
 * Nothing more. It does NOT mean Telnyx can reach us, that the credentials are still
 * valid, or that the DID is still routed to this instance. Each of those can break
 * with this reporting `ok`. Read it as "the adapter started", never as end-to-end SMS
 * health (#1762).
 *
 * Why no probe, unlike its neighbours: the audit in #1762 asked whether this should
 * round-trip to Telnyx the way `voice` and `nylas_calendar` do. It should not, and the
 * reason is worth recording so the question is not reopened blind. The property that
 * actually matters here is INBOUND reachability — Telnyx delivering a webhook to us —
 * and no outbound API call can assert that. A read-only "list phone numbers" would
 * upgrade `ok` from "handler installed" to "handler installed and our credentials
 * work", while adding a third-party network dependency to a liveness endpoint hit
 * every 30s. That is a poor trade for a partial answer. An outbound send WOULD prove
 * more, and is rejected outright: a health check must never cost money or emit traffic.
 *
 * If inbound reachability needs real coverage, it belongs in a periodic canary
 * (like the Nylas grant canary), not in the synchronous liveness path.
 */
export function checkSms(health: SmsChannelHealth | undefined): CheckResult {
  if (!health) return 'skipped';
  return health.isWebhookInstalled() ? 'ok' : 'fail';
}

/**
 * Voice / LiveKit management reachability (#1567). Non-critical.
 * Skipped when the voice adapter was not constructed. Probes listRooms() against
 * the internal management URL (not the browser signaling URL). Hard 5s timeout.
 */
export async function checkVoice(
  livekit: VoiceLiveKitHealth | undefined,
  logger: Logger,
): Promise<CheckResult> {
  if (!livekit) return 'skipped';
  try {
    await withTimeout(livekit.listRooms(), 5_000);
    return 'ok';
  } catch (err) {
    logger.warn({ err }, 'checkVoice: LiveKit management probe failed');
    return 'fail';
  }
}

/** Default budget for the Signal-voice socket probe. Local Unix socket — connect is
 * either immediate or the daemon is not there. */
export const SIGNAL_VOICE_PROBE_TIMEOUT_MS = 2_000;

/**
 * Signal voice audio path liveness (#1760). Non-critical.
 *
 * Distinct from both neighbours, which is the whole point of it existing:
 *   - `signal` probes the JSON-RPC socket  → Signal MESSAGING
 *   - `voice` probes LiveKit `listRooms()` → console / WebRTC voice
 *   - this probes the shared PulseAudio socket → Signal voice CALLS
 *
 * During curia-deploy#221 the PulseAudio daemon failed to start for hours (a stale
 * pid file made it believe one was already running). Signal calls could not carry
 * audio, and `/api/health` reported everything ok because nothing covered this path.
 *
 * Probes by CONNECTING, not by stat'ing. `existsSync` / `test -S` cannot tell a live
 * daemon from a corpse: the #221 container held a socket inode written by a daemon
 * that had been dead for a week. A connect gets ECONNREFUSED against that inode and
 * succeeds only when something is actually accepting.
 *
 * No PulseAudio protocol handshake is attempted. "Something is accepting on the
 * socket the call bridge was configured to use" is the property worth asserting;
 * anything deeper couples a liveness endpoint to a wire format that is not ours.
 *
 * Known tradeoff: connecting and closing without a handshake may make PulseAudio log a
 * short-lived client on each probe, and the Docker healthcheck hits /api/health every
 * 30s. Accepted deliberately — a handshake-free connect cannot desync from a protocol
 * change, and the alternative (stat) is what let a dead daemon read as healthy. If that
 * log noise ever obscures debugging, raise the probe interval rather than weaken it
 * back to an existence check.
 *
 * `skipped` when no path is given — the Signal call bridge was not constructed, so
 * there is nothing to be unhealthy about. Matches `checkVoice`'s convention.
 */
export async function checkSignalVoice(
  pulseSocketPath: string | undefined,
  logger: Logger,
  timeoutMs: number = SIGNAL_VOICE_PROBE_TIMEOUT_MS,
): Promise<CheckResult> {
  if (!pulseSocketPath) return 'skipped';

  return new Promise<CheckResult>((resolve) => {
    // settle() guarantees exactly one resolve and exactly one destroy, whichever of
    // connect / error / timeout fires first. A probe that leaks a socket per call
    // would exhaust descriptors under the 30s Docker healthcheck — the same shape as
    // the listTools() Ajv leak that OOM-restarted prod (#1663).
    let settled = false;
    const socket = netConnect({ path: pulseSocketPath });

    const settle = (result: CheckResult, err?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (result === 'fail') {
        logger.warn({ err, pulseSocketPath }, 'checkSignalVoice: PulseAudio socket probe failed');
      }
      resolve(result);
    };

    const timer = setTimeout(() => settle('fail', new Error('timeout')), timeoutMs);
    // Do not hold the process open for a health probe.
    if (typeof timer.unref === 'function') timer.unref();

    socket.once('connect', () => settle('ok'));
    socket.once('error', (err) => settle('fail', err));
  });
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
