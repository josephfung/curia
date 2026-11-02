// task-handoffs.ts — tasks a specialist handed to the coordinator during its run (#2431).
//
// A specialist that cannot do a follow-up itself (meeting-debrief has no browser, no
// principal-mailbox drafts) records it as a task the coordinator owns: `task-create` with
// `target_agent_id: "coordinator"`. The runtime records those on `agent.response` as
// `handoffs`, and the delegate skill hands them to the coordinator as `handed_off_tasks`,
// so the coordinator works them in the same turn instead of waiting for a wake.
//
// Recorded per run from the run's own tool calls, so a concurrent run of the same
// specialist (a scheduled detection) never leaks its tasks into this delegation's result.

export interface TaskHandoff {
  task_id: string;
  title: string;
  /** What to do, as the specialist wrote it on the task (the principal's words, IDs, dates). */
  description?: string;
}

const COORDINATOR = 'coordinator';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The hand-off a successful tool call made, or null. Only a specialist's `task-create`
 * naming the coordinator as target counts: the coordinator's own tasks are not hand-offs.
 */
export function taskHandoffFromCall(
  agentId: string,
  toolName: string,
  input: unknown,
  resultData: unknown,
): TaskHandoff | null {
  if (agentId === COORDINATOR || toolName !== 'task-create') return null;
  const args = record(input);
  const target = args?.['target_agent_id'];
  if (typeof target !== 'string' || target.trim() !== COORDINATOR) return null;
  const data = record(resultData);
  const taskId = data?.['task_id'];
  const title = data?.['title'];
  if (typeof taskId !== 'string' || !taskId) return null;
  const description = args?.['description'];
  return {
    task_id: taskId,
    title: typeof title === 'string' ? title : '',
    ...(typeof description === 'string' && description.trim() && { description }),
  };
}

/** `agent.response.handoffs` from an untyped payload (late delivery reads it back from the bus or audit log). */
export function handoffsFromPayload(payload: Record<string, unknown>): TaskHandoff[] | undefined {
  const handoffs = payload['handoffs'];
  if (!Array.isArray(handoffs)) return undefined;
  const valid = handoffs.every((h) => {
    const r = record(h);
    return r !== undefined && typeof r['task_id'] === 'string' && typeof r['title'] === 'string'
      && (r['description'] === undefined || typeof r['description'] === 'string');
  });
  return valid ? (handoffs as TaskHandoff[]) : undefined;
}
