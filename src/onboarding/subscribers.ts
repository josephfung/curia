// subscribers.ts — pairing, mailbox connection and blocked sign-ins wake the onboarding program (#2360).
//
// Each handler acts only while an onboarding task is open (findOpenOnboardingTask), adds a progress
// note saying what to do, and wakes the coordinator now (see noteAndWakeCoordinator for a task that
// already has a wake). Handlers never throw: a bus handler error must not break the
// publisher (the pairing route, the sign-in callback).

import type { EventBus } from '../bus/bus.js';
import type { BusEvent } from '../bus/events.js';
import { makeSystemOriginator } from '../contacts/principal.js';
import { isPgUniqueViolation } from '../agents/resumable-continuation.js';
import type { TaskRepo } from '../db/task-repo.js';
import type { TaskRow } from '../db/queries/tasks.js';
import type { Logger } from '../logger.js';
import type { ConfigStore } from '../memory/config-store.js';
import type { SchedulerService } from '../scheduler/scheduler-service.js';
import { BUSY_WAKE_RETRIES, BUSY_WAKE_RETRY_SECONDS, ONBOARDING_CREATED_BY } from './constants.js';
import { notifyOperatorOnce } from './notify-operator-once.js';
import { findOpenOnboardingTask, type OnboardingStateLock, readOnboardingState } from './state.js';

export interface OnboardingSubscribersOptions {
  bus: EventBus;
  taskRepo: TaskRepo;
  scheduler: Pick<SchedulerService, 'enqueueTaskWake' | 'runTaskWakeEarly'>;
  configStore: Pick<ConfigStore, 'get' | 'set'>;
  /** The process's shared onboarding state lock (createOnboardingStateLock). */
  stateLock: OnboardingStateLock;
  logger: Logger;
  /** The Google OAuth client id to trust, for a mailbox_signin_blocked notice; undefined when unknown. */
  googleClientId?: () => Promise<string | undefined>;
}

const BLOCKED_OUTCOMES: ReadonlySet<string> = new Set(['admin_blocked', 'org_internal']);

export class OnboardingSubscribers {
  constructor(private readonly o: OnboardingSubscribersOptions) {}

  start(): void {
    const { bus } = this.o;
    bus.subscribe('pairing.invitation_redeemed', 'system', (event: BusEvent) => {
      if (event.type !== 'pairing.invitation_redeemed') return;
      return this.guard(event.type, () => this.onInvitationRedeemed(event.payload.invitationId, event.timestamp));
    });
    bus.subscribe('principal_mailbox.connected', 'system', (event: BusEvent) => {
      if (event.type !== 'principal_mailbox.connected') return;
      return this.guard(event.type, () => this.onMailboxConnected(event.payload.mailboxId));
    });
    bus.subscribe('mailbox_signin.finished', 'system', (event: BusEvent) => {
      if (event.type !== 'mailbox_signin.finished') return;
      const { outcome, target } = event.payload;
      // A blocked sign-in for Curia's own mailbox is not an onboarding notice.
      if (target !== 'principal' || !BLOCKED_OUTCOMES.has(outcome)) return;
      return this.guard(event.type, () => this.onSignInBlocked(outcome));
    });
  }

