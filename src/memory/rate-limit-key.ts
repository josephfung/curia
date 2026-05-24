// src/memory/rate-limit-key.ts
//
// Single definition of the rate limit source key format used by both the write
// path (skills → storeFact) and the reset path (AgentRuntime.resetRateLimit).
//
// Keeping this in one place prevents the two paths from drifting apart — if
// either side constructs a different string, the counter written under one key
// is never cleaned up by the reset under a different key, silently
// re-introducing the accumulation bug this module was created to fix.

/**
 * Builds the source key used for both memory write accounting and rate limit
 * cleanup. The format encodes the (agent, task, channel) tuple so the per-task
 * 50-write budget is correctly scoped and reset after each task completes.
 *
 * @param agentId    - The agent ID running the task (e.g. "ceo-inbox")
 * @param taskId     - The task event ID (a UUID)
 * @param channelId  - The originating channel (e.g. "http", "internal"). Falls
 *                     back to "unknown" only for non-standard code paths that
 *                     don't originate from a channel task event.
 */
export function buildRateLimitSourceKey(
  agentId: string,
  taskId: string,
  channelId: string | undefined,
): string {
  return `agent:${agentId}/task:${taskId}/channel:${channelId ?? 'unknown'}`;
}
