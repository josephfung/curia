// cancellation.ts — tell a request the caller cancelled from one that failed (#1968).
//
// A voice turn aborts its in-flight stream whenever the principal barges in or hangs
// up. The SDKs surface that as an error (Anthropic's APIUserAbortError, "Request was
// aborted.", which classifyError() files as UNKNOWN), so every barge-in used to land
// in audit_log as an llm.error and log at error level. Production voice had 50 of
// them against 87 completed calls. They are not provider failures, and counting them
// as such hides the real ones.

/**
 * True when the request's own AbortSignal fired for a reason other than a timeout.
 * AbortSignal.timeout() aborts with a TimeoutError — a request that ran out of time
 * failed, so it stays an error.
 */
export function isCallerCancellation(options: Record<string, unknown> | undefined): boolean {
  const signal = options?.signal;
  if (!(signal instanceof AbortSignal) || !signal.aborted) return false;
  const reason: unknown = signal.reason;
  return !(reason instanceof Error && reason.name === 'TimeoutError');
}
