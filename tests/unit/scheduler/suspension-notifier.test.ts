import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SuspensionNotifier } from '../../../src/scheduler/suspension-notifier.js';
import type { ScheduleSuspendedEvent } from '../../../src/bus/events.js';

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

function makeEvent(overrides: Partial<ScheduleSuspendedEvent['payload']> = {}): ScheduleSuspendedEvent {
  return {
    id: 'evt-1',
    timestamp: new Date(),
    type: 'schedule.suspended',
    sourceLayer: 'system',
    payload: {
      jobId: 'job-abc123',
      agentId: 'ceo-inbox',
      lastError: '400 — credit balance is too low to access the Anthropic API',
      consecutiveFailures: 3,
      ...overrides,
    },
  };
}

describe('SuspensionNotifier', () => {
  let bus: ReturnType<typeof mockBus>;
  let gateway: ReturnType<typeof mockOutboundGateway>;
  let logger: ReturnType<typeof mockLogger>;
  let notifier: SuspensionNotifier;

  beforeEach(() => {
    bus = mockBus();
    gateway = mockOutboundGateway();
    logger = mockLogger();
    notifier = new SuspensionNotifier({
      bus: bus as never,
      outboundGateway: gateway as never,
      ceoEmail: 'ceo@example.com',
      logger: logger as never,
    });
  });

  it('registers on schedule.suspended at the system layer', () => {
    notifier.register();
    expect(bus.subscribe).toHaveBeenCalledWith(
      'schedule.suspended',
      'system',
      expect.any(Function),
    );
  });

  it('sends a notification with correct fields when a job is suspended', async () => {
    gateway.sendNotification.mockResolvedValue(true);

    // Call handle() directly so the test is synchronous and deterministic.
    // The public register() path (fire-and-forget void) is covered by the test above.
    await (notifier as never as { handle(e: ScheduleSuspendedEvent): Promise<void> })
      .handle(makeEvent());

    expect(gateway.sendNotification).toHaveBeenCalledOnce();
    const call = gateway.sendNotification.mock.calls[0][0];
    expect(call.notificationType).toBe('schedule_suspended');
    expect(call.ceoEmail).toBe('ceo@example.com');
    expect(call.subject).toContain('ceo-inbox');
    expect(call.body).toContain('ceo-inbox');       // agentId
    expect(call.body).toContain('3');               // consecutiveFailures
    expect(call.body).toContain('400 — credit balance is too low to access the Anthropic API'); // lastError
    expect(call.body).toContain('job-abc123');      // jobId
    expect(call.body).toContain('web app');         // resume instructions
  });

  it('logs an error and resolves when sendNotification returns false', async () => {
    gateway.sendNotification.mockResolvedValue(false);

    await expect(
      (notifier as never as { handle(e: ScheduleSuspendedEvent): Promise<void> })
        .handle(makeEvent()),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
  });
});
