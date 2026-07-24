// availability-monitor.ts — probe Postgres and escalate to the CEO after a
// sustained outage (#1381 / spec 05).
//
// Design:
// - In-memory `downSince` tracker — no DB required to observe the outage.
// - Periodic SELECT 1 probe (default 30s).
// - After continuous unavailability ≥ 5 minutes, attempt CEO notification
//   via OutboundGateway.sendNotification (LLM-free, same pattern as
//   SuspensionNotifier). While the bus audit write still needs Postgres,
//   retries continue each probe until the send succeeds (typically on
//   recovery) so the alert is not lost.
// - One alert per continuous outage episode.

import type { Pool } from 'pg';
import type { Logger } from '../logger.js';
import type { OutboundGateway } from '../skills/outbound-gateway.js';
import {
  resolvePrincipalEmail,
  type PrincipalEmailRef,
} from '../contacts/types.js';
import {
  DEFAULT_DB_ESCALATION_MS,
  DEFAULT_DB_PROBE_INTERVAL_MS,
  isDbUnavailableError,
} from './resilience.js';

export interface DbAvailabilityMonitorConfig {
  pool: Pool;
  logger: Logger;
  /** Optional — without a gateway the monitor still logs; it cannot email. */
  outboundGateway?: OutboundGateway;
  /** Plain string (tests) or live ref so post-boot email binds hot-reload (#1514). */
  ceoEmail?: string | PrincipalEmailRef;
  /** Probe interval. Default 30s. */
  probeIntervalMs?: number;
  /** Continuous-down threshold before CEO escalation. Default 5 min. */
  escalationAfterMs?: number;
  /** Override setInterval/clearInterval for tests. */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  /** Override Date.now for tests. */
  now?: () => number;
}

export interface DbAvailabilitySnapshot {
  available: boolean;
  /** Epoch ms when the current continuous outage began, or null if healthy. */
  downSince: number | null;
  /** True once the escalation threshold was crossed for this outage episode. */
  escalationDue: boolean;
  /** True after a CEO notification was successfully published for this episode. */
  escalated: boolean;
}

export class DbAvailabilityMonitor {
  private readonly log: Logger;
  private readonly probeIntervalMs: number;
  private readonly escalationAfterMs: number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly now: () => number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private downSince: number | null = null;
  private escalationDue = false;
  private escalated = false;
  private probing = false;

  constructor(private readonly config: DbAvailabilityMonitorConfig) {
    this.log = config.logger.child({ component: 'db-availability-monitor' });
    this.probeIntervalMs = config.probeIntervalMs ?? DEFAULT_DB_PROBE_INTERVAL_MS;
    this.escalationAfterMs = config.escalationAfterMs ?? DEFAULT_DB_ESCALATION_MS;
    this.setIntervalFn = config.setIntervalFn ?? setInterval;
    this.clearIntervalFn = config.clearIntervalFn ?? clearInterval;
    this.now = config.now ?? Date.now;
  }

  /** Start periodic probes. Idempotent. */
  start(): void {
    if (this.timer !== null) return;
    this.log.info(
      {
        probeIntervalMs: this.probeIntervalMs,
        escalationAfterMs: this.escalationAfterMs,
      },
      'DbAvailabilityMonitor started',
    );
    // Fire once immediately so a boot-time outage is detected without waiting
    // a full interval; subsequent probes ride the interval timer.
    void this.probe();
    this.timer = this.setIntervalFn(() => {
      void this.probe();
    }, this.probeIntervalMs);
    // Unref so the timer does not keep the process alive during clean shutdown
    // in environments that support it (Node.js Timeout).
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
  }

  /** Stop periodic probes. Idempotent. */
  stop(): void {
    if (this.timer === null) return;
    this.clearIntervalFn(this.timer);
    this.timer = null;
    this.log.info('DbAvailabilityMonitor stopped');
  }

  /** Current in-memory snapshot — useful for tests and health introspection. */
  getSnapshot(): DbAvailabilitySnapshot {
    return {
      available: this.downSince === null,
      downSince: this.downSince,
      escalationDue: this.escalationDue,
      escalated: this.escalated,
    };
  }

