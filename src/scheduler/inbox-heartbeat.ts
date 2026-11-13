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
//   live    = a wake is running or retrying, a pending wake is due within STALLED_AFTER_MINUTES,
//             or the task was updated that recently (a run is about to re-arm it). A live drain
//             owns the inbox: do nothing ('drain_running'; warn after an hour of such ticks).
//   far     = a pending wake later than that (R64): only a task-update, possibly injected by
//             mail, sets one. It is pulled in to now (pullTaskWakeIn), never trusted.
//   stalled = no such wake and no update for STALLED_AFTER_MINUTES: re-wake the task in place with
//             enqueueTaskWake. Never create a second drain task while one is open.
//   suspended = the scheduler's circuit breaker stopped the wake (R67). It is NOT re-woken; it
//             stays in charge and the principal_mailbox_triage health check fails.
//   held    = a `paused` wake is an operator's deliberate hold. It is left alone (warn), and
//             counts as the drain being in charge: no wake, no second task.
// Every drain the heartbeat CREATES is stamped with the system originator, as the old declarative
// cron was, so its autonomous sends pass the outbound gateway's origin check
// (isAutonomousSendOrigin). The heartbeat only considers drain tasks it created itself
// (createdBy 'heartbeat', filtered in the query); an `inbox-drain` task the agent made (possibly
// during an outsider-originated turn) is ignored: it neither blocks a heartbeat drain nor is
// re-woken, and a re-wake passes the task's STORED originator, never an upgrade (R56).
// A stalled own task with NO stored originator (pre-lineage rows) cannot be re-woken without
// erasing its lineage, so it is closed (RR-M1; set aside, warned once, if closing fails) and,
// when no other own task can be re-woken, a fresh system-originated drain is created in its place.
const HEARTBEAT_CREATED_BY = 'heartbeat';
import type { Logger } from '../logger.js';
import type { TaskListRow, TaskRepo } from '../db/task-repo.js';
import type { SchedulerService } from './scheduler-service.js';
import type { PrincipalMailboxes } from '../principal-mailboxes/service.js';
import { TRIAGE_DAILY_CEILING, type Cadence } from '../principal-mailboxes/triage-cadence.js';
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

export type InboxHeartbeatResult = 'woke' | 'quiet' | 'drain_running' | 'drain_suspended' | 'ceiling';
/** Consecutive drain_running ticks (an hour) after which the heartbeat warns (R64). */
export const DRAIN_RUNNING_WARN_TICKS = 4;
/** A tick older than this means the heartbeat stopped working (R67). */
export const TICK_STALE_MINUTES = 45;
/** Consecutive failing probes (an hour of ticks) after which a mailbox fails the health check. */
export const PROBE_FAILURE_TICKS = 4;
/** Consecutive triage calls without progress after which a mailbox is backed off to its next slot. */
export const NO_PROGRESS_DRAINS = 4;

export interface InboxHeartbeatOptions {
  mailboxes: Pick<PrincipalMailboxes, 'list'>;
  /** Cadences for the given live mailbox ids (read fresh each tick). */
  cadences: (mailboxIds: string[]) => Promise<Record<string, Cadence>>;
  state: TriageState;
  /** True when the mailbox has unread mail (received after `since` when set). May throw. */
  hasUnreadSince: (mailboxId: string, since: Date | null) => Promise<boolean>;
  taskRepo: Pick<TaskRepo, 'listTasks' | 'createTask' | 'completeTask'>;
  scheduler: Pick<SchedulerService, 'enqueueTaskWake' | 'pullTaskWakeIn'>;
  tz: () => string;
  logger: Logger;
  intervalMinutes?: number;
  /**
   * Tells the principal that triage paused for the day at the ceiling (R67). Called once per
   * local day; false (not sent) is retried on the next tick. Absent: logged only.
   */
  notifyCeiling?: (batches: number) => Promise<boolean>;
  /** Deletes expired cross-mailbox dedupe rows; run once per local day (BR-M1, SEC-L6). */
  sweepDedupe?: () => Promise<number>;
  /** Delay of the one tick run shortly after start (default 60 s), so a restart does not wait a full interval. */
  bootTickDelayMs?: number;
}

