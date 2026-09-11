// Pure, framework-free helpers for the System page restart poll loop (#1765).
// Kept separate from SystemSettingsPage.tsx so they can be unit-tested in the
// node test environment (component .tsx files are not picked up as a first-class
// target the way these helpers are).

export const RESTART_POLL_INTERVAL_MS = 2_000;
/** Ceiling for waiting on a new process. Docker restarts are usually faster;
 *  90s covers a slow cold boot without hanging the operator forever. */
export const RESTART_TIMEOUT_MS = 90_000;

export interface SystemModelTier {
  tier: string;
  model: string;
}

export interface SystemInfo {
  version: string;
  nodeVersion: string;
  timezone: string;
  bootedAt: string;
  models: {
    defaultTier: string;
    tiers: SystemModelTier[];
  };
}

/** Runtime guard for GET /api/system — a malformed 200 must not reach state. */
export function isSystemInfo(value: unknown): value is SystemInfo {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  const models = s['models'];
  if (typeof models !== 'object' || models === null) return false;
  const m = models as Record<string, unknown>;
  return typeof s['version'] === 'string'
    && typeof s['nodeVersion'] === 'string'
    && typeof s['timezone'] === 'string'
    && typeof s['bootedAt'] === 'string'
    && typeof m['defaultTier'] === 'string'
    && Array.isArray(m['tiers'])
    && m['tiers'].every(t =>
      typeof t === 'object' && t !== null
      && typeof (t as Record<string, unknown>)['tier'] === 'string'
      && typeof (t as Record<string, unknown>)['model'] === 'string');
}

export type RestartPollFetch =
  | { kind: 'ok'; snapshot: SystemInfo }
  | { kind: 'transport_error' }
  | { kind: 'http_error'; status: number }
  | { kind: 'malformed' };

export type RestartPollDecision =
  | { kind: 'continue' }
  | { kind: 'succeeded'; snapshot: SystemInfo }
  | { kind: 'timeout' };

/**
 * Classify one GET /api/system poll. Transport errors are the caller's
 * catch-path (`kind: 'transport_error'`); this only interprets a completed fetch.
 */
export function parseSystemPollResponse(status: number, body: unknown): RestartPollFetch {
  if (status !== 200) return { kind: 'http_error', status };
  if (typeof body !== 'object' || body === null) return { kind: 'malformed' };
  const system = (body as Record<string, unknown>)['system'];
  if (!isSystemInfo(system)) return { kind: 'malformed' };
  return { kind: 'ok', snapshot: system };
}

/**
 * Decide what the restart poll loop should do after one attempt.
 *
 * A new `bootedAt` (different from the value captured before Restart was
 * pressed) is the only success signal — a 200 from the *old* process is not
 * enough. Transport / HTTP / malformed results are expected while the
 * process is down and never surface as an error; they continue until the
 * ceiling, then timeout.
 *
 * Success is checked before the ceiling so a poll that lands exactly at
 * T=timeout with a new boot time still counts as restarted.
 */
export function evaluateRestartPoll(input: {
  previousBootedAt: string;
  startedAtMs: number;
  nowMs: number;
  timeoutMs: number;
  fetch: RestartPollFetch;
}): RestartPollDecision {
  if (input.fetch.kind === 'ok' && input.fetch.snapshot.bootedAt !== input.previousBootedAt) {
    return { kind: 'succeeded', snapshot: input.fetch.snapshot };
  }
  if (input.nowMs - input.startedAtMs >= input.timeoutMs) {
    return { kind: 'timeout' };
  }
  return { kind: 'continue' };
}

export function elapsedSeconds(startedAtMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
}

/** Milliseconds left on the restart poll ceiling. 0 means the deadline has passed. */
export function restartPollRemainingMs(
  startedAtMs: number,
  nowMs: number,
  timeoutMs: number,
): number {
  return Math.max(0, timeoutMs - (nowMs - startedAtMs));
}

export function formatRestartSuccess(elapsedMs: number): string {
  const seconds = Math.max(1, Math.round(elapsedMs / 1000));
  return `Restarted, back up in ${seconds}s`;
}
