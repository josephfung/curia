import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RecoveryNotifier } from '../../../src/scheduler/recovery-notifier.js';
import type { ScheduleRecoveredEvent } from '../../../src/bus/events.js';

// -- Mock helpers --

function mockBus() {
  return {
    subscribe: vi.fn(),
    publish: vi.fn(),
  };
}

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function mockOutboundGateway() {
  return {
    sendNotification: vi.fn(),
  };
}

// A fixed "now" for deterministic duration calculations in tests.
const FIXED_NOW = new Date('2026-05-15T12:30:00.000Z');
// Simulates a job that started running 20 minutes ago.
const RUN_STARTED_AT = new Date('2026-05-15T12:10:00.000Z').toISOString();

function makeEvent(overrides: Partial<ScheduleRecoveredEvent['payload']> = {}): ScheduleRecoveredEvent {
  return {
    id: 'evt-1',
    timestamp: FIXED_NOW,
    type: 'schedule.recovered',
    sourceLayer: 'system',
    payload: {
      jobId: 'job-abc123',
      agentId: 'coordinator',
      runStartedAt: RUN_STARTED_AT,
      timeoutSeconds: 900,         // 15-minute timeout
      consecutiveFailures: 1,
      suspended: false,
      ...overrides,
    },
  };
}

describe('RecoveryNotifier', () => {
  let bus: ReturnType<typeof mockBus>;
  let gateway: ReturnType<typeof mockOutboundGateway>;
  let logger: ReturnType<typeof mockLogger>;
  let notifier: RecoveryNotifier;

  beforeEach(() => {
    bus = mockBus();
    gateway = mockOutboundGateway();
    logger = mockLogger();
    notifier = new RecoveryNotifier({
      bus: bus as never,
      outboundGateway: gateway as never,
      ceoEmail: 'ceo@example.com',
      logger: logger as never,
    });
  });

  it('registers on schedule.recovered at the system layer', () => {
    notifier.register();
    expect(bus.subscribe).toHaveBeenCalledWith(
      'schedule.recovered',
      'system',
      expect.any(Function),
    );
  });

  it('logs info on registration', () => {
    notifier.register();
    expect(logger.info).toHaveBeenCalledWith('RecoveryNotifier registered');
  });

  it('sends a notification with correct fields for a recovered (non-suspended) job', async () => {
    gateway.sendNotification.mockResolvedValue(true);

    // Call handle() directly so the test is synchronous and deterministic.
    // The public register() path (fire-and-forget void) is covered by the test above.
    await (notifier as never as { handle(e: ScheduleRecoveredEvent): Promise<void> })
      .handle(makeEvent());

    expect(gateway.sendNotification).toHaveBeenCalledOnce();
    const call = gateway.sendNotification.mock.calls[0][0];
    expect(call.notificationType).toBe('schedule_recovered');
    expect(call.ceoEmail).toBe('ceo@example.com');
    expect(call.subject).toContain('coordinator');                  // agentId in subject
    expect(call.subject).not.toContain('suspended');               // should NOT say suspended
    expect(call.body).toContain('coordinator');                    // agentId in body
    expect(call.body).toContain('job-abc123');                     // jobId
    expect(call.body).toContain('~20 min');                       // stuck duration (now - runStartedAt)
    expect(call.body).toContain('15 min');                        // timeout threshold (900s)
    expect(call.body).toContain('reset to pending');              // outcome
    expect(call.body).toContain('rescheduled automatically');     // resume message for non-suspended
  });

  it('sends a notification with suspended-specific content when job is suspended', async () => {
    gateway.sendNotification.mockResolvedValue(true);

    await (notifier as never as { handle(e: ScheduleRecoveredEvent): Promise<void> })
      .handle(makeEvent({ suspended: true, consecutiveFailures: 3 }));

    expect(gateway.sendNotification).toHaveBeenCalledOnce();
    const call = gateway.sendNotification.mock.calls[0][0];
    expect(call.notificationType).toBe('schedule_recovered');
    expect(call.subject).toContain('suspended');                   // subject flags suspension
    expect(call.body).toContain('SUSPENDED');                     // outcome prominently marked
    expect(call.body).toContain('3');                             // consecutiveFailures
    expect(call.body).toContain('web app');                       // resume instructions for suspended
    expect(call.body).not.toContain('rescheduled automatically'); // NOT the non-suspended message
  });

  it('handles null runStartedAt (pre-migration rows) gracefully', async () => {
    gateway.sendNotification.mockResolvedValue(true);

    await (notifier as never as { handle(e: ScheduleRecoveredEvent): Promise<void> })
      .handle(makeEvent({ runStartedAt: null }));

    const call = gateway.sendNotification.mock.calls[0][0];
    // Should mention the timeout threshold as a fallback, not crash
    expect(call.body).toContain('15 min');
    expect(call.body).toContain('start time unknown');
  });

  it('formats hours correctly for long timeouts', async () => {
    gateway.sendNotification.mockResolvedValue(true);

    // timeoutSeconds = 3600 → "1 h"; runStartedAt = 90 minutes ago → "~1 h 30 min"
    const runStartedAt = new Date(FIXED_NOW.getTime() - 90 * 60 * 1000).toISOString();
    await (notifier as never as { handle(e: ScheduleRecoveredEvent): Promise<void> })
      .handle(makeEvent({ timeoutSeconds: 3600, runStartedAt }));

    const call = gateway.sendNotification.mock.calls[0][0];
    expect(call.body).toContain('1 h');       // timeout formatted as hours
    expect(call.body).toContain('~1 h 30 min'); // stuck duration ~90 min
  });

  it('logs an error and resolves when sendNotification returns false', async () => {
    gateway.sendNotification.mockResolvedValue(false);

    await expect(
      (notifier as never as { handle(e: ScheduleRecoveredEvent): Promise<void> })
        .handle(makeEvent()),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
  });
});
