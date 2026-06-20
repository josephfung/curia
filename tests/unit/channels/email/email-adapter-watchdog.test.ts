// tests/unit/channels/email/email-adapter-watchdog.test.ts
//
// Unit tests for the #846 stall-watchdog logic in EmailAdapter.
// All dependencies are mocked so no real Postgres is needed.

import { describe, it, expect, vi, afterEach } from 'vitest';
import pino from 'pino';
import { EmailAdapter } from '../../../../src/channels/email/email-adapter.js';
import type { EventBus } from '../../../../src/bus/bus.js';
import type { BusEvent, ChannelStalledEvent } from '../../../../src/bus/events.js';
import type { ContactService } from '../../../../src/contacts/contact-service.js';

const TEST_ACCOUNT_ID = 'test-watchdog-846';

function makeContactService(): ContactService {
  return {
    resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
    createContact: vi.fn().mockResolvedValue({ id: 'c-test', displayName: 'Test', tier: 'unknown' }),
    linkIdentity: vi.fn().mockResolvedValue(undefined),
  } as unknown as ContactService;
}

function makeGateway(listImpl: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue([])) {
  return {
    listEmailMessages: listImpl,
    send: vi.fn(),
    sendNotification: vi.fn(),
    createEmailDraft: vi.fn(),
    linkGatedAction: vi.fn(),
  };
}

function makeAdapterConfig(
  bus: EventBus,
  gateway: ReturnType<typeof makeGateway>,
) {
  return {
    accountId: TEST_ACCOUNT_ID,
    bus,
    logger: pino({ level: 'silent' }),
    outboundGateway: gateway as never,
    contactService: makeContactService(),
    pollingIntervalMs: 100,
    selfEmail: 'curia@example.com',
    excludedSenderEmails: [],
    contactCreationMaxPerMessage: 10,
    contactCreationMaxPerHour: 100,
    timezone: 'UTC',
    // no configStore — watermark persistence not under test here
  };
}

describe('email-adapter stall watchdog (#846)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits exactly one channel.stalled when polls fail for > 5× pollingIntervalMs', async () => {
    vi.useFakeTimers();

    const capturedEvents: BusEvent[] = [];

    // Minimal mock bus — subscribe is a no-op, publish records emitted events.
    const bus = {
      subscribe: vi.fn(),
      publish: vi.fn().mockImplementation(async (_layer: string, evt: BusEvent) => {
        capturedEvents.push(evt);
      }),
    } as unknown as EventBus;

    // Gateway that always rejects — simulates Nylas being unreachable.
    const gateway = makeGateway(vi.fn().mockRejectedValue(new Error('Nylas unavailable')));

    const adapter = new EmailAdapter(makeAdapterConfig(bus, gateway));

    // start() awaits the initial poll synchronously; the poll throws and is caught.
    // The setInterval is registered but has not fired yet.
    await adapter.start();

    // Advance past 5× pollingIntervalMs (5 × 100ms = 500ms).
    // Tick 6 (600ms) is the first tick where now - startedAt > threshold → stalled.
    await vi.advanceTimersByTimeAsync(650);
    // Drain microtasks from fire-and-forget `void this.checkWatchdog()` calls inside
    // the setInterval callback. checkWatchdog() awaits bus.publish(), so two rounds
    // of Promise.resolve() flush the microtask queue before we assert.
    await Promise.resolve();
    await Promise.resolve();

    const stalledEvents = capturedEvents.filter(
      (e): e is ChannelStalledEvent => e.type === 'channel.stalled',
    );

    expect(stalledEvents).toHaveLength(1);
    expect(stalledEvents[0]!.payload.accountId).toBe(TEST_ACCOUNT_ID);
    expect(stalledEvents[0]!.payload.channel).toBe('email');
    // Adapter never completed a successful poll, so this is null.
    expect(stalledEvents[0]!.payload.lastSuccessfulPollAt).toBeNull();
    expect(stalledEvents[0]!.payload.stallThresholdMs).toBe(500); // 5 × 100ms

    // Advance further — must NOT emit a second channel.stalled (fire-once per lifecycle).
    await vi.advanceTimersByTimeAsync(600);
    await Promise.resolve();
    await Promise.resolve();
    const stalledTotal = capturedEvents.filter((e) => e.type === 'channel.stalled');
    expect(stalledTotal).toHaveLength(1);

    await adapter.stop();
  });

  it('does not stall when polls succeed within the threshold', async () => {
    vi.useFakeTimers();

    const capturedEvents: BusEvent[] = [];
    const bus = {
      subscribe: vi.fn(),
      publish: vi.fn().mockImplementation(async (_layer: string, evt: BusEvent) => {
        capturedEvents.push(evt);
      }),
    } as unknown as EventBus;

    // Gateway succeeds (returns empty list) — adapter should NOT stall.
    const adapter = new EmailAdapter(makeAdapterConfig(bus, makeGateway()));

    await adapter.start();

    // Advance well past 5× interval — still healthy because each tick succeeds.
    await vi.advanceTimersByTimeAsync(650);
    await Promise.resolve();
    await Promise.resolve();

    const stalledEvents = capturedEvents.filter((e) => e.type === 'channel.stalled');
    expect(stalledEvents).toHaveLength(0);

    await adapter.stop();
  });

  it('resets the retry counter on stop()/start() so stalls are re-detectable', async () => {
    vi.useFakeTimers();

    const capturedEvents: BusEvent[] = [];
    const bus = {
      subscribe: vi.fn(),
      publish: vi.fn().mockImplementation(async (_layer: string, evt: BusEvent) => {
        capturedEvents.push(evt);
      }),
    } as unknown as EventBus;

    const gateway = makeGateway(vi.fn().mockRejectedValue(new Error('Nylas unavailable')));
    const adapter = new EmailAdapter(makeAdapterConfig(bus, gateway));

    // First lifecycle: run until stall detected.
    await adapter.start();
    await vi.advanceTimersByTimeAsync(650);
    await Promise.resolve();
    await Promise.resolve();

    expect(capturedEvents.filter((e) => e.type === 'channel.stalled')).toHaveLength(1);

    await adapter.stop();
    capturedEvents.length = 0; // reset captured events

    // Second lifecycle: stalledEmitAttempts must have been reset so the watchdog fires again.
    await adapter.start();
    await vi.advanceTimersByTimeAsync(650);
    await Promise.resolve();
    await Promise.resolve();

    expect(capturedEvents.filter((e) => e.type === 'channel.stalled')).toHaveLength(1);

    await adapter.stop();
  });
});
