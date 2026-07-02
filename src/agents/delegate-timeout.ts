// delegate-timeout.ts — compute delegate wait timeout from expected duration (#1288).
//
// Specialists can exceed their nominal expected_duration_seconds (e.g. reconciliation
// runs 5–9 min against a 4–10 min hint). Add bounded headroom so the coordinator
// does not time out a healthy in-flight delegation.
//
// The wait timeout must resolve inside the delegate skill's outer execution timeout
// (skills/delegate/skill.json "timeout") so the handler can emit a structured failure
// before the execution layer kills the invocation.

/** Must stay in sync with skills/delegate/skill.json "timeout" — enforced by test. */
export const DELEGATE_SKILL_OUTER_TIMEOUT_MS = 900_000;

/** Margin below the outer skill timeout so the inner wait resolves first under load. */
export const DELEGATE_SKILL_OUTER_TIMEOUT_MARGIN_MS = 5_000;

/** Maximum extra wait beyond expected_duration_seconds. */
const DELEGATE_TIMEOUT_HEADROOM_CAP_SECONDS = 180;

/**
 * Clamp a delegate wait timeout so the handler's structured timeout fires before the
 * execution layer's outer skill timeout.
 */
export function clampDelegateWaitTimeoutMs(
  timeoutMs: number,
  outerTimeoutMs: number = DELEGATE_SKILL_OUTER_TIMEOUT_MS,
  marginMs: number = DELEGATE_SKILL_OUTER_TIMEOUT_MARGIN_MS,
): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive integer');
  }
  if (!Number.isInteger(marginMs) || marginMs <= 0 || marginMs >= outerTimeoutMs) {
    throw new RangeError('marginMs must be a positive integer less than outerTimeoutMs');
  }
  return Math.min(timeoutMs, outerTimeoutMs - marginMs);
}

/**
 * Compute delegate wait timeout in milliseconds from an expected duration in seconds.
 * Adds up to 25% headroom, capped at three minutes, then clamped below the skill outer timeout.
 */
export function computeDelegateTimeoutMs(expectedDurationSeconds: number): number {
  if (!Number.isFinite(expectedDurationSeconds) || expectedDurationSeconds <= 0) {
    throw new RangeError('expectedDurationSeconds must be a positive finite number');
  }
  const headroomSeconds = Math.min(
    Math.ceil(expectedDurationSeconds * 0.25),
    DELEGATE_TIMEOUT_HEADROOM_CAP_SECONDS,
  );
  const totalSeconds = expectedDurationSeconds + headroomSeconds;
  const timeoutMs = totalSeconds * 1000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('computed delegate timeout is not a valid positive integer');
  }
  return clampDelegateWaitTimeoutMs(timeoutMs);
}
