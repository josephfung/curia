// approval-expiry-sweep.ts — expires stale pending approvals on a system interval (#2013).
//
// Finds every pending_approval row whose expires_at has passed, batch-transitions them to
// 'expired', and sends one batched email to the principal for any high/critical expirations.
//
// This used to be the approval-expiry-sweep skill, fired by an hourly cron on the coordinator.
// Nothing here needs a model, and each of those runs was a full coordinator turn: ~720 a month
// at the coordinator's whole context, with human-channel send tools pinned (#1609 was one of
// these runs posting an unrelated bullpen reply to the principal's Signal). As a system
// interval it is a pair of queries and, rarely, one notification.
//
// Shaped like LateDelegationSweep and BacklogHeartbeat: an interval with an in-flight guard,
// and a tick() that is safe to call directly from tests.
//
// Non-fatal on the notification path — expiry has already committed by then, so:
//   - no principal email on file  → notification skipped, logged at warn
//   - outboundGateway absent      → notification skipped, logged at warn
//   - sendNotification() false    → logged at warn
// A repository failure rejects tick(); the interval wrapper logs it at error and the next
// interval runs as normal.

import type { Logger } from '../logger.js';
import type { OutboundGateway } from '../skills/outbound-gateway.js';
import { resolvePrincipalEmail, type PrincipalEmailRef } from '../contacts/types.js';
import type { ActionLogRepo } from './action-log-repo.js';
import type { ActionLogRow } from './action-log-types.js';

export interface ApprovalExpirySweepOptions {
  actionLogRepo: Pick<ActionLogRepo, 'findExpired' | 'expireRows'>;
  /** Absent in setup-required mode or with no outbound client — expiry still runs. */
  outboundGateway?: Pick<OutboundGateway, 'sendNotification'>;
  /** Plain string (tests) or the live ref, so a post-boot email bind takes effect (#1514). */
  ceoEmail: string | PrincipalEmailRef;
  logger: Logger;
  intervalMinutes: number;
}

export interface ApprovalExpirySweepResult {
  /** Rows actually transitioned to expired this tick. */
  expired: number;
  /** High/critical rows included in a notification that was handed to the gateway. */
  notified: number;
}

// Tiers that warrant a principal notification on expiry. 'none', 'low' and 'medium'
// expirations are recorded in the log but not surfaced as alerts — they are low-stakes
// actions the principal didn't need to weigh in on urgently.
const NOTIFIABLE_TIERS = new Set(['high', 'critical']);

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

  /** One pass: expire stale approvals and notify about high/critical ones. */
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

    const notifiable = actuallyExpired.filter((r) => NOTIFIABLE_TIERS.has(r.actionRisk));
    const notified = notifiable.length > 0 ? await this.notify(notifiable) : 0;

    const result = { expired: actuallyExpired.length, notified };
    this.opts.logger.info(result, 'ApprovalExpirySweep tick complete');
    return result;
  }

  /** Send the batched principal notification. Returns how many rows it covered (0 if skipped). */
  private async notify(rows: ActionLogRow[]): Promise<number> {
    const { outboundGateway, logger } = this.opts;
    // Expiry has committed and findExpired() won't return these rows again, so a skipped alert
    // is not retried. Name the rows in every skip log so an operator can follow up by hand.
    const skipped = {
      notifiableCount: rows.length,
      ids: rows.map((r) => r.id),
      shortRefs: rows.map((r) => r.shortRef),
    };
    if (!outboundGateway) {
      logger.warn(
        skipped,
        'ApprovalExpirySweep: outboundGateway not available — skipping expiry notification for high/critical rows',
      );
      return 0;
    }

    // Read at tick time: the ref is refreshed in place when the principal's identities change.
    // It already holds only a verified + active address (readPrincipalIdentitySnapshot), so a
    // defunct or bounced address never receives this.
    const ceoEmail = resolvePrincipalEmail(this.opts.ceoEmail);
    if (!ceoEmail) {
      logger.warn(
        skipped,
        'ApprovalExpirySweep: no principal email on file — skipping expiry notification',
      );
      return 0;
    }

    // One line per request so the principal can scan quickly. shortRef and description
    // are nullable — fall back to readable placeholders.
    const body = rows
      .map((r) => `• ${r.shortRef ?? '(no ref)'}: ${r.description ?? '(no description)'} [${r.toolName}]`)
      .join('\n');
    const sent = await outboundGateway.sendNotification({
      notificationType: 'approval_expired',
      ceoEmail,
      subject: `Approval expired — ${rows.length} request(s) expired without response`,
      body,
    });
    if (!sent) {
      // The rows are already expired and logged above; only the alert is lost this cycle.
      logger.warn(
        skipped,
        'ApprovalExpirySweep: sendNotification returned false — principal notification not delivered (expiry committed)',
      );
      return 0;
    }
    return rows.length;
  }
}
