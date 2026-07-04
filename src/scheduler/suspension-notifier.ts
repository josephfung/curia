// src/scheduler/suspension-notifier.ts
//
// SuspensionNotifier — system-layer bus subscriber that emails the CEO whenever
// a scheduled job is auto-suspended after 3 consecutive failures.
//
// Design constraint: this path MUST NOT touch the LLM pipeline. The most
// common trigger for a suspension is the Anthropic API being down, so any
// notification path that calls the LLM would fail in exactly that scenario.
// Instead we call outboundGateway.sendNotification() directly, which routes
// through the outbound.notification → EmailAdapter → Nylas path.

import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import type { OutboundGateway } from '../skills/outbound-gateway.js';
import type { ScheduleSuspendedEvent, BusEvent } from '../bus/events.js';
import { classifyError } from '../errors/classify.js';
import type { SchedulerService } from './scheduler-service.js';
import {
  buildJobNotificationContext,
  buildJobConsoleUrl,
} from './job-notification-context.js';

export interface SuspensionNotifierConfig {
  bus: EventBus;
  outboundGateway: OutboundGateway;
  schedulerService: SchedulerService;
  ceoEmail: string;
  logger: Logger;
  appOrigin?: string;
  httpPort: number;
}

export class SuspensionNotifier {
  private readonly log: Logger;

  constructor(private readonly config: SuspensionNotifierConfig) {
    this.log = config.logger.child({ component: 'suspension-notifier' });
  }

  /**
   * Subscribe to schedule.suspended on the system layer.
   * Call once at startup, after the bus and outbound gateway are ready.
   */
  register(): void {
    this.config.bus.subscribe('schedule.suspended', 'system', (event: BusEvent) => {
      // Fire-and-forget — the bus subscriber must be synchronous; async work is
      // handled internally. The outer .catch() is a backstop for unexpected throws
      // not covered by handle()'s own error handling.
      void this.handle(event as ScheduleSuspendedEvent).catch((err: unknown) => {
        const agentErr = classifyError(err, 'suspension-notifier');
        this.log.error({ err: agentErr, eventId: event.id, eventType: event.type }, 'SuspensionNotifier: unexpected error in handler');
      });
    });
    this.log.info('SuspensionNotifier registered');
  }

  private async handle(event: ScheduleSuspendedEvent): Promise<void> {
    const { jobId, agentId, lastError, consecutiveFailures } = event.payload;

    const jobContext = await this.loadJobContext(jobId);

    const subject = `Scheduled job suspended: ${agentId}`;
    const body = [
      'Scheduled job suspended.',
      '',
      `Agent:      ${agentId}`,
      `Objective:  ${jobContext.objective}`,
      `Recurrence: ${jobContext.recurrence}`,
      `Failures:   ${consecutiveFailures}`,
      `Error:      ${lastError}`,
      '',
      `View job: ${jobContext.consoleUrl}`,
      '',
      'To resume this job, open the link above and click Resume.',
    ].join('\n');

    // sendNotification() catches its own errors and returns false on failure —
    // it does not throw. We log at error if it returns false so the anomaly is
    // visible in alerting.
    const sent = await this.config.outboundGateway.sendNotification({
      notificationType: 'schedule_suspended',
      ceoEmail: this.config.ceoEmail,
      subject,
      body,
    });

    if (!sent) {
      this.log.error(
        { jobId, agentId, consecutiveFailures, lastError },
        'SuspensionNotifier: failed to publish notification — suspension already recorded in audit log',
      );
    }
  }

  /** Lightweight DB lookup for notification context; falls back gracefully on missing rows. */
  private async loadJobContext(jobId: string): Promise<{
    objective: string;
    recurrence: string;
    consoleUrl: string;
  }> {
    const consoleUrl = buildJobConsoleUrl(this.config.appOrigin, this.config.httpPort, jobId);
    try {
      const job = await this.config.schedulerService.getJob(jobId);
      if (!job) {
        return {
          objective: '(job not found)',
          recurrence: '(unknown)',
          consoleUrl,
        };
      }
      return buildJobNotificationContext(job, this.config.appOrigin, this.config.httpPort);
    } catch (err: unknown) {
      const agentErr = classifyError(err, 'suspension-notifier');
      this.log.warn({ err: agentErr, jobId }, 'SuspensionNotifier: failed to load job context for notification');
      return {
        objective: '(unavailable)',
        recurrence: '(unknown)',
        consoleUrl,
      };
    }
  }
}
