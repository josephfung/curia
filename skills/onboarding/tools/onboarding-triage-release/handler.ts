// handler.ts — onboarding-triage-release (#2360).
//
// Lifts the onboarding triage hold so the inbox heartbeat starts triaging. Only once the
// principal has heard what to expect: the inbox-expectations topic subtask (created by
// onboarding) must be done.

import type { ToolHandler, ToolContext, ToolResult } from '../../../../src/skills/types.js';
import { findOpenOnboardingTask } from '../../../../src/onboarding/state.js';
import { INBOX_EXPECTATIONS_TOPIC, listChildren, topicSubtasks } from '../../../../src/onboarding/subtasks.js';

export class OnboardingTriageReleaseHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const svc = ctx.onboardingService;
    const repo = ctx.taskRepo;
    if (!svc || !repo) {
      return { success: false, error: 'onboarding-triage-release requires the onboardingService and taskRepo capabilities' };
    }
    try {
      const parent = await findOpenOnboardingTask(repo);
      if (!parent) return { success: false, error: 'No onboarding is under way: there is no open onboarding task.' };
      const inboxDone = topicSubtasks(await listChildren(repo, parent.id))
        .some((s) => s.topicId === INBOX_EXPECTATIONS_TOPIC && s.task.status === 'done');
      if (!inboxDone) {
        return {
          success: false,
          error:
            `Triage stays held until the principal has heard what to expect in their inbox: mark the ` +
            `'${INBOX_EXPECTATIONS_TOPIC}' topic done first (onboarding-progress topic_done).`,
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
