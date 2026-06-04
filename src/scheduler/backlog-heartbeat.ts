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
    for (const c of candidates) {
      try {
        const { jobId } = await this.opts.schedulerService.enqueueTaskWake({ taskId: c.id, agentId: c.agentId, runAt });
        this.opts.logger.debug({ taskId: c.id, agentId: c.agentId, jobId }, 'BacklogHeartbeat: wake enqueued');
        enqueued += 1;
      } catch (err) {
        // 23503 = foreign_key_violation: task was completed/deleted between selection and enqueue — benign race.
        if ((err as { code?: string }).code === '23503') {
          this.opts.logger.debug({ taskId: c.id, agentId: c.agentId }, 'BacklogHeartbeat: task no longer exists at enqueue time — skipped');
        } else {
          this.opts.logger.error({ err, taskId: c.id, agentId: c.agentId }, 'BacklogHeartbeat: failed to enqueue wake');
        }
      }
    }
    this.opts.logger.info({ enqueued, considered: candidates.length }, 'BacklogHeartbeat: tick complete');
    if (enqueued === 0 && candidates.length > 0) {
      this.opts.logger.error(
        { considered: candidates.length },
        'BacklogHeartbeat: all wake enqueues failed — tasks will not advance until next tick',
      );
    }
    return enqueued;
  }
}