  private async guard(eventType: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.o.logger.error({ err, eventType }, 'onboarding: subscriber failed');
    }
  }

  /**
   * The app greeting is due only on an app-route run that has not greeted yet. A link redeemed now
   * counts if it is the run's own (state.invitationId) or was redeemed after Start (a replacement
   * minted from Devices), as in the watcher's isRunInvitation; the event is published at redemption,
   * so its timestamp dates it. A link redeemed before Start belongs to no run. A phone paired during a
   * Signal, SMS or Slack run is just a new device.
   */
  private async onInvitationRedeemed(invitationId: string, redeemedAt: Date): Promise<void> {
    const task = await findOpenOnboardingTask(this.o.taskRepo);
    if (!task) return;
    const state = await readOnboardingState(this.o.configStore, this.o.logger);
    if (state === null || state.taskId !== task.id || state.route !== 'app') return;
    // Already greeted (a second device, or a replay): nothing to say again.
    if (state.greetingSentAt !== null) return;
    const runInvitation = invitationId === state.invitationId;
    if (!runInvitation && redeemedAt.getTime() < Date.parse(state.startedAt)) return;
    this.o.logger.debug(
      { taskId: task.id, runInvitation },
      'onboarding: phone app paired before the greeting',
    );
    await this.noteAndWake(task, 'Phone app paired: send the greeting in the app');
  }

  private async onMailboxConnected(mailboxId: string): Promise<void> {
    const task = await findOpenOnboardingTask(this.o.taskRepo);
    if (!task) return;
    // The event carries the mailbox id, never an address (#2361), so the note names the id.
    // #2362: the deep dive starts here.
    await this.noteAndWake(
      task,
      `Mailbox connected (${mailboxId}): run the first look; pick up connect-mailbox / inbox-expectations`,
    );
  }

  private async onSignInBlocked(outcome: string): Promise<void> {
    const task = await findOpenOnboardingTask(this.o.taskRepo);
    if (!task) return;
    let clientId: string | undefined;
    try {
      clientId = await this.o.googleClientId?.();
    } catch (err) {
      this.o.logger.warn({ errName: err instanceof Error ? err.name : typeof err }, 'onboarding: could not read the Google client id for the notice');
    }
    await notifyOperatorOnce(
      { taskRepo: this.o.taskRepo, logger: this.o.logger, configStore: this.o.configStore, stateLock: this.o.stateLock },
      task.id,
      'mailbox_signin_blocked',
      { outcome, ...(clientId !== undefined ? { clientId } : {}) },
    );
  }

  private noteAndWake(task: TaskRow, note: string): Promise<void> {
    return noteAndWakeCoordinator(this.o, task, note);
  }
}

/**
 * Add a progress note to a task and wake the coordinator on it now. A task has one active wake
 * (23505 on a second). One due now is as good. One booked for later (the next session) is run now
 * instead, keeping its booked time to arm again after this run, so the note is not left waiting for
 * that session and the session is not moved. A running wake runs once more after it completes; if
 * it already holds a booked time ('busy'), the move is retried in-process once that run has
 * finished (best effort: a restart drops the retry, and the note waits for the booked run).
 */
export async function noteAndWakeCoordinator(
  o: Pick<OnboardingSubscribersOptions, 'taskRepo' | 'scheduler' | 'logger'>,
  task: Pick<TaskRow, 'id'>,
  note: string,
): Promise<void> {
  await o.taskRepo.updateTask(task.id, { progressNote: note });
  if (await enqueueWakeNow(o, task.id)) return;
  const outcome = await o.scheduler.runTaskWakeEarly(task.id, new Date());
  o.logger.debug({ taskId: task.id, outcome }, 'onboarding: a coordinator wake was already active');
  if (outcome === 'busy') retryBusyWake(o, task.id, BUSY_WAKE_RETRIES);
  // 'none': the active wake is due now, or it finished after the collision and left no wake (it may
  // have read its notes before this one). Enqueue again; a collision now means a wake is due.
  else if (outcome === 'none') await enqueueWakeNow(o, task.id);
}

/** Enqueue a coordinator wake for now; false when the task already has an active wake. */
async function enqueueWakeNow(
  o: Pick<OnboardingSubscribersOptions, 'scheduler'>,
  taskId: string,
): Promise<boolean> {
  try {
    await o.scheduler.enqueueTaskWake({
      taskId,
      agentId: 'coordinator',
      runAt: new Date(),
      createdBy: ONBOARDING_CREATED_BY,
      originator: makeSystemOriginator(),
    });
    return true;
  } catch (err) {
    if (!isPgUniqueViolation(err)) throw err;
    return false;
  }
}

function retryBusyWake(
  o: Pick<OnboardingSubscribersOptions, 'scheduler' | 'logger'>,
  taskId: string,
  triesLeft: number,
): void {
  const timer = setTimeout(() => {
    o.scheduler.runTaskWakeEarly(taskId, new Date()).then(
      (outcome) => {
        if (outcome === 'busy' && triesLeft > 1) return retryBusyWake(o, taskId, triesLeft - 1);
        if (outcome === 'busy') o.logger.warn({ taskId }, 'onboarding: wake still running; the note waits for the booked run');
        else o.logger.debug({ taskId, outcome }, 'onboarding: busy wake retried');
      },
      (err: unknown) => o.logger.error({ err, taskId }, 'onboarding: busy wake retry failed; the note waits for the booked run'),
    );
  }, BUSY_WAKE_RETRY_SECONDS * 1000);
  timer.unref();
}
