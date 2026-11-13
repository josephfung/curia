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
//   live    = the scheduler will run a wake for it (nextWakeAt set, or wakeState pending, running
//             or retrying), OR it was updated within STALLED_AFTER_MINUTES (a run is about to
//             re-arm it). A live drain owns the inbox: do nothing ('drain_running').
//   stalled = no such wake and no update for STALLED_AFTER_MINUTES. A `suspended` wake counts as
//             no wake (the scheduler will not run it): re-wake the task in place with
//             enqueueTaskWake, which revives it, and warn. Never create a second drain task
//             while one is open.
//   held    = a `paused` wake is an operator's deliberate hold. It is left alone (warn), and
//             counts as the drain being in charge: no wake, no second task.
// Every drain the heartbeat CREATES is stamped with the system originator, as the old declarative
// cron was, so its autonomous sends pass the outbound gateway's origin check
// (isAutonomousSendOrigin). The heartbeat only considers drain tasks it created itself
// (createdBy 'heartbeat', filtered in the query); an `inbox-drain` task the agent made (possibly
// during an outsider-originated turn) is ignored: it neither blocks a heartbeat drain nor is
// re-woken, and a re-wake passes the task's STORED originator, never an upgrade (R56).
// A stalled own task with NO stored originator (pre-lineage rows) cannot be re-woken without
// erasing its lineage, so it is set aside (warned once per id) and, when no other own task can
// be re-woken, a fresh system-originated drain is created in its place.
const HEARTBEAT_CREATED_BY = 'heartbeat';
import type { Logger } from '../logger.js';
import type { TaskListRow, TaskRepo } from '../db/task-repo.js';
import type { SchedulerService } from './scheduler-service.js';
import type { PrincipalMailboxes } from '../principal-mailboxes/service.js';
import type { Cadence } from '../principal-mailboxes/triage-cadence.js';
import type { TriageState } from '../principal-mailboxes/triage-state.js';
import { dueMailboxes } from '../principal-mailboxes/triage-due.js';
import { makeSystemOriginator } from '../contacts/principal.js';
import { grantSafeErrorFields } from '../principal-mailboxes/error-fields.js';

export const INBOX_DRAIN_TAG = 'inbox-drain';
/** The drain task's intent and description: what the wake tells ceo-inbox to do (R66). */
export const INBOX_DRAIN_INTENT =
  "Triage the principal's due mailboxes: call ceo-inbox-list with triage: true, one batch at a time (Steps 1-6).";
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

/** The note a superseded drain task is closed with. */
export const LEGACY_DRAIN_CLOSE_NOTE = 'superseded by the inbox heartbeat (#2475)';

/**
 * Boot step (BR-C2): close every open `inbox-drain` task of ceo-inbox that the heartbeat did not
 * create — drains the old triage cron's agent turns made with task-create. The heartbeat never
 * sees them (R56), so left open one would run beside a heartbeat drain on the same mail. Closing
 * (completeTask, which also cancels the pending wake) is not a re-wake, so R56's lineage rule
 * holds. Idempotent: run every boot, it finds nothing once the cutover is done. A task that
 * cannot be closed is logged and the rest still close. Returns how many were closed.
 */
export async function closeLegacyInboxDrains(
  taskRepo: Pick<TaskRepo, 'listTasks' | 'completeTask'>,
  logger: Logger,
): Promise<number> {
  const open = (await taskRepo.listTasks({ statuses: ['open', 'in_progress'], tag: INBOX_DRAIN_TAG, limit: 200 }))
    .filter((t) => t.agentId === INBOX_AGENT && t.createdBy !== HEARTBEAT_CREATED_BY);
  let closed = 0;
  for (const t of open) {
    try {
      await taskRepo.completeTask(t.id, LEGACY_DRAIN_CLOSE_NOTE);
      closed += 1;
    } catch (err) {
      logger.warn({ taskId: t.id, ...grantSafeErrorFields(err) }, 'InboxHeartbeat: could not close a legacy inbox-drain task');
    }
  }
  if (closed > 0 || open.length > 0) {
    logger.info({ closed, found: open.length }, 'InboxHeartbeat: closed legacy inbox-drain tasks the heartbeat supersedes');
  }
  return closed;
}

export class InboxHeartbeat {
  private intervalHandle: NodeJS.Timeout | null = null;
  // A slow tick (Nylas probes) must not overlap the next interval fire.
  private tickInFlight = false;
  // Set-aside drain task ids already warned about, so the 15-minute tick does not repeat the line.
  private readonly ignoredLogged = new Set<string>();

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

