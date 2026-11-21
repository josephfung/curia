// watcher.ts — the onboarding watcher: a re-wake when no greeting was recorded, capped greeting
// follow-ups, one idle nudge, and the expired-invitation notice (#2360). A tick with no open
// onboarding task is one cheap query.

import type { TaskRepo } from '../db/task-repo.js';
import type { Logger } from '../logger.js';
import type { ConfigStore } from '../memory/config-store.js';
import type { SchedulerService } from '../scheduler/scheduler-service.js';
import {
  FIRST_CONVERSATION_SESSION,
  GREETING_FOLLOWUPS,
  WATCHER_INTERVAL_MINUTES,
} from './constants.js';
import { decideNext, type WatcherFacts, type WatcherInvitation } from './followup-policy.js';
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
  readInvitation: () => Promise<{ expiresAt: Date; createdAt: Date; redeemed: boolean; redeemedAt: Date | null } | null>;
  /**
   * Whether the onboarding task's next session is booked (see {@link isNextSessionBooked}).
   * Absent → never booked.
   */
  nextSessionBooked?: (taskId: string, now: Date) => Promise<boolean>;
  intervalMinutes?: number;
}

/** Wake note when no greeting was recorded a gap after it was due. */
export const GREETING_NOT_RECORDED_NOTE =
  "The greeting hasn't been recorded as sent: send it now if it wasn't, then record it with onboarding-progress op greeting_sent";

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
      let invitation: WatcherInvitation | null = null;
      if (state.route === 'app') {
        const inv = await this.o.readInvitation();
        if (inv !== null && inv.createdAt.getTime() >= Date.parse(state.startedAt)) invitation = inv;
      }
      const openTopicsRemain = await this.openFirstConversationTopics(task.id);
      // Only the idle nudge reads it, and only with open topics.
      const nextSessionBooked = openTopicsRemain && this.o.nextSessionBooked
        ? await this.o.nextSessionBooked(task.id, now)
        : false;
      const facts: WatcherFacts = { openTopicsRemain, nextSessionBooked };
      const action = decideNext(state, now, invitation, facts);
      if (action === 'wait') return;

      const deps = { taskRepo: this.o.taskRepo, logger: this.o.logger, configStore: this.o.configStore };
      const stillApplies = (s: OnboardingState) => decideNext(s, now, invitation, facts) === action;
      switch (action) {
        case 'greeting_nudge':
          if (!(await this.updateState(stillApplies, (s) => ({ ...s, greetingNudgedAt: now.toISOString() })))) break;
          await noteAndWakeCoordinator(this.o, task, GREETING_NOT_RECORDED_NOTE);
          break;
        case 'send_followup': {
          const n = state.followUpsSent + 1;
          // State first: a failed write must not leave a sent follow-up uncounted (the cap would slip).
          if (!(await this.updateState(stillApplies, (s) => ({ ...s, followUpsSent: s.followUpsSent + 1, lastFollowUpAt: now.toISOString() })))) break;
          await noteAndWakeCoordinator(this.o, task, `Send follow-up ${n} of ${GREETING_FOLLOWUPS}`);
          break;
        }
        case 'idle_nudge':
          if (!(await this.updateState(stillApplies, (s) => ({ ...s, idleNudgeSentAt: now.toISOString() })))) break;
          await noteAndWakeCoordinator(this.o, task, 'Principal went quiet mid-conversation: one gentle nudge');
          break;
        case 'notify_greeting_unanswered':
          // Either no reply after every follow-up, or no greeting recorded even after the re-wake.
          await notifyOperatorOnce(
            deps,
            task.id,
            'greeting_unanswered',
            state.greetingSentAt === null ? { reason: 'greeting_not_recorded' } : undefined,
          );
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

/**
 * Whether the onboarding task's next session is booked: a pending wake of the task set for later
 * than `now` (a session booked with no calendar, or a deferral), or a pending agenda it owns (a
 * session on the calendar). The idle nudge is skipped then: the quiet was agreed.
 */
export async function isNextSessionBooked(
  deps: {
    pool: { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };
    listPendingAgendas: (now: Date) => Promise<ReadonlyArray<{ ownerTaskId: string | null }>>;
  },
  taskId: string,
  now: Date,
): Promise<boolean> {
  const { rows } = await deps.pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM scheduled_jobs
       WHERE task_id = $1 AND (
         (status = 'pending' AND COALESCE(next_run_at, run_at) > $2)
         -- task-update wake_at from inside the task's own wake run is parked here until it ends
         OR (status = 'running' AND deferred_wake_at > $2)
       )
     ) AS booked`,
    [taskId, now],
  );
  if (rows[0]?.['booked'] === true) return true;
  return (await deps.listPendingAgendas(now)).some((a) => a.ownerTaskId === taskId);
}
