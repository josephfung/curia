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

  constructor(private readonly opts: BacklogHeartbeatOptions) {}

  start(): void {
    if (this.intervalHandle) return;
    const ms = this.opts.intervalMinutes * 60_000;
    this.intervalHandle = setInterval(() => {
      this.tick().catch((err) => {
        this.opts.logger.error({ err }, 'BacklogHeartbeat: unhandled error in tick');
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
    const candidates = await selectHeartbeatCandidates(this.opts.pool, {
      eligibleAgents: [...this.opts.eligibleAgents],
      idleThresholdHours: this.opts.idleThresholdHours,
      staleWaitThresholdHours: this.opts.staleWaitThresholdHours,
      maxWakes: this.opts.maxWakesPerTick,
      fallbackAgentId: this.opts.fallbackAgentId ?? 'coordinator',
    });
    if (candidates.length === 0) return 0;

    const runAt = new Date();
    let enqueued = 0;
    for (const c of candidates) {
      try {
        await this.opts.schedulerService.enqueueTaskWake({ taskId: c.id, agentId: c.agentId, runAt });
        enqueued += 1;
      } catch (err) {
        this.opts.logger.error({ err, taskId: c.id, agentId: c.agentId }, 'BacklogHeartbeat: failed to enqueue wake');
      }
    }
    this.opts.logger.info({ enqueued, considered: candidates.length }, 'BacklogHeartbeat: tick complete');
    return enqueued;
  }
}
