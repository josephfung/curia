// watcher.ts — the onboarding watcher: capped greeting follow-ups, one idle nudge, and the
// expired-invitation notice (#2360). A tick with no open onboarding task is one cheap query.

import type { TaskRepo } from '../db/task-repo.js';
import type { Logger } from '../logger.js';
import type { ConfigStore } from '../memory/config-store.js';
import type { SchedulerService } from '../scheduler/scheduler-service.js';
import {
  FIRST_CONVERSATION_SESSION,
  GREETING_FOLLOWUPS,
  WATCHER_INTERVAL_MINUTES,
} from './constants.js';
import { decideNext } from './followup-policy.js';
import { notifyOperatorOnce } from './notify-operator-once.js';
import { findOpenOnboardingTask, type OnboardingState, readOnboardingState, writeOnboardingState } from './state.js';
import { isOpenTask, listChildren, topicSubtasks } from './subtasks.js';
import { noteAndWakeCoordinator } from './subscribers.js';

export interface OnboardingWatcherOptions {
  taskRepo: TaskRepo;
  scheduler: Pick<SchedulerService, 'enqueueTaskWake'>;
  configStore: Pick<ConfigStore, 'get' | 'set'>;
  logger: Logger;
  /** The current phone-app invitation; null when none exists. */
  readInvitation: () => Promise<{ expiresAt: Date; createdAt: Date; redeemed: boolean } | null>;
  intervalMinutes?: number;
}

export class OnboardingWatcher {
  private handle: NodeJS.Timeout | null = null;
  private tickInFlight = false;

  constructor(private readonly o: OnboardingWatcherOptions) {}

  start(): void {
    if (this.handle) return;
    const ms = (this.o.intervalMinutes ?? WATCHER_INTERVAL_MINUTES) * 60_000;
    this.handle = setInterval(() => {
      if (this.tickInFlight) return;
      this.tickInFlight = true;
      this.tick(new Date()).finally(() => {
        this.tickInFlight = false;
      });
    }, ms);
  }

  stop(): void {
    if (this.handle) {
      clearInterval(this.handle);
      this.handle = null;
    }
  }

  /** One sweep. Errors are logged, never thrown. */
  async tick(now: Date): Promise<void> {
    try {
      const task = await findOpenOnboardingTask(this.o.taskRepo);
      if (!task) return;
      const state = await readOnboardingState(this.o.configStore, this.o.logger);
      if (state === null || state.taskId !== task.id) return;

      // The current invitation may predate this run (cancel + restart, or minted from Devices): it
      // counts only on the app route and when minted at or after the run started.
      let invitation: { expiresAt: Date; redeemed: boolean } | null = null;
      if (state.route === 'app') {
        const inv = await this.o.readInvitation();
        if (inv !== null && inv.createdAt.getTime() >= Date.parse(state.startedAt)) invitation = inv;
      }
      const openTopicsRemain = await this.openFirstConversationTopics(task.id);
      const action = decideNext(state, now, invitation, openTopicsRemain);
      if (action === 'wait') return;

      const deps = { taskRepo: this.o.taskRepo, logger: this.o.logger, configStore: this.o.configStore };
      switch (action) {
        case 'send_followup': {
          const n = state.followUpsSent + 1;
          // State first: a failed write must not leave a sent follow-up uncounted (the cap would slip).
          if (!(await this.updateState((s) => decideNext(s, now, invitation, openTopicsRemain) === action, (s) => ({ ...s, followUpsSent: s.followUpsSent + 1, lastFollowUpAt: now.toISOString() })))) break;
          await noteAndWakeCoordinator(this.o, task, `Send follow-up ${n} of ${GREETING_FOLLOWUPS}`);
          break;
        }
        case 'idle_nudge':
          if (!(await this.updateState((s) => decideNext(s, now, invitation, openTopicsRemain) === action, (s) => ({ ...s, idleNudgeSentAt: now.toISOString() })))) break;
          await noteAndWakeCoordinator(this.o, task, 'Principal went quiet mid-conversation: one gentle nudge');
          break;
        case 'notify_greeting_unanswered':
          await notifyOperatorOnce(deps, task.id, 'greeting_unanswered');
          break;
        case 'notify_invitation_expired':
          await notifyOperatorOnce(deps, task.id, 'invitation_expired');
          break;
      }
    } catch (err) {
      this.o.logger.error({ err }, 'onboarding: watcher tick failed');
    }
  }

  private async openFirstConversationTopics(taskId: string): Promise<boolean> {
    const children = await listChildren(this.o.taskRepo, taskId);
    return topicSubtasks(children).some((t) => t.sessionId === FIRST_CONVERSATION_SESSION && isOpenTask(t.task));
  }

  /**
   * Re-read the latest state right before writing, so a concurrent change to another field survives,
   * and re-decide on it: a reply that landed since the tick's first read cancels the action.
   * Returns whether the change was written.
   */
  private async updateState(
    stillApplies: (s: OnboardingState) => boolean,
    change: (s: OnboardingState) => OnboardingState,
  ): Promise<boolean> {
    const latest = await readOnboardingState(this.o.configStore, this.o.logger);
    if (latest === null) return false;
    if (!stillApplies(latest)) return false;
    await writeOnboardingState(this.o.configStore, change(latest));
    return true;
  }
}
