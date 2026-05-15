// src/scheduler/recovery-notifier.ts
//
// RecoveryNotifier — system-layer bus subscriber that emails the CEO whenever
// the watchdog auto-recovers a stuck job (resets it from 'running' → 'pending'
// after exceeding the computed timeout threshold). See #207.
//
// Design constraint: this path MUST NOT touch the LLM pipeline. The most
// common trigger for a stuck job is an infrastructure failure (Anthropic API
// down, network partition, OOM), so any notification path that calls the LLM
// would fail in exactly that scenario. Instead we call
// outboundGateway.sendNotification() directly, which routes through the
// outbound.notification → EmailAdapter → Nylas path.
//
// Scope: recovery-without-suspension only. When recoverStuckJobs() suspends a
// job (consecutive_failures >= 3), it also fires schedule.suspended, so
// SuspensionNotifier handles that CEO email. This class handles only the
// reset-to-pending case to avoid sending two emails for one watchdog event.

import type { EventBus } from '../bus/bus.js';
import type { Logger } from '../logger.js';
import type { OutboundGateway } from '../skills/outbound-gateway.js';
import type { ScheduleRecoveredEvent, BusEvent } from '../bus/events.js';
import { classifyError } from '../errors/classify.js';

export interface RecoveryNotifierConfig {
  bus: EventBus;
  outboundGateway: OutboundGateway;
  ceoEmail: string;
  logger: Logger;
}

export class RecoveryNotifier {
  private readonly log: Logger;

  constructor(private readonly config: RecoveryNotifierConfig) {
    this.log = config.logger.child({ component: 'recovery-notifier' });
  }

  /**
   * Subscribe to schedule.recovered on the system layer.
   * Call once at startup, after the bus and outbound gateway are ready.
   */
  register(): void {
    this.config.bus.subscribe('schedule.recovered', 'system', (event: BusEvent) => {
      // Fire-and-forget — the bus subscriber must be synchronous; async work is
      // handled internally. The outer .catch() is a backstop for unexpected throws
      // not covered by handle()'s own error handling.
      void this.handle(event as ScheduleRecoveredEvent).catch((err: unknown) => {
        const agentErr = classifyError(err, 'recovery-notifier');
        this.log.error({ err: agentErr, eventId: event.id, eventType: event.type }, 'RecoveryNotifier: unexpected error in handler');
      });
    });
    this.log.info('RecoveryNotifier registered');
  }

  private async handle(event: ScheduleRecoveredEvent): Promise<void> {
    const { jobId, agentId, runStartedAt, timeoutSeconds, consecutiveFailures, suspended } = event.payload;

    // When recovery leads to suspension, schedule.suspended is also fired and
    // SuspensionNotifier sends the CEO email. Skip here to avoid a duplicate.
    if (suspended) return;

    // Compute how long the job was stuck. runStartedAt is null for pre-migration
    // rows that had no run_started_at recorded — fall back to the timeout value.
    const stuckDescription = runStartedAt
      ? formatStuckDuration(event.timestamp, new Date(runStartedAt))
      : `at least ${formatMinutes(timeoutSeconds)} (start time unknown — pre-migration row)`;

    const subject = `Scheduled job recovered from stuck state: ${agentId}`;
    const body = [
      'Scheduled job was stuck and has been auto-recovered (reset to pending).',
      '',
      `Agent:     ${agentId}`,
      `Stuck for: ${stuckDescription}`,
      `Timeout:   ${formatMinutes(timeoutSeconds)}`,
      `Failures:  ${consecutiveFailures} consecutive`,
      '',
      `Job ID: ${jobId}`,
      '',
      'The job has been rescheduled automatically and will run again on its next trigger.',
    ].join('\n');

    // sendNotification() catches its own errors and returns false on failure —
    // it does not throw. We log at error if it returns false so the anomaly is
    // visible in alerting.
    const sent = await this.config.outboundGateway.sendNotification({
      notificationType: 'schedule_recovered',
      ceoEmail: this.config.ceoEmail,
      subject,
      body,
    });

    if (!sent) {
      this.log.error(
        { jobId, agentId, consecutiveFailures, stuckDescription },
        'RecoveryNotifier: failed to publish notification — recovery already recorded in audit log',
      );
    }
  }
}

/** Format a duration in seconds as a human-readable string (e.g. "15 min", "1 h 5 min"). */
function formatMinutes(seconds: number): string {
  const totalMin = Math.round(seconds / 60);
  if (totalMin < 60) return `${totalMin} min`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins === 0 ? `${hours} h` : `${hours} h ${mins} min`;
}

/**
 * Compute the duration between when the job entered 'running' and the event
 * timestamp (≈ the moment of recovery), then format it as a human-readable
 * string prefixed with "~" to signal that it's approximate.
 */
function formatStuckDuration(eventTimestamp: Date, runStartedAt: Date): string {
  const elapsedMs = eventTimestamp.getTime() - runStartedAt.getTime();
  // Guard against clock skew producing a negative value.
  if (elapsedMs < 0) return 'unknown duration (clock skew detected)';
  const elapsedSeconds = Math.round(elapsedMs / 1000);
  // Fall back to seconds for sub-minute durations so the message is meaningful.
  if (elapsedSeconds < 60) return `~${elapsedSeconds}s`;
  return `~${formatMinutes(elapsedSeconds)}`;
}