  /** The heartbeat's own open drain tasks (R56: only those it created). */
  private async ownOpenDrains(): Promise<TaskListRow[]> {
    return (await this.o.taskRepo.listTasks({
      statuses: ['open', 'in_progress'],
      tag: INBOX_DRAIN_TAG,
      createdBy: HEARTBEAT_CREATED_BY,
      limit: 50,
    })).filter((t) => t.agentId === INBOX_AGENT && t.createdBy === HEARTBEAT_CREATED_BY);
  }

  async tick(now: Date = new Date()): Promise<InboxHeartbeatResult> {
    // The state's own ceiling (TRIAGE_DAILY_CEILING) gates; dailyCeiling is recorded for logs.
    if (await this.o.state.ceilingReached(now)) {
      this.o.logger.info({ dailyCeiling: this.o.dailyCeiling }, 'InboxHeartbeat: daily batch ceiling reached; not waking triage');
      return 'ceiling';
    }

    const mailboxes = await this.o.mailboxes.list();
    const ids = mailboxes.map((m) => m.id);
    let ownMemo: Promise<TaskListRow[]> | undefined;
    const ownOpenDrains = (): Promise<TaskListRow[]> => (ownMemo ??= this.ownOpenDrains());

    // R68: a drain that listed a mailbox's last batch left its episode open. Once no drain task
    // of the heartbeat's is open, that run finished (it completed the task), so close the
    // episode at its start. While one is open, a failed run's retry still finds the mailbox due.
    const settling: string[] = [];
    for (const id of ids) if (await this.o.state.settlePending(id)) settling.push(id);
    if (settling.length > 0 && (await ownOpenDrains()).length === 0) {
      for (const id of settling) await this.o.state.closeEpisode(id, now);
      this.o.logger.info({ mailboxes: settling }, 'InboxHeartbeat: the drain finished; closed its episode');
    }

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

    // Only the heartbeat's own tasks are fetched (R56), so foreign inbox-drain tasks cannot push
    // its own out of the page. The createdBy check below repeats the filter defensively.
    const own = await ownOpenDrains();

    const staleBefore = now.getTime() - STALLED_AFTER_MINUTES * 60_000;
    const paused = own.find((t) => t.wakeState === 'paused');
    if (paused) {
      this.o.logger.warn({ taskId: paused.id, wakeState: 'paused' }, 'InboxHeartbeat: inbox-drain wake is paused by an operator; leaving it, no triage until it is resumed');
      return 'drain_running';
    }
    const isLive = (t: (typeof own)[number]): boolean =>
      (t.wakeState !== 'suspended' && (t.nextWakeAt !== null || t.wakeState !== null)) ||
      new Date(t.updatedAt).getTime() > staleBefore;
    if (own.some(isLive)) return 'drain_running';

    // Re-waking with a null originator would erase its system lineage, and leaving it in charge
    // would block triage forever: set it aside (warn once per id) and fall through to a fresh drain.
    for (const t of own) {
      if (!t.originator && !this.ignoredLogged.has(t.id)) {
        this.ignoredLogged.add(t.id);
        this.o.logger.warn({ taskId: t.id }, 'InboxHeartbeat: stalled inbox-drain task has no stored originator; setting it aside and creating a fresh drain');
      }
    }
    const stalled = own.find((t) => t.originator);
    if (stalled?.originator) {
      if (stalled.wakeState === 'suspended') {
        this.o.logger.warn({ taskId: stalled.id, wakeState: 'suspended' }, 'InboxHeartbeat: re-waking an inbox-drain task whose wake was suspended');
      }
      await this.o.scheduler.enqueueTaskWake({ taskId: stalled.id, agentId: INBOX_AGENT, runAt: now, originator: stalled.originator });
      this.o.logger.info({ taskId: stalled.id }, 'InboxHeartbeat: re-woke a stalled inbox-drain task');
      return 'woke';
    }

    const task = await this.o.taskRepo.createTask({
      agentId: INBOX_AGENT,
      title: 'Inbox drain',
      description: INBOX_DRAIN_INTENT,
      intentAnchor: INBOX_DRAIN_INTENT,
      tags: [INBOX_DRAIN_TAG],
      wakeAt: now,
      createdBy: 'heartbeat',
      originator: makeSystemOriginator(),
    });
    this.o.logger.info({ taskId: task.id, due }, 'InboxHeartbeat: created an inbox-drain task');
    return 'woke';
  }
}