/** Health of the triage heartbeat, for the principal_mailbox_triage check (R67). */
export interface InboxTriageHealth {
  ok: boolean;
  /** Why it fails; absent when ok. */
  detail?: string;
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
  private timers: NodeJS.Timeout[] = [];
  private started = false;
  private startedAt: Date | null = null;
  private lastTickOkAt: Date | null = null;
  // Consecutive failed probes per mailbox, reset by a probe that answers.
  private readonly probeFailures = new Map<string, number>();
  // Mailboxes at or past NO_PROGRESS_DRAINS, as of the last tick that read them.
  private readonly stuck = new Set<string>();
  // The no-progress count a mailbox was last backed off at, so it gets one try per slot.
  private readonly backedOffAt = new Map<string, number>();
  // The local day the dedupe sweep last ran.
  private sweptDay: string | null = null;
  // The local day an unsent ceiling notice was last logged as an error.
  private noticeErrorDay: string | null = null;
  // A slow tick (Nylas probes) must not overlap the next interval fire.
  private tickInFlight = false;
  // Set-aside drain task ids already warned about, so the 15-minute tick does not repeat the line.
  private readonly ignoredLogged = new Set<string>();
  // Suspended drain ids already logged, and the one in charge now (null when none).
  private readonly suspendedLogged = new Set<string>();
  private suspendedDrain: string | null = null;
  // Consecutive ticks that found the drain running (R64).
  private drainRunningTicks = 0;

  constructor(private readonly o: InboxHeartbeatOptions) {}

  /**
   * Ticks on the wall-clock grid (:00, :15, :30, :45 for 15 minutes), so a window end such as
   * 23:00 gets its tick (BR-M6), plus one tick shortly after start so a restart does not wait a
   * whole interval (SF-M9). An overlapping fire is skipped while a tick is in flight.
   */
  start(now: Date = new Date()): void {
    if (this.started) return;
    this.started = true;
    this.startedAt = now;
    const minutes = this.o.intervalMinutes ?? 15;
    const intervalMs = minutes * 60_000;
    const run = (): void => {
      if (this.tickInFlight) {
        this.o.logger.warn('InboxHeartbeat: previous tick still in flight; skipping this interval');
        return;
      }
      this.tickInFlight = true;
      this.tick()
        .catch((err) => {
          this.o.logger.error({ ...grantSafeErrorFields(err) }, 'InboxHeartbeat: unhandled error in tick');
        })
        .finally(() => {
          this.tickInFlight = false;
        });
    };
    const toGrid = intervalMs - (now.getTime() % intervalMs);
    this.timers.push(setTimeout(run, this.o.bootTickDelayMs ?? 60_000));
    this.timers.push(setTimeout(() => {
      run();
      this.intervalHandle = setInterval(run, intervalMs);
    }, toGrid));
    this.o.logger.info({ intervalMinutes: minutes, firstGridTickInMs: toGrid }, 'InboxHeartbeat started');
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.started = false;
    this.o.logger.info('InboxHeartbeat stopped');
  }

  /**
   * The principal_mailbox_triage health check (R67). Fails when no tick has succeeded for
   * TICK_STALE_MINUTES (counted from start), a mailbox's probe has failed PROBE_FAILURE_TICKS
   * ticks running, a mailbox has made no progress for NO_PROGRESS_DRAINS triage calls, or the
   * drain's wake is suspended by the scheduler's circuit breaker.
   */
  health(now: Date = new Date()): InboxTriageHealth {
    const problems: string[] = [];
    const last = this.lastTickOkAt ?? this.startedAt;
    if (last && now.getTime() - last.getTime() > TICK_STALE_MINUTES * 60_000) {
      problems.push(`no successful inbox triage check since ${last.toISOString()}`);
    }
    const probing = [...this.probeFailures].filter(([, n]) => n >= PROBE_FAILURE_TICKS).map(([id]) => id);
    if (probing.length > 0) problems.push(`unread check failing for ${probing.join(', ')}`);
    if (this.stuck.size > 0) problems.push(`triage making no progress for ${[...this.stuck].join(', ')}`);
    if (this.suspendedDrain) problems.push('the inbox drain was suspended after repeated failures; resume it in the console');
    return problems.length > 0 ? { ok: false, detail: problems.join('; ') } : { ok: true };
  }

  /** The drain task whose wake the circuit breaker suspended, as of the last tick that looked; null when none. */
  suspendedDrainTaskId(): string | null {
    return this.suspendedDrain;
  }

