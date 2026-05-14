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

export interface SuspensionNotifierConfig {
  bus: EventBus;
  outboundGateway: OutboundGateway;
  ceoEmail: string;
  logger: Logger;
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
        this.log.error({ err, eventId: event.id, eventType: event.type }, 'SuspensionNotifier: unexpected error in handler');
      });
    });
    this.log.info('SuspensionNotifier registered');
  }

  private async handle(event: ScheduleSuspendedEvent): Promise<void> {
    const { jobId, agentId, lastError, consecutiveFailures } = event.payload;

    const subject = `Scheduled job suspended: ${agentId}`;
    const body = [
      'Scheduled job suspended.',
      '',
      `Agent:    ${agentId}`,
      `Failures: ${consecutiveFailures}`,
      `Error:    ${lastError}`,
      '',
      `Job ID: ${jobId}`,
      '',
      'To resume this job, open the web app and navigate to Scheduler → Jobs.',
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
}
