// late-delegation-sweep.ts — backstop for pending delegation handles (#1799).
//
// The live subscriber only sees responses published while it is running. Two cases need a
// periodic pass:
//
//   1. Missed responses — the bus is in-process, so a response published while the process was
//      down reached no matcher; so did one that arrived in the gap between the wait timing out
//      and the handle being written (the escalation task-create sits between those two). The
//      audit logger's write-ahead hook persisted it anyway, so audit_log is the durable record.
//   2. Expiry — nothing ever arrives when the specialist died with the process. The handle is
//      abandoned and the review task is corrected, so the backlog stops promising a delivery
//      that will never come.
//   3. Abandoned leases — an actor that crashed (or failed transiently) between claiming a
//      handle and finishing its side effects. listOpenPendingDelegations returns those once the
//      lease expires, and the retry re-does whatever has not already landed. A holder still
//      inside the woken turn refreshes the lease, so that row is not listed (#1861).
//
// Shaped like BacklogHeartbeat: an interval with an in-flight guard, and a tick() that is safe
// to call directly from tests.

import type { Pool } from 'pg';
import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import type { TaskRepo } from '../db/task-repo.js';
import {
  findLateResponseInAuditLog,
  listOpenPendingDelegations,
} from '../db/queries/pending-delegations.js';
import {
  CLAIM_LEASE_SECONDS,
  expireLateDelegation,
  handleLateResponse,
  type LateWakeRoutingRegistrar,
} from './late-delegation.js';

export interface LateDelegationSweepOptions {
  pool: Pool;
  bus: EventBus;
  logger: Logger;
  taskRepo: TaskRepo;
  intervalMinutes: number;
  ttlMinutes: number;
  maxResultChars: number;
  timezone?: string;
  /** Cap on handles examined per tick — open handles are few, this is a runaway guard. */
  maxPerTick?: number;
  /** Registered agent names. An origin agent no longer on the roster is recorded, not woken. */
  knownAgents?: Set<string>;
  /** Seeds dispatcher routing so a woken agent's reply reaches the principal. */
  registerRouting?: LateWakeRoutingRegistrar;
}

export interface LateDelegationSweepResult {
  examined: number;
  /** Handles resolved from a response found in audit_log. */
  recovered: number;
  /** Handles resolved as abandoned because nothing arrived before they expired. */
  abandoned: number;
  /** Handles still open (no response yet, not expired), held by another actor's live lease, or
   *  handed back after a transient failure for a later tick. */
  untouched: number;
}

export class LateDelegationSweep {
  private intervalHandle: NodeJS.Timeout | null = null;
  private tickInFlight = false;

  constructor(private readonly opts: LateDelegationSweepOptions) {}

  start(): void {
    if (this.intervalHandle) return;
    const ms = this.opts.intervalMinutes * 60_000;
    this.intervalHandle = setInterval(() => {
      if (this.tickInFlight) {
        this.opts.logger.warn('LateDelegationSweep: previous tick still in flight — skipping this interval');
        return;
      }
      this.tickInFlight = true;
      this.tick()
        .catch((err) => {
          this.opts.logger.error({ err }, 'LateDelegationSweep: unhandled error in tick');
        })
        .finally(() => {
          this.tickInFlight = false;
        });
    }, ms);
    this.opts.logger.info(
      { intervalMinutes: this.opts.intervalMinutes, ttlMinutes: this.opts.ttlMinutes },
      'LateDelegationSweep started',
    );
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.opts.logger.info('LateDelegationSweep stopped');
  }

  /** One pass over the open handles. */
  async tick(now: Date = new Date()): Promise<LateDelegationSweepResult> {
    const handles = await listOpenPendingDelegations(
      this.opts.pool,
      CLAIM_LEASE_SECONDS,
      this.opts.maxPerTick ?? 100,
    );
    const result: LateDelegationSweepResult = {
      examined: handles.length,
      recovered: 0,
      abandoned: 0,
      untouched: 0,
    };

    for (const handle of handles) {
      try {
        const late = await findLateResponseInAuditLog(this.opts.pool, handle.delegateEventId);
        if (late) {
          const outcome = await handleLateResponse({
            pool: this.opts.pool,
            bus: this.opts.bus,
            taskRepo: this.opts.taskRepo,
            logger: this.opts.logger,
            handle,
            responsePayload: late.payload,
            responseEventId: late.eventId,
            respondedAt: new Date(late.timestamp),
            maxResultChars: this.opts.maxResultChars,
            ...(this.opts.timezone !== undefined && { timezone: this.opts.timezone }),
            ...(this.opts.knownAgents !== undefined && { knownAgents: this.opts.knownAgents }),
            ...(this.opts.registerRouting !== undefined && { registerRouting: this.opts.registerRouting }),
          });
          if (outcome.resolved) {
            result.recovered += 1;
            this.opts.logger.info(
              {
                delegateEventId: handle.delegateEventId,
                targetAgent: handle.targetAgent,
                resolution: outcome.resolution,
              },
              'LateDelegationSweep: recovered a late response from audit_log',
            );
          } else {
            result.untouched += 1;
          }
          continue;
        }

        if (handle.expiresAt.getTime() <= now.getTime()) {
          const outcome = await expireLateDelegation({
            pool: this.opts.pool,
            bus: this.opts.bus,
            taskRepo: this.opts.taskRepo,
            logger: this.opts.logger,
            handle,
            ttlMinutes: this.opts.ttlMinutes,
            maxResultChars: this.opts.maxResultChars,
          });
          if (outcome.resolved) {
            result.abandoned += 1;
            this.opts.logger.warn(
              { delegateEventId: handle.delegateEventId, targetAgent: handle.targetAgent },
              'LateDelegationSweep: handle expired with no response — delegated work was lost',
            );
          } else {
            result.untouched += 1;
          }
          continue;
        }

        result.untouched += 1;
      } catch (err) {
        // One bad handle must not stop the pass — the rest of the backlog still needs sweeping,
        // and this handle stays open for the next tick.
        result.untouched += 1;
        this.opts.logger.error(
          { err, delegateEventId: handle.delegateEventId },
          'LateDelegationSweep: failed to process a handle — leaving it open for the next tick',
        );
      }
    }

    if (result.recovered > 0 || result.abandoned > 0) {
      this.opts.logger.info(result, 'LateDelegationSweep tick complete');
    } else {
      this.opts.logger.debug(result, 'LateDelegationSweep tick complete');
    }
    return result;
  }
}
