// handler.ts — onboarding-triage-release (#2360).
//
// Lifts the onboarding triage hold so the inbox heartbeat starts triaging. Only once the
// principal has heard what to expect: the inbox-expectations topic subtask (created by
// onboarding) must be done, not declined. Marking that topic done can be what completes the
// onboarding task (it was the last open topic), so a completed run's task counts too.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import type { TaskRepo } from '../../../../src/db/task-repo.js';
import type { TaskRow } from '../../../../src/db/queries/tasks.js';
import type { OnboardingService } from '../../../../src/onboarding/onboarding-service.js';
import { ONBOARDING_CREATED_BY } from '../../../../src/onboarding/constants.js';
import { findOpenOnboardingTask } from '../../../../src/onboarding/state.js';
import { DECLINED_TAG, INBOX_EXPECTATIONS_TOPIC, listChildren, topicSubtasks } from '../../../../src/onboarding/subtasks.js';

export class OnboardingTriageReleaseHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const svc = ctx.onboardingService;
    const repo = ctx.taskRepo;
    if (!svc || !repo) {
      return { success: false, error: 'onboarding-triage-release requires the onboardingService and taskRepo capabilities' };
    }
    try {
      const parent = await findOpenOnboardingTask(repo) ?? await completedRunTask(svc, repo);
      if (!parent) return { success: false, error: 'No onboarding is under way: there is no open onboarding task.' };
      const inboxDone = topicSubtasks(await listChildren(repo, parent.id), ctx.log)
        // Declined means the principal did not hear it through: triage stays held.
        .some((s) => s.topicId === INBOX_EXPECTATIONS_TOPIC && s.task.status === 'done' && !s.task.tags.includes(DECLINED_TAG));
      if (!inboxDone) {
        return {
          success: false,
          error:
            `Triage stays held until the principal has heard what to expect in their inbox: the ` +
            `'${INBOX_EXPECTATIONS_TOPIC}' topic must be marked done (not declined) first. If they ` +
            'declined it, triage stays held; they can switch Email triage on in Settings.',
        };
      }
      await svc.releaseTriageHold();
      ctx.log.info({ taskId: parent.id }, 'onboarding: triage hold released');
      return { success: true, data: { released: true } };
    } catch (err) {
      ctx.log.error({ err }, 'onboarding-triage-release failed');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * The current run's onboarding task once it is done: completing the last topic completes it, and
 * that topic may be inbox-expectations. Only the run state's own task, created by the program as
 * a parent; a cancelled run is not a completed one.
 */
async function completedRunTask(
  svc: Pick<OnboardingService, 'readState'>,
  repo: Pick<TaskRepo, 'getTask'>,
): Promise<TaskRow | null> {
  const state = await svc.readState();
  if (!state) return null;
  const task = await repo.getTask(state.taskId);
  if (!task || task.status !== 'done' || task.parentTaskId || task.createdBy !== ONBOARDING_CREATED_BY) return null;
  return task;
}
