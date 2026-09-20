/**
 * Parse `scheduler:<jobUuid>:<runId>` conversation IDs used for runnable scheduled
 * job turns. The middle segment must be a UUID v1–v5 — 2-part IDs
 * (`scheduler:<jobId>`) are coordinator notification events (drift, suspension),
 * not runnable tasks, and non-UUID middles are rejected.
 *
 * Shared by scheduler-report (derive job_id) and bullpen (detect job-UUID-as-thread_id).
 * See #1828.
 */

const SCHEDULER_RUN_CONVERSATION =
  /^scheduler:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}):[^:]+$/;

/** Extract the job UUID from a scheduled-run conversation id, or undefined. */
export function parseSchedulerRunJobId(conversationId: string | undefined): string | undefined {
  if (!conversationId) return undefined;
  return SCHEDULER_RUN_CONVERSATION.exec(conversationId)?.[1];
}
