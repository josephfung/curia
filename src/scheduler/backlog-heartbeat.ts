import type { Pool } from 'pg';
import type { Logger } from '../logger.js';
import type { SchedulerService } from './scheduler-service.js';
import { selectHeartbeatCandidates } from '../db/queries/tasks.js';

export interface BacklogHeartbeatOptions {
  pool: Pool;
  logger: Logger;
  schedulerService: SchedulerService;
  /** Heartbeat-eligible agent names (enable_task_management: true). */
  eligibleAgents: Set<string>;
  intervalMinutes: number;
  maxWakesPerTick: number;
  idleThresholdHours: number;
  staleWaitThresholdHours: number;
  /** Wake target for null / non-eligible owners. Default 'coordinator'. */
  fallbackAgentId?: string;
}

/** System-layer component: on an hourly interval, selects idle/stale tasks and
 *  enqueues one-shot wakes routed to each owning agent. Deterministic; does no
 *  domain reasoning. The conductor, never an instrument. */
export class BacklogHeartbeat {
  private intervalHandle: NodeJS.Timeout | null = null;
  // Prevents a slow tick from overlapping with the next interval fire.
  private tickInFlight = false;

  constructor(private readonly opts: BacklogHeartbeatOptions) {}

  start(): void {
    if (this.intervalHandle) return;
    const ms = this.opts.intervalMinutes * 60_000;
    this.intervalHandle = setInterval(() => {
      if (this.tickInFlight) {
        this.opts.logger.warn('BacklogHeartbeat: previous tick still in flight — skipping this interval');
        return;
      }
      this.tickInFlight = true;
      this.tick()
        .catch((err) => {
          this.opts.logger.error({ err }, 'BacklogHeartbeat: unhandled error in tick');
        })
        .finally(() => {
          this.tickInFlight = false;
        });
    }, ms);
    this.opts.logger.info({ intervalMinutes: this.opts.intervalMinutes }, 'BacklogHeartbeat started');
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.opts.logger.info('BacklogHeartbeat stopped');
  }

  /** One tick: select candidates and enqueue a wake for each. Returns the number
   *  of wakes successfully enqueued. */
  async tick(): Promise<number> {
    let candidates;
    try {
      candidates = await selectHeartbeatCandidates(this.opts.pool, {
        eligibleAgents: [...this.opts.eligibleAgents],
        idleThresholdHours: this.opts.idleThresholdHours,
        staleWaitThresholdHours: this.opts.staleWaitThresholdHours,
        maxWakes: this.opts.maxWakesPerTick,
        fallbackAgentId: this.opts.fallbackAgentId ?? 'coordinator',
      });
    } catch (err) {
      this.opts.logger.error({ err }, 'BacklogHeartbeat: candidate selection query failed — skipping tick');
      return 0;
    }
    if (candidates.length === 0) return 0;

    const runAt = new Date();
    let enqueued = 0;
    let taskGoneSkips = 0; // 23503 — task terminal/deleted between selection and enqueue
    let raceSkips = 0; // 23505 — another enqueuer already holds this task's active wake
    let hardFailures = 0; // anything else — a real problem
    for (const c of candidates) {
      try {
        const { jobId } = await this.opts.schedulerService.enqueueTaskWake({
          taskId: c.id,
          agentId: c.agentId,
          runAt,
          // Thread the task's lineage + derived flag (#1125) so the woken task fires with
          // provenance and the bypass ladder can compute effective standing at invocation.
          originator: c.originator,
          derived: c.derived,
        });
        this.opts.logger.debug({ taskId: c.id, agentId: c.agentId, jobId }, 'BacklogHeartbeat: wake enqueued');
        enqueued += 1;
      } catch (err) {
        // Guard against a thrown null/undefined (optional chaining) so error classification
        // can never itself throw and abort the tick mid-loop.
        const e = err as { code?: string; constraint?: string } | null;
        if (e?.code === '23503') {
          // foreign_key_violation: task completed/deleted between selection and enqueue — benign.
          taskGoneSkips += 1;
          this.opts.logger.debug({ taskId: c.id, agentId: c.agentId }, 'BacklogHeartbeat: task gone at enqueue time — skipped');
        } else if (e?.code === '23505' && e?.constraint === 'scheduled_jobs_one_active_wake_per_task_uq') {
          // unique_violation on the one-active-wake index: another enqueuer (plan-frontier /
          // resumable-continuation) won the race for this task's wake — benign. Tracked
          // separately (not folded into 23503) because within the heartbeat's own path this
          // should be near-zero: selectHeartbeatCandidates already excludes active-wake tasks.
          // A sustained count means the suppression clause regressed and the flood (#1410) is
          // recurring — surfaced at warn below so it is not silently swallowed.
          raceSkips += 1;
          this.opts.logger.debug({ taskId: c.id, agentId: c.agentId }, 'BacklogHeartbeat: task already has an active wake — skipped (race)');
        } else {
          hardFailures += 1;
          this.opts.logger.error({ err, taskId: c.id, agentId: c.agentId }, 'BacklogHeartbeat: failed to enqueue wake');
        }
      }
    }
    this.opts.logger.info({ enqueued, considered: candidates.length, taskGoneSkips, raceSkips, hardFailures }, 'BacklogHeartbeat: tick complete');
    if (raceSkips > 0) {
      this.opts.logger.warn(
        { raceSkips, considered: candidates.length },
        'BacklogHeartbeat: enqueue hit the one-active-wake index — expected near-zero; investigate candidate suppression (#1410) if sustained',
      );
    }
    // Only alarm when real (non-benign) failures blocked all progress — a tick where every
    // candidate was a benign task-gone/race skip is healthy, not a stuck scheduler.
    if (enqueued === 0 && hardFailures > 0) {
      this.opts.logger.error(
        { considered: candidates.length, hardFailures },
        'BacklogHeartbeat: all wake enqueues failed — tasks will not advance until next tick',
      );
    }
    return enqueued;
  }
}
