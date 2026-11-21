// notify-operator.ts — placeholder for telling the operator about onboarding trouble (#2360).

import type { TaskRepo } from '../db/task-repo.js';
import type { Logger } from '../logger.js';

export const OPERATOR_EVENTS = [
  'greeting_unanswered',
  'invitation_expired',
  'web_search_failed',
  'mailbox_signin_blocked',
] as const;
export type OperatorEvent = (typeof OPERATOR_EVENTS)[number];

export type NotifyOperatorDeps = {
  taskRepo: Pick<TaskRepo, 'updateTask'>;
  logger: Logger;
  audit?: (e: Record<string, unknown>) => void;
};

/**
 * Record an operator notice on the onboarding task. Never throws. Returns whether the notice was
 * recorded (the task's progress note written); a failed write is logged and returns false. The
 * audit call is best-effort: once the note is written the notice counts as recorded.
 */
export async function notifyOperator(
  deps: NotifyOperatorDeps,
  taskId: string,
  event: OperatorEvent,
  details?: Record<string, unknown>,
): Promise<boolean> {
  // TODO(#2365): deliver to the operator once the operator role exists.
  try {
    await deps.taskRepo.updateTask(taskId, { progressNote: `Operator notice: ${event}` });
  } catch (err) {
    deps.logger.error({ err, taskId, event }, 'onboarding: failed to record operator notice');
    return false;
  }
  // Detail values can carry model-supplied text, so logs and audit get the key names only
  // (review checklist: ids and counts, not content). Delivering the details is #2365's job.
  const detailKeys = details ? Object.keys(details) : [];
  deps.logger.warn({ taskId, event, detailKeys }, 'onboarding: operator notice');
  try {
    deps.audit?.({ type: 'onboarding.operator_notice', taskId, event, detailKeys });
  } catch (err) {
    // Best-effort: the notice is already on the task; a failed audit must not report it unrecorded.
    deps.logger.error({ err, taskId, event }, 'onboarding: operator notice audit failed — the notice is recorded on the task');
  }
  return true;
}
