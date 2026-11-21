// turn-context.ts — onboarding context for live principal turns (#2360, design §6).
//
// An ordinary principal message carries no task id, so it would never restore the `onboarding`
// skill. While the onboarding task is open, the coordinator runtime asks this source for a short
// block naming the task and its open topic ids, and activates the skill for that turn. The turn is
// not bound to the task: anything else in the message is handled as usual.

import type { ConfigStore } from '../memory/config-store.js';
import type { TaskRepo } from '../db/task-repo.js';
import type { Logger } from '../logger.js';
import { findOpenOnboardingTask, readOnboardingState, writeOnboardingState } from './state.js';
import { isOpenTask, listChildren, topicSubtasks } from './subtasks.js';

export interface OnboardingTurnContextSource {
  /** The block for a live principal turn, or null when no onboarding is open (or the lookup failed). */
  forPrincipalTurn(now: Date): Promise<string | null>;
}

/**
 * The block a live principal turn gets while onboarding is open. It names the open topics by id
 * only: ids are [a-z0-9-] (the playbook parser enforces it), so no operator-written text reaches
 * the principal's turn; titles and playbook text come from onboarding-progress status. Exported
 * so the scenario harness serves the same text from a case's `seed.onboarding`.
 */
export function formatOnboardingTurnBlock(taskId: string, openTopicIds: readonly string[]): string {
  const topics = openTopicIds.join(', ') || 'none';
  return `[Onboarding in progress — task ${taskId}. Open topics this session: ${topics}. `
    + 'Use onboarding-progress with op "status" to read them and record progress. '
    + 'Handle anything else the principal asks as usual.]';
}

export function createOnboardingTurnContext(deps: {
  taskRepo: Pick<TaskRepo, 'listTasks'>;
  configStore: Pick<ConfigStore, 'get' | 'set'>;
  logger: Logger;
}): OnboardingTurnContextSource {
  const { taskRepo, configStore, logger } = deps;
  return {
    async forPrincipalTurn(now: Date): Promise<string | null> {
      try {
        const parent = await findOpenOnboardingTask(taskRepo);
        if (!parent) return null;
        const open = topicSubtasks(await listChildren(taskRepo, parent.id), logger).filter((s) => isOpenTask(s.task));
        await recordPrincipalTurn(configStore, logger, now);
        return formatOnboardingTurnBlock(parent.id, open.map((s) => s.topicId));
      } catch (err) {
        // Fail open: a broken lookup must not break the principal's chat.
        logger.error({ err }, 'onboarding: turn context lookup failed — this turn proceeds without it');
        return null;
      }
    },
  };
}

/** Stamp lastPrincipalTurnAt. Missing state is left alone: this path never creates it. */
async function recordPrincipalTurn(
  store: Pick<ConfigStore, 'get' | 'set'>,
  logger: Logger,
  now: Date,
): Promise<void> {
  try {
    const state = await readOnboardingState(store, logger);
    if (!state) return;
    await writeOnboardingState(store, { ...state, lastPrincipalTurnAt: now.toISOString() });
  } catch (err) {
    // The idle nudge reads this; a missed stamp is not worth dropping the turn's context.
    logger.error({ err }, 'onboarding: failed to record the principal turn — idle nudge timing may be early');
  }
}
