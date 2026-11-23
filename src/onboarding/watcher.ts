// watcher.ts — the onboarding watcher: a re-wake when no greeting was recorded, capped greeting
// follow-ups, one idle nudge, and the expired-invitation notice (#2360). A tick with no open
// onboarding task is one cheap query.

import { TaskTerminalStateError, type TaskRepo } from '../db/task-repo.js';
import type { TaskRow } from '../db/queries/tasks.js';
import type { Logger } from '../logger.js';
import type { ConfigStore } from '../memory/config-store.js';
import type { SchedulerService } from '../scheduler/scheduler-service.js';
import {
  FIRST_CONVERSATION_SESSION,
  ONBOARDING_CREATED_BY,
  GREETING_FOLLOWUPS,
  WATCHER_INTERVAL_MINUTES,
} from './constants.js';
import { decideNext, type WatcherFacts, type WatcherInvitation } from './followup-policy.js';
import { notifyOperatorOnce } from './notify-operator-once.js';
import type { OperatorNotifier } from './notify-operator.js';
import {
  findOpenOnboardingTask,
  type OnboardingState,
  type OnboardingStateLock,
  readOnboardingState,
  updateOnboardingState,
} from './state.js';
import { isOpenTask, listChildren, topicSubtasks } from './subtasks.js';
import { noteAndWakeCoordinator } from './subscribers.js';

export interface OnboardingWatcherOptions {
  taskRepo: TaskRepo;
  scheduler: Pick<SchedulerService, 'enqueueTaskWake' | 'runTaskWakeEarly'>;
  configStore: Pick<ConfigStore, 'get' | 'set'>;
  /** The process's shared onboarding state lock (createOnboardingStateLock). */
  stateLock: OnboardingStateLock;
  logger: Logger;
  /** How an operator notice is emailed (#2710). Absent: the note is recorded, nobody is emailed. */
  notifyOperator?: OperatorNotifier;
  /** The current phone-app invitation; null when none exists. */
  readInvitation: () => Promise<{ id: string; expiresAt: Date; redeemed: boolean; redeemedAt: Date | null } | null>;
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
      const children = await listChildren(this.o.taskRepo, task.id);
      await this.keepWaitingOnPrincipal([task, ...children.filter((c) => c.createdBy === ONBOARDING_CREATED_BY)]);
      const state = await readOnboardingState(this.o.configStore, this.o.logger);
      if (state === null || state.taskId !== task.id) return;

      let invitation: WatcherInvitation | null = null;
      if (state.route === 'app') {
        const inv = await this.o.readInvitation();
        if (inv !== null && isRunInvitation(state, inv)) invitation = inv;
      }
      const openTopicsRemain = this.openFirstConversationTopics(children);
      // Only the idle nudge reads it, and only with open topics.
      const nextSessionBooked = openTopicsRemain && this.o.nextSessionBooked
        ? await this.o.nextSessionBooked(task.id, now)
        : false;
      const facts: WatcherFacts = { openTopicsRemain, nextSessionBooked };
      const action = decideNext(state, now, invitation, facts);
      if (action === 'wait') return;

      const deps = {
        taskRepo: this.o.taskRepo,
        logger: this.o.logger,
        configStore: this.o.configStore,
        stateLock: this.o.stateLock,
        // Present when an outbound gateway exists: the notice is recorded either way.
        notifier: this.o.notifyOperator,
      };
      // Re-decided on the latest state inside each update, so it must still be this run's state.
      const stillApplies = (s: OnboardingState) => s.taskId === task.id && decideNext(s, now, invitation, facts) === action;
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
            state.greetingSentAt === null
              ? { greetingNotRecorded: true, details: { reason: 'greeting_not_recorded' } }
              : undefined,
            stillApplies,
          );
          break;
        case 'notify_invitation_expired':
          await notifyOperatorOnce(deps, task.id, 'invitation_expired', undefined, stillApplies);
          break;
      }
    } catch (err) {
      this.o.logger.error({ err }, 'onboarding: watcher tick failed');
    }
  }

  /**
   * The onboarding task and its topics wait on the principal (created so), which keeps the backlog
   * heartbeat off them. The principal answering a message bound to one (a task-wake reply) resumes
   * it as in_progress, the general rule for a task whose contact answered; here the conversation
   * goes on, so it waits again. Applies to every onboarding-created task that names a contact to
   * wait on and is open or in progress. One that ended meanwhile is skipped quietly; any other
   * failure is logged and the sweep goes on.
   */
  private async keepWaitingOnPrincipal(tasks: readonly TaskRow[]): Promise<void> {
    for (const task of tasks) {
      if (!task.waitingOnContactId || (task.status !== 'open' && task.status !== 'in_progress')) continue;
      try {
        await this.o.taskRepo.updateTask(task.id, { status: 'waiting' }, undefined, { rejectStatuses: ['failed'] });
      } catch (err) {
        if (err instanceof TaskTerminalStateError) {
          this.o.logger.debug({ taskId: task.id, status: err.status }, 'onboarding: task ended before it could wait again — skipped');
          continue;
        }
        this.o.logger.error({ err, taskId: task.id }, 'onboarding: could not set an onboarding task back to waiting on the principal');
      }
    }
  }

  private openFirstConversationTopics(children: readonly TaskRow[]): boolean {
    return topicSubtasks(children, this.o.logger).some((t) => t.sessionId === FIRST_CONVERSATION_SESSION && isOpenTask(t.task));
  }

  /**
   * One atomic state update (updateOnboardingState): the latest state is read under the state
   * lock and re-decided there, so a reply or another write that landed since the tick's first
   * read cancels the action, and no concurrent change is overwritten. Returns whether the change
   * was written.
   */
  private async updateState(
    stillApplies: (s: OnboardingState) => boolean,
    change: (s: OnboardingState) => OnboardingState,
  ): Promise<boolean> {
    const { written } = await updateOnboardingState(this.o, (latest) => (stillApplies(latest) ? change(latest) : null));
    return written;
  }
}

/**
 * Whether the current invitation is this run's link, on the app route. It is when it is the one
 * Start minted (state.invitationId). A replacement minted from Devices after Start counts only once
 * it was redeemed after the run started: its redemption is when the app greeting falls due, while
 * an unused replacement is the operator's own and raises no expired-invitation notice. Every link
 * minted before Start was superseded by Start's own.
 */
function isRunInvitation(
  state: OnboardingState,
  inv: { id: string; redeemed: boolean; redeemedAt: Date | null },
): boolean {
  if (state.invitationId && inv.id === state.invitationId) return true;
  return inv.redeemed && inv.redeemedAt !== null && inv.redeemedAt.getTime() >= Date.parse(state.startedAt);
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
         -- deferred_wake_at on a pending wake: a booked wake running early (runTaskWakeEarly)
         (status = 'pending' AND GREATEST(COALESCE(next_run_at, run_at), deferred_wake_at) > $2)
         -- task-update wake_at from inside the task's own wake run is parked here until it ends
         OR (status = 'running' AND deferred_wake_at > $2)
       )
     ) AS booked`,
    [taskId, now],
  );
  if (rows[0]?.['booked'] === true) return true;
  return (await deps.listPendingAgendas(now)).some((a) => a.ownerTaskId === taskId);
}
