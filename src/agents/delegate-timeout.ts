// delegate-timeout.ts — compute delegate wait timeout from expected duration (#1288).
//
// Specialists can exceed their nominal expected_duration_seconds (e.g. reconciliation
// runs 5–9 min against a 4–10 min hint). Add bounded headroom so the coordinator
// does not time out a healthy in-flight delegation.

/** Maximum extra wait beyond expected_duration_seconds. */
const DELEGATE_TIMEOUT_HEADROOM_CAP_SECONDS = 180;

/**
 * Compute delegate wait timeout in milliseconds from an expected duration in seconds.
 * Adds up to 25% headroom, capped at three minutes.
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
  return timeoutMs;
}
