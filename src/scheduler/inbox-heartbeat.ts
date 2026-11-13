// inbox-heartbeat.ts — the system-layer triage heartbeat (#2475, D4).
//
// Every 15 minutes, around the clock, this decides in code whether ceo-inbox has triage to do.
// It makes NO model call: it asks which mailboxes are due (dueMailboxes, the one definition,
// R7), probes each due mailbox with a one-message unread list, and only when some mailbox has
// unread mail does it wake ceo-inbox with an `inbox-drain` task. Cadence therefore controls
// how much LLM work happens, not how often we look. It replaces the agent's old
// `0 6-23 * * *` triage cron.
//
// Live vs stalled `inbox-drain` task (open or in_progress, tag `inbox-drain`, agent ceo-inbox):
//   live    = the scheduler still owns a wake for it (nextWakeAt or wakeState set, so a running
//             wake counts), OR it was updated within STALLED_AFTER_MINUTES (a run is about to
//             re-arm it). A live drain owns the inbox: do nothing ('drain_running').
//   stalled = no wake owned and no update for STALLED_AFTER_MINUTES. Re-wake it in place
//             (enqueueTaskWake); never create a second drain task while one is open.
import type { Logger } from '../logger.js';
import type { TaskRepo } from '../db/task-repo.js';
import type { SchedulerService } from './scheduler-service.js';
import type { PrincipalMailboxes } from '../principal-mailboxes/service.js';
import type { Cadence } from '../principal-mailboxes/triage-cadence.js';
import type { TriageState } from '../principal-mailboxes/triage-state.js';
import { dueMailboxes } from '../principal-mailboxes/triage-due.js';
import { grantSafeErrorFields } from '../principal-mailboxes/error-fields.js';

export const INBOX_DRAIN_TAG = 'inbox-drain';
const INBOX_AGENT = 'ceo-inbox';
/** A drain task untouched for this long, with no wake pending, is stalled. */
export const STALLED_AFTER_MINUTES = 30;

export type InboxHeartbeatResult = 'woke' | 'quiet' | 'drain_running' | 'ceiling';

export interface InboxHeartbeatOptions {
  mailboxes: Pick<PrincipalMailboxes, 'list'>;
  /** Cadences for the given live mailbox ids (read fresh each tick). */
  cadences: (mailboxIds: string[]) => Promise<Record<string, Cadence>>;
  state: TriageState;
  /** True when the mailbox has unread mail (received after `since` when set). May throw. */
  hasUnreadSince: (mailboxId: string, since: Date | null) => Promise<boolean>;
  taskRepo: Pick<TaskRepo, 'listTasks' | 'createTask'>;
  scheduler: Pick<SchedulerService, 'enqueueTaskWake'>;
  dailyCeiling: number;
  tz: () => string;
  logger: Logger;
  intervalMinutes?: number;
}

export class InboxHeartbeat {
  private intervalHandle: NodeJS.Timeout | null = null;
  // A slow tick (Nylas probes) must not overlap the next interval fire.
  private tickInFlight = false;

  constructor(private readonly o: InboxHeartbeatOptions) {}

  start(): void {
    if (this.intervalHandle) return;
    const minutes = this.o.intervalMinutes ?? 15;
    this.intervalHandle = setInterval(() => {
      if (this.tickInFlight) {
        this.o.logger.warn('InboxHeartbeat: previous tick still in flight; skipping this interval');
        return;
      }
      this.tickInFlight = true;
      this.tick()
        .catch((err) => {
          this.o.logger.error({ err }, 'InboxHeartbeat: unhandled error in tick');
        })
        .finally(() => {
          this.tickInFlight = false;
        });
    }, minutes * 60_000);
    this.o.logger.info({ intervalMinutes: minutes }, 'InboxHeartbeat started');
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.o.logger.info('InboxHeartbeat stopped');
  }

  async tick(now: Date = new Date()): Promise<InboxHeartbeatResult> {
    // The state's own ceiling (TRIAGE_DAILY_CEILING) gates; dailyCeiling is recorded for logs.
    if (await this.o.state.ceilingReached(now)) {
      this.o.logger.info({ dailyCeiling: this.o.dailyCeiling }, 'InboxHeartbeat: daily batch ceiling reached; not waking triage');
      return 'ceiling';
    }

    const mailboxes = await this.o.mailboxes.list();
    const ids = mailboxes.map((m) => m.id);
    const due = await dueMailboxes({
      mailboxIds: ids,
      cadences: await this.o.cadences(ids),
      state: this.o.state,
      now,
      tz: this.o.tz(),
    });
    if (due.length === 0) return 'quiet';

    const startById = new Map(mailboxes.map((m) => [m.id, m.triageStartAt]));
    let failed = 0;
    let hasMail = false;
    for (const id of due) {
      try {
        if (await this.o.hasUnreadSince(id, startById.get(id) ?? null)) {
          hasMail = true;
          break;
        }
      } catch (err) {
        // A failed probe counts as "no mail" for this tick. Grant-safe: SDK errors can carry the grant id.
        failed += 1;
        this.o.logger.warn({ mailboxId: id, ...grantSafeErrorFields(err) }, 'InboxHeartbeat: unread probe failed; treating as no mail this tick');
      }
    }
    if (!hasMail) {
      if (failed === due.length) {
        this.o.logger.warn({ failed, due: due.length }, 'InboxHeartbeat: every due mailbox probe failed; no triage this tick');
      }
      return 'quiet';
    }

    const open = (await this.o.taskRepo.listTasks({
      statuses: ['open', 'in_progress'],
      tag: INBOX_DRAIN_TAG,
      limit: 25,
    })).filter((t) => t.agentId === INBOX_AGENT);

    const staleBefore = now.getTime() - STALLED_AFTER_MINUTES * 60_000;
    const isLive = (t: (typeof open)[number]): boolean =>
      t.nextWakeAt !== null || t.wakeState !== null || new Date(t.updatedAt).getTime() > staleBefore;
    if (open.some(isLive)) return 'drain_running';

    const stalled = open[0];
    if (stalled) {
      await this.o.scheduler.enqueueTaskWake({ taskId: stalled.id, agentId: INBOX_AGENT, runAt: now });
      this.o.logger.info({ taskId: stalled.id }, 'InboxHeartbeat: re-woke a stalled inbox-drain task');
      return 'woke';
    }

    const task = await this.o.taskRepo.createTask({
      agentId: INBOX_AGENT,
      title: 'Inbox drain',
      tags: [INBOX_DRAIN_TAG],
      wakeAt: now,
      createdBy: 'heartbeat',
    });
    this.o.logger.info({ taskId: task.id, due }, 'InboxHeartbeat: created an inbox-drain task');
    return 'woke';
  }
}
