// approval-expiry-sweep.ts — expires stale pending approvals on a system interval (#2013).
//
// Finds every pending_approval row whose expires_at has passed, batch-transitions them to
// 'expired', and queues one principal.report digest item per expired row (#2159). Expiry
// used to send a batched email for high/critical rows; it is digest material, not an alert,
// and every expiry — whatever its risk — is worth one line in the digest.
//
// This used to be the approval-expiry-sweep skill, fired by an hourly cron on the coordinator.
// Nothing here needs a model, and each of those runs was a full coordinator turn: ~720 a month
// at the coordinator's whole context, with human-channel send tools pinned (#1609 was one of
// these runs posting an unrelated bullpen reply to the principal's Signal). As a system
// interval it is a pair of queries and a publish per expired row.
//
// Shaped like LateDelegationSweep and BacklogHeartbeat: an interval with an in-flight guard,
// and a tick() that is safe to call directly from tests.
//
// A failed publish is logged at error naming the row and does not stop the others: expiry has
// already committed and the row will not come back. A repository failure rejects tick(); the
// interval wrapper logs it at error and the next interval runs as normal.

import type { Logger } from '../logger.js';
import type { EventBus } from '../bus/bus.js';
import { createPrincipalReport } from '../bus/events.js';
import type { ActionLogRepo } from './action-log-repo.js';
import type { ActionLogRow } from './action-log-types.js';

export interface ApprovalExpirySweepOptions {
  actionLogRepo: Pick<ActionLogRepo, 'findExpired' | 'expireRows'>;
  bus: Pick<EventBus, 'publish'>;
  logger: Logger;
  intervalMinutes: number;
}

export interface ApprovalExpirySweepResult {
  /** Rows actually transitioned to expired this tick. */
  expired: number;
  /** Expired rows queued for the principal's digest. */
  notified: number;
}

// Delay before the first tick after start(). The cron this replaced fired on the wall clock, so
// a restart never postponed it; a bare setInterval would push every sweep a full interval past
// each boot, and a process restarting more often than the interval would never sweep at all.
// Short enough to cover that, long enough to stay out of the boot-time burst.
const FIRST_TICK_DELAY_MS = 60_000;

export class ApprovalExpirySweep {
  private intervalHandle: NodeJS.Timeout | null = null;
  private firstTickHandle: NodeJS.Timeout | null = null;
  private tickInFlight = false;
  // Surfaced in the error log so a sweep broken on every tick (schema drift, permissions)
  // reads as a streak rather than an identical line each hour.
  private consecutiveFailures = 0;

  constructor(private readonly opts: ApprovalExpirySweepOptions) {}

  start(): void {
    if (this.intervalHandle) return;
    this.firstTickHandle = setTimeout(() => {
      this.firstTickHandle = null;
      this.runGuardedTick();
    }, FIRST_TICK_DELAY_MS);
    this.intervalHandle = setInterval(() => this.runGuardedTick(), this.opts.intervalMinutes * 60_000);
    this.opts.logger.info({ intervalMinutes: this.opts.intervalMinutes }, 'ApprovalExpirySweep started');
  }

  stop(): void {
    if (this.firstTickHandle) {
      clearTimeout(this.firstTickHandle);
      this.firstTickHandle = null;
    }
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.opts.logger.info('ApprovalExpirySweep stopped');
  }

  /** Timer entry point: skips while a tick is running, and never lets a failure escape. */
  private runGuardedTick(): void {
    if (this.tickInFlight) {
      this.opts.logger.warn('ApprovalExpirySweep: previous tick still in flight — skipping this interval');
      return;
    }
    this.tickInFlight = true;
    this.tick()
      .then(() => {
        this.consecutiveFailures = 0;
      })
      .catch((err: unknown) => {
        this.consecutiveFailures += 1;
        this.opts.logger.error(
          { err, consecutiveFailures: this.consecutiveFailures },
          'ApprovalExpirySweep: tick failed — will retry next interval',
        );
      })
      .finally(() => {
        this.tickInFlight = false;
      });
  }

  /** One pass: expire stale approvals and queue a digest item for each. */
  async tick(): Promise<ApprovalExpirySweepResult> {
    const expired: ActionLogRow[] = await this.opts.actionLogRepo.findExpired();
    if (expired.length === 0) {
      this.opts.logger.debug('ApprovalExpirySweep: nothing to expire');
      return { expired: 0, notified: 0 };
    }

    // expireRows() uses WHERE outcome = 'pending_approval' ... RETURNING *, so a row resolved
    // between findExpired() and here is absent from the result. Log and notify only from what
    // actually expired, never from the candidate set.
    const actuallyExpired = await this.opts.actionLogRepo.expireRows(expired.map((r) => r.id));
    if (actuallyExpired.length < expired.length) {
      this.opts.logger.warn(
        { found: expired.length, actuallyExpired: actuallyExpired.length },
        'ApprovalExpirySweep: fewer rows expired than found — some may have been concurrently resolved',
      );
    }
    for (const r of actuallyExpired) {
      this.opts.logger.info(
        { id: r.id, shortRef: r.shortRef, toolName: r.toolName, actionRisk: r.actionRisk },
        'ApprovalExpirySweep: row expired',
      );
    }

    const notified = await this.queueReports(actuallyExpired);

    const result = { expired: actuallyExpired.length, notified };
    this.opts.logger.info(result, 'ApprovalExpirySweep tick complete');
    return result;
  }

  /** Queue one digest item per expired row. Returns how many were queued. */
  private async queueReports(rows: ActionLogRow[]): Promise<number> {
    let queued = 0;
    for (const r of rows) {
      try {
        await this.opts.bus.publish('system', createPrincipalReport({
          summary: `Approval expired without an answer: ${r.description ?? r.toolName}`,
          urgency: 'digest',
          source: 'approval_expired',
          ...(r.shortRef ? { actionShortRef: r.shortRef } : {}),
          // The task that raised the approval, so the item threads back to its cause.
          parentEventId: r.taskId,
          sourceLayer: 'system',
        }));
        queued += 1;
      } catch (err) {
        this.opts.logger.error(
          { err, id: r.id, shortRef: r.shortRef },
          'ApprovalExpirySweep: failed to queue the expiry report — the row is expired; this log is its only notice',
        );
      }
    }
    return queued;
  }
}