  /** A drain_running tick: counted, and warned about once an hour of them has passed (R64). */
  private drainRunning(): InboxHeartbeatResult {
    this.drainRunningTicks += 1;
    if (this.drainRunningTicks === DRAIN_RUNNING_WARN_TICKS) {
      this.o.logger.warn({ ticks: this.drainRunningTicks }, 'InboxHeartbeat: the inbox drain has been running for an hour of ticks');
    }
    return 'drain_running';
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

  /**
   * How a drain task stands (R64). `live`: a wake is running or retrying, a pending wake is due
   * within STALLED_AFTER_MINUTES, or the task was touched that recently. `far`: its pending wake
   * is later than that, which only a (possibly injected) task-update produces. `stalled`: neither.
   */
  private liveness(t: TaskListRow, now: Date): 'live' | 'far' | 'stalled' {
    if (t.wakeState === 'running' || t.wakeState === 'retrying') return 'live';
    const soon = now.getTime() + STALLED_AFTER_MINUTES * 60_000;
    if (t.nextWakeAt !== null && t.wakeState !== 'suspended') {
      return new Date(t.nextWakeAt).getTime() <= soon ? 'live' : 'far';
    }
    if (t.wakeState === 'pending') return 'live';
    return new Date(t.updatedAt).getTime() > now.getTime() - STALLED_AFTER_MINUTES * 60_000 ? 'live' : 'stalled';
  }

  async tick(now: Date = new Date()): Promise<InboxHeartbeatResult> {
    const result = await this.tickOnce(now);
    this.lastTickOkAt = now;
    if (result !== 'drain_running') this.drainRunningTicks = 0;
    return result;
  }

  /**
   * The ceiling stops triage until local midnight and no drain runs to report it, so code tells
   * the principal, once a local day (R67, SEC-L9). Recorded only once sent; a failure is logged
   * and retried on the next tick.
   */
  private async noticeCeiling(now: Date): Promise<void> {
    if (await this.o.state.ceilingNotified(now)) return;
    const batches = await this.o.state.batchesToday(now);
    this.o.logger.warn({ batches, dailyCeiling: TRIAGE_DAILY_CEILING }, 'InboxHeartbeat: inbox triage paused for the rest of the day at the batch ceiling');
    if (!this.o.notifyCeiling) return;
    try {
      if (await this.o.notifyCeiling(batches)) {
        await this.o.state.setCeilingNotified(now);
        return;
      }
      this.noticeFailedOnce(now, {}, 'InboxHeartbeat: the triage-paused notice could not be sent; retrying each tick');
    } catch (err) {
      this.noticeFailedOnce(now, { ...grantSafeErrorFields(err) }, 'InboxHeartbeat: the triage-paused notice failed; retrying each tick');
    }
  }

  /** The unsent-notice error, at most once a local day (re-review M3); the send is still retried. */
  private noticeFailedOnce(now: Date, fields: Record<string, unknown>, msg: string): void {
    const day = this.o.state.localDay(now);
    if (this.noticeErrorDay === day) return;
    this.noticeErrorDay = day;
    this.o.logger.error(fields, msg);
  }

  /** Expired dedupe rows are swept on the first tick of each local day; a failure retries next tick. */
  private async sweepOncePerDay(now: Date): Promise<void> {
    if (!this.o.sweepDedupe) return;
    const day = this.o.state.localDay(now);
    if (this.sweptDay === day) return;
    try {
      const removed = await this.o.sweepDedupe();
      this.sweptDay = day;
      this.o.logger.info({ removed }, 'InboxHeartbeat: swept expired cross-mailbox dedupe rows');
    } catch (err) {
      this.o.logger.error({ ...grantSafeErrorFields(err) }, 'InboxHeartbeat: the dedupe sweep failed; retrying next tick');
    }
  }

  private async tickOnce(now: Date): Promise<InboxHeartbeatResult> {
    // TriageState gates on TRIAGE_DAILY_CEILING, the one value the list tool also reads (BR-M2).
    await this.sweepOncePerDay(now);
    const atCeiling = await this.o.state.ceilingReached(now);

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

    // Health signals are refreshed on every tick, the ceiling included (re-review M2), so a resumed
    // drain or a recovered mailbox clears the check without waiting for due mail.
    // Forget counters of mailboxes that are no longer live.
    for (const id of [...this.probeFailures.keys()]) if (!ids.includes(id)) this.probeFailures.delete(id);
    this.stuck.clear();
    for (const id of ids) if ((await this.o.state.noProgress(id)) >= NO_PROGRESS_DRAINS) this.stuck.add(id);
    this.suspendedDrain = (await ownOpenDrains()).find((t) => t.wakeState === 'suspended')?.id ?? null;

    if (atCeiling) {
      this.o.logger.info({ dailyCeiling: TRIAGE_DAILY_CEILING }, 'InboxHeartbeat: daily batch ceiling reached; not waking triage');
      await this.noticeCeiling(now);
      return 'ceiling';
    }

    const due = await dueMailboxes({
      mailboxIds: ids,
      cadences: await this.o.cadences(ids),
      state: this.o.state,
      now,
      tz: this.o.tz(),
    });

    // R67: a mailbox whose triage made no progress NO_PROGRESS_DRAINS calls running is backed off
    // to its next cadence slot instead of being woken every tick; it gets one try per slot, and
    // stays failing in the health check until a call makes progress.
    const toProbe: string[] = [];
    for (const id of due) {
      const n = await this.o.state.noProgress(id);
      if (n >= NO_PROGRESS_DRAINS && this.backedOffAt.get(id) !== n) {
        this.backedOffAt.set(id, n);
        await this.o.state.backOff(id, now);
        this.o.logger.warn({ mailboxId: id, noProgress: n }, 'InboxHeartbeat: triage of this mailbox keeps making no progress; skipping it until its next cadence slot');
        continue;
      }
      toProbe.push(id);
    }
    if (toProbe.length === 0) return 'quiet';

    const startById = new Map(mailboxes.map((m) => [m.id, m.triageStartAt]));
    let failed = 0;
    let hasMail = false;
    for (const id of toProbe) {
      try {
        const has = await this.o.hasUnreadSince(id, startById.get(id) ?? null);
        if ((this.probeFailures.get(id) ?? 0) >= PROBE_FAILURE_TICKS) this.o.logger.info({ mailboxId: id }, 'InboxHeartbeat: unread check recovered');
        this.probeFailures.delete(id);
        if (has) {
          hasMail = true;
          break;
        }
      } catch (err) {
        // A failed probe counts as "no mail" for this tick. Grant-safe: SDK errors can carry the grant id.
        failed += 1;
        const n = (this.probeFailures.get(id) ?? 0) + 1;
        this.probeFailures.set(id, n);
        const level = n === PROBE_FAILURE_TICKS ? 'error' : 'warn';
        this.o.logger[level]({ mailboxId: id, consecutive: n, ...grantSafeErrorFields(err) }, 'InboxHeartbeat: unread probe failed; treating as no mail this tick');
      }
    }
    if (!hasMail) {
      if (failed === toProbe.length) {
        this.o.logger.warn({ failed, due: toProbe.length }, 'InboxHeartbeat: every due mailbox probe failed; no triage this tick');
      }
      return 'quiet';
    }

    // Only the heartbeat's own tasks are fetched (R56), so foreign inbox-drain tasks cannot push
    // its own out of the page. The createdBy check below repeats the filter defensively.
    const own = await ownOpenDrains();

    const paused = own.find((t) => t.wakeState === 'paused');
    if (paused) {
      this.o.logger.warn({ taskId: paused.id, wakeState: 'paused' }, 'InboxHeartbeat: inbox-drain wake is paused by an operator; leaving it, no triage until it is resumed');
      return 'drain_running';
    }
    // R67: a wake the scheduler's circuit breaker suspended is NOT re-woken: reviving it would
    // re-fail and re-notify every half hour. It stays in charge (no second drain) and the
    // principal_mailbox_triage health check fails until an operator resumes or closes it.
    const suspended = own.find((t) => t.wakeState === 'suspended');
    if (suspended) {
      if (!this.suspendedLogged.has(suspended.id)) {
        this.suspendedLogged.add(suspended.id);
        this.o.logger.error({ taskId: suspended.id, wakeState: 'suspended' }, 'InboxHeartbeat: the inbox-drain wake was suspended after repeated failures; not re-waking it, inbox triage is stopped until it is resumed');
      }
      return 'drain_suspended';
    }

    const classes = own.map((t) => ({ t, kind: this.liveness(t, now) }));
    if (classes.some((c) => c.kind === 'live')) return this.drainRunning();
    // R64: a pending wake far in the future (an injected task-update can push it out) does not
    // count as live: pull it in to now rather than letting it park triage.
    const far = classes.find((c) => c.kind === 'far');
    if (far) {
      const moved = await this.o.scheduler.pullTaskWakeIn(far.t.id, now);
      this.o.logger.warn({ taskId: far.t.id, nextWakeAt: far.t.nextWakeAt, moved }, 'InboxHeartbeat: the inbox-drain wake was set far out; pulled it in to now');
      // A wake the pull cannot move still parks triage: it counts toward the warning (re-review M1).
      return moved ? 'woke' : this.drainRunning();
    }

    // Re-waking with a null originator would erase its system lineage, and leaving it in charge
    // would block triage forever: close it (RR-M1) and fall through to a fresh drain.
    for (const { t, kind } of classes) {
      if (t.originator || kind !== 'stalled') continue;
      try {
        await this.o.taskRepo.completeTask(t.id, 'closed by the inbox heartbeat: no stored originator to re-wake it with (#2475)');
        this.o.logger.warn({ taskId: t.id }, 'InboxHeartbeat: closed a stalled inbox-drain task with no stored originator; creating a fresh drain');
      } catch (err) {
        if (!this.ignoredLogged.has(t.id)) {
          this.ignoredLogged.add(t.id);
          this.o.logger.warn({ taskId: t.id, ...grantSafeErrorFields(err) }, 'InboxHeartbeat: stalled inbox-drain task has no stored originator and could not be closed; setting it aside');
        }
      }
    }
    const stalled = classes.find((c) => c.t.originator && c.kind === 'stalled')?.t;
    if (stalled?.originator) {
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
