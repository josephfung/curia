// notify-operator.ts — placeholder for telling the operator about onboarding trouble (#2360).

import type { TaskRepo } from '../db/task-repo.js';
import type { Logger } from '../logger.js';

export type OperatorEvent =
  | 'greeting_unanswered'
  | 'invitation_expired'
  | 'web_search_failed'
  | 'mailbox_signin_blocked';

export type NotifyOperatorDeps = {
  taskRepo: Pick<TaskRepo, 'updateTask'>;
  logger: Logger;
  audit?: (e: Record<string, unknown>) => void;
};

/** Record an operator notice on the onboarding task. Never throws. */
export async function notifyOperator(
  deps: NotifyOperatorDeps,
  taskId: string,
  event: OperatorEvent,
  details?: Record<string, unknown>,
): Promise<void> {
  // TODO(#2365): deliver to the operator once the operator role exists.
  try {
    await deps.taskRepo.updateTask(taskId, { progressNote: `Operator notice: ${event}` });
    deps.logger.warn({ taskId, event, details }, 'onboarding: operator notice');
    deps.audit?.({ type: 'onboarding.operator_notice', taskId, event, details });
  } catch (err) {
    deps.logger.error({ err, taskId, event }, 'onboarding: failed to record operator notice');
  }
}