  /**
   * Run one probe. Exposed for tests; production callers use start().
   * Concurrent probes are coalesced — a slow SELECT 1 must not stack.
   */
  async probe(): Promise<DbAvailabilitySnapshot> {
    if (this.probing) return this.getSnapshot();
    this.probing = true;
    let probeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      try {
        await Promise.race([
          this.config.pool.query('SELECT 1'),
          new Promise<never>((_, reject) => {
            probeTimer = setTimeout(
              () => reject(Object.assign(new Error('db probe timeout'), { code: 'ETIMEDOUT' })),
              2_000,
            );
            // Don't keep the process alive solely for a probe timeout.
            if (typeof probeTimer === 'object' && probeTimer !== null && 'unref' in probeTimer) {
              (probeTimer as NodeJS.Timeout).unref();
            }
          }),
        ]);
        await this.onAvailable();
      } catch (err) {
        await this.onUnavailable(err);
      } finally {
        if (probeTimer !== undefined) clearTimeout(probeTimer);
      }
      return this.getSnapshot();
    } finally {
      this.probing = false;
    }
  }

  private async onAvailable(): Promise<void> {
    if (this.downSince !== null) {
      const durationMs = this.now() - this.downSince;
      this.log.info(
        { durationMs, escalated: this.escalated },
        'Database connectivity restored',
      );
      // If we crossed the threshold but never got the email out (audit was
      // down too), try one last time now that Postgres is back.
      if (this.escalationDue && !this.escalated) {
        await this.tryEscalate(durationMs);
      }
    }
    this.downSince = null;
    this.escalationDue = false;
    this.escalated = false;
  }

  private async onUnavailable(err: unknown): Promise<void> {
    const now = this.now();
    if (this.downSince === null) {
      this.downSince = now;
      this.escalationDue = false;
      this.escalated = false;
      this.log.error(
        { err, dbUnavailable: isDbUnavailableError(err) },
        'Database probe failed — marking unavailable',
      );
    }

    const downForMs = now - this.downSince;
    if (downForMs >= this.escalationAfterMs) {
      this.escalationDue = true;
      if (!this.escalated) {
        await this.tryEscalate(downForMs);
      }
    }
  }

  private async tryEscalate(downForMs: number): Promise<void> {
    const minutes = Math.round(downForMs / 60_000);
    this.log.error(
      { downForMs, minutes },
      'Database unavailable beyond escalation threshold — attempting CEO notification',
    );

    const gateway = this.config.outboundGateway;
    if (!gateway) {
      this.log.error(
        { downForMs },
        'DbAvailabilityMonitor: no outbound gateway — cannot email CEO; reliance on health endpoint / logs',
      );
      return;
    }

    const ceoEmail = this.config.ceoEmail
      ? resolvePrincipalEmail(this.config.ceoEmail)
      : '';
    if (!ceoEmail) {
      this.log.warn(
        { downForMs },
        'DbAvailabilityMonitor: principal email not bound yet — skipping notification',
      );
      return;
    }

    const subject = 'Curia database unavailable';
    const body = [
      'Curia cannot reach its Postgres database.',
      '',
      `Unavailable for: ~${minutes} min`,
      '',
      'Critical paths (audit, dispatch, working memory) are failing fast with',
      'retryable DATABASE_UNAVAILABLE errors. Non-critical paths retry with backoff.',
      '',
      'Check the /api/health endpoint and Postgres / Docker host.',
      'This alert retries until delivery succeeds (typically once connectivity returns).',
    ].join('\n');

    const sent = await gateway.sendNotification({
      notificationType: 'database_unavailable',
      ceoEmail,
      subject,
      body,
    });

    if (sent) {
      this.escalated = true;
      this.log.info({ downForMs, minutes }, 'DbAvailabilityMonitor: CEO notification published');
    } else {
      this.log.error(
        { downForMs, minutes },
        'DbAvailabilityMonitor: failed to publish notification (audit/bus likely also down) — will retry',
      );
    }
  }
}
