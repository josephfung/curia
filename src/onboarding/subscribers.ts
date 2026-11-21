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
import { ONBOARDING_CREATED_BY } from './constants.js';
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
      return this.guard(event.type, () => this.onInvitationRedeemed(event.payload.invitationId));
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
   * is the run's own (state.invitationId) or a replacement minted from Devices after Start (Start
   * superseded every earlier link), and either counts, as in the watcher's isRunInvitation. A phone
   * paired during a Signal, SMS or Slack run is just a new device.
   */
  private async onInvitationRedeemed(invitationId: string): Promise<void> {
    const task = await findOpenOnboardingTask(this.o.taskRepo);
    if (!task) return;
    const state = await readOnboardingState(this.o.configStore, this.o.logger);
    if (state === null || state.taskId !== task.id || state.route !== 'app') return;
    // Already greeted (a second device, or a replay): nothing to say again.
    if (state.greetingSentAt !== null) return;
    this.o.logger.debug(
      { taskId: task.id, runInvitation: invitationId === state.invitationId },
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
 * (23505 on a second). One due now or running is as good. One booked for later (the next session)
 * is run now instead, keeping its booked time to arm again after this run, so the note is not left
 * waiting for that session and the session is not moved.
 */
export async function noteAndWakeCoordinator(
  o: Pick<OnboardingSubscribersOptions, 'taskRepo' | 'scheduler' | 'logger'>,
  task: Pick<TaskRow, 'id'>,
  note: string,
): Promise<void> {
  await o.taskRepo.updateTask(task.id, { progressNote: note });
  try {
    await o.scheduler.enqueueTaskWake({
      taskId: task.id,
      agentId: 'coordinator',
      runAt: new Date(),
      createdBy: ONBOARDING_CREATED_BY,
      originator: makeSystemOriginator(),
    });
  } catch (err) {
    if (!isPgUniqueViolation(err)) throw err;
    const now = new Date();
    const movedEarly = await o.scheduler.runTaskWakeEarly(task.id, now);
    o.logger.debug({ taskId: task.id, movedEarly }, movedEarly
      ? 'onboarding: the booked wake runs now and keeps its booked time'
      : 'a coordinator wake is already pending');
  }
}
