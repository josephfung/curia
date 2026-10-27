// The email poll must return after the Nylas fetch and handoff. A slow
// inbound subscriber is the agent turn; it must not hold the health stamp,
// the next poll, or a different thread (#2254).

import { describe, it, expect, vi, afterEach } from 'vitest';
import pino from 'pino';
import { Writable } from 'node:stream';
import { EmailAdapter, type EmailAdapterConfig } from '../../../../src/channels/email/email-adapter.js';
import { TurnLanes } from '../../../../src/dispatch/turn-lanes.js';
import { createSilentLogger } from '../../../../src/logger.js';
import type { OutboundGateway } from '../../../../src/skills/outbound-gateway.js';
import type { ContactService } from '../../../../src/contacts/contact-service.js';
import type { EventBus } from '../../../../src/bus/bus.js';
import type { NylasMessage } from '../../../../src/channels/email/nylas-client.js';
import {
  createOutboundMessage,
  type BusEvent,
  type ChannelPollEvent,
} from '../../../../src/bus/events.js';
import { checkEmail } from '../../../../src/health/health-checks.js';
import {
  EMAIL_INBOUND_TURN_STALL_MS,
  EMAIL_POLL_PAGE_SIZE,
  MAX_STAGED_INBOUND_IDS,
  WRITE_AHEAD_POLL_FAIL_LIMIT,
  WRITE_AHEAD_RETRY_LIMIT,
} from '../../../../src/channels/email/inbound-stall.js';
import { INBOUND_REPLAY_LIMIT } from '../../../../src/audit/inbound-replay.js';
import type { ConfigStore } from '../../../../src/memory/config-store.js';

const SELF_EMAIL = 'curia@example.com';
const CEO_EMAIL = 'ceo@example.com';

function makeMockMessage(overrides: Partial<NylasMessage> = {}): NylasMessage {
  return {
    id: 'msg-1',
    threadId: 'thread-abc',
    subject: 'Hello',
    from: [{ email: CEO_EMAIL, name: 'CEO' }],
    to: [{ email: SELF_EMAIL, name: 'Curia' }],
    cc: [],
    bcc: [],
    body: '<p>Hi</p>',
    snippet: 'Hi',
    date: 1700000000,
    unread: true,
    folders: ['INBOX'],
    attachments: [],
    ...overrides,
  };
}

function createMocks() {
  const logger = createSilentLogger();
  const publish = vi.fn().mockResolvedValue(undefined);
  const bus = {
    subscribe: vi.fn(),
    publish,
    // Write-ahead resolves here. Delivery goes through publish, so tests that
    // hang or reject publish are hanging the agent turn, not the poll.
    stagePublish: vi.fn(async (layer: string, event: BusEvent) => ({
      deliver: () => publish(layer, event),
    })),
    deliverPersisted: vi.fn(async (event: BusEvent) => publish('channel', event)),
  } as unknown as EventBus;
  const contactService = {
    resolveByChannelIdentity: vi.fn().mockResolvedValue({ id: 'existing' }),
  } as unknown as ContactService;
  const outboundGateway = {
    send: vi.fn().mockResolvedValue({ success: true, messageId: 'sent-1' }),
    createEmailDraft: vi.fn().mockResolvedValue({ success: true, draftId: 'draft-1' }),
    linkGatedAction: vi.fn().mockResolvedValue(undefined),
    listEmailMessages: vi.fn().mockResolvedValue([]),
    sendNotification: vi.fn().mockResolvedValue(undefined),
  } as unknown as OutboundGateway;
  return { logger, bus, contactService, outboundGateway };
}

function makeAdapter(
  mocks: ReturnType<typeof createMocks>,
  overrides: Partial<{
    maxConcurrentTurns: number;
    pollingIntervalMs: number;
    suppressedSenderEmails: string[];
    logger: ReturnType<typeof createMocks>['logger'];
    configStore: EmailAdapterConfig['configStore'];
    unacknowledgedInbound: EmailAdapterConfig['unacknowledgedInbound'];
    turnLanes: TurnLanes;
  }> = {},
) {
  return new EmailAdapter({
    accountId: 'curia',
    bus: mocks.bus,
    logger: overrides.logger ?? mocks.logger,
    outboundGateway: mocks.outboundGateway,
    contactService: mocks.contactService,
    pollingIntervalMs: overrides.pollingIntervalMs ?? 7_200_000,
    selfEmail: SELF_EMAIL,
    suppressedSenderEmails: overrides.suppressedSenderEmails ?? [],
    contactCreationMaxPerMessage: 10,
    contactCreationMaxPerHour: 100,
    maxConcurrentTurns: overrides.maxConcurrentTurns ?? 4,
    ceoEmail: CEO_EMAIL,
    timezone: 'America/Toronto',
    configStore: overrides.configStore,
    unacknowledgedInbound: overrides.unacknowledgedInbound,
    turnLanes: overrides.turnLanes,
  });
}

function pollNow(adapter: EmailAdapter): Promise<void> {
  return (adapter as unknown as { poll(): Promise<void> }).poll();
}

function inboundId(event: BusEvent): string | undefined {
  if (event.type !== 'inbound.message') return undefined;
  const id = event.payload.metadata?.nylasMessageId;
  return typeof id === 'string' ? id : undefined;
}

function pollEvents(bus: EventBus): ChannelPollEvent[] {
  return (bus.publish as ReturnType<typeof vi.fn>).mock.calls
    .map((args) => args[1] as BusEvent)
    .filter((event): event is ChannelPollEvent => event.type === 'channel.poll');
}

/** Hang each inbound publish until release(id). Other events resolve immediately. */
function hangInbound(bus: EventBus): { started: string[]; release: (id: string) => void } {
  const gates = new Map<string, () => void>();
  const started: string[] = [];
  (bus.publish as ReturnType<typeof vi.fn>).mockImplementation((_layer: string, event: BusEvent) => {
    const id = inboundId(event);
    if (!id) return Promise.resolve();
    started.push(id);
    return new Promise<void>((resolve) => {
      gates.set(id, resolve);
    });
  });
  return {
    started,
    release(id: string) {
      const resolve = gates.get(id);
      if (!resolve) throw new Error(`no in-flight publish for ${id}`);
      gates.delete(id);
      resolve();
    },
  };
}

function captureHandler(eventType: string, mocks: ReturnType<typeof createMocks>) {
  const handlers: Record<string, (event: BusEvent) => Promise<void>> = {};
  (mocks.bus.subscribe as ReturnType<typeof vi.fn>).mockImplementation(
    (et: string, _layer: string, cb: (event: BusEvent) => Promise<void>) => {
      handlers[et] = cb;
    },
  );
  return (event: BusEvent) => {
    const handler = handlers[eventType];
    if (!handler) throw new Error(`${eventType} handler not registered`);
    return handler(event);
  };
}

function collectLogs(): { logger: pino.Logger; entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      const line = chunk.toString().trim();
      if (line) entries.push(JSON.parse(line) as Record<string, unknown>);
      callback();
    },
  });
  return { logger: pino({ level: 'info' }, stream), entries };
}

function failureLogs(entries: Array<Record<string, unknown>>) {
  return entries.filter((entry) => entry.msg === 'Failed to process inbound email — skipping message');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('EmailAdapter — poll does not wait for the agent turn (#2254)', () => {
  it('returns, stamps health, and emits channel.poll while a subscriber is still running', async () => {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks);
    const started: string[] = [];
    let settled = false;
    let releaseTurn: () => void = () => {};
    (mocks.bus.publish as ReturnType<typeof vi.fn>).mockImplementation((_layer: string, event: BusEvent) => {
      const id = inboundId(event);
      if (!id) return Promise.resolve();
      started.push(id);
      return new Promise<void>((resolve) => {
        releaseTurn = () => {
          settled = true;
          resolve();
        };
      });
    });
    const list = mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>;
    list.mockResolvedValueOnce([
      makeMockMessage({ id: 'slow', threadId: 'thread-slow', from: [{ email: 'ada@example.com' }] }),
    ]);

    await adapter.start();

    expect(settled).toBe(false);
    expect(started).toEqual(['slow']);
    expect(adapter.lastSuccessfulPollAt).not.toBeNull();
    expect(checkEmail(adapter, 3, new Date())).toBe('ok');

    const audit = pollEvents(mocks.bus);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload.fetched).toBe(1);
    expect(audit[0]!.payload.processed).toBe(1);
    expect(audit[0]!.payload.skipped.failed).toBe(0);

    releaseTurn();
    await adapter.drainInFlight();
    expect(settled).toBe(true);
    await adapter.stop();
  });

  it('stays email-ok through a turn longer than the stall window, and fails when Nylas stops', async () => {
    vi.useFakeTimers();
    const mocks = createMocks();
    const adapter = makeAdapter(mocks, { pollingIntervalMs: 1_000 });
    let releaseTurn: () => void = () => {};
    (mocks.bus.publish as ReturnType<typeof vi.fn>).mockImplementation((_layer: string, event: BusEvent) => {
      if (event.type !== 'inbound.message') return Promise.resolve();
      return new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
    });
    const list = mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>;
    list.mockResolvedValueOnce([
      makeMockMessage({ id: 'long-turn', threadId: 'thread-long', from: [{ email: 'ada@example.com' }] }),
    ]).mockResolvedValue([]);

    try {
      await adapter.start();
      const stampedAtStart = adapter.lastSuccessfulPollAt!.getTime();

      // 3 × 1000ms is the health grace. Polls keep succeeding while the turn hangs,
      // so the stamp moves forward and the check stays ok.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(list.mock.calls.length).toBeGreaterThan(1);
      const fresh = adapter.lastSuccessfulPollAt!.getTime();
      expect(fresh).toBeGreaterThan(stampedAtStart);
      expect(checkEmail(adapter, 3, new Date(stampedAtStart))).toBe('ok');

      list.mockRejectedValue(new Error('Nylas unavailable'));
      await vi.advanceTimersByTimeAsync(4_000);
      expect(adapter.lastSuccessfulPollAt!.getTime()).toBe(fresh);
      expect(checkEmail(adapter, 3, new Date(stampedAtStart))).toBe('fail');
    } finally {
      releaseTurn();
      await adapter.drainInFlight();
      await adapter.stop();
    }
  });

  it('starts a second thread without waiting for the first turn', async () => {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks);
    const gate = hangInbound(mocks.bus);
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeMockMessage({ id: 'a', threadId: 'thread-a', from: [{ email: 'a@example.com' }] }),
      makeMockMessage({ id: 'b', threadId: 'thread-b', from: [{ email: 'b@example.com' }] }),
    ]);

    await adapter.start();

    expect(gate.started).toEqual(['a', 'b']);
    gate.release('a');
    gate.release('b');
    await adapter.drainInFlight();
    await adapter.stop();
  });

  it('processes two emails on the same thread in order, never concurrently', async () => {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks, { maxConcurrentTurns: 4 });
    const gate = hangInbound(mocks.bus);
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeMockMessage({ id: 'first', threadId: 'thread-same', from: [{ email: 'ada@example.com' }] }),
      makeMockMessage({ id: 'second', threadId: 'thread-same', from: [{ email: 'ada@example.com' }] }),
    ]);

    await adapter.start();
    expect(gate.started).toEqual(['first']);

    gate.release('first');
    await vi.waitFor(() => {
      expect(gate.started).toEqual(['first', 'second']);
    });
    gate.release('second');
    await adapter.drainInFlight();
    await adapter.stop();
  });

  it('releases the same thread when intake settles, and keeps the next delivery\'s lock', async () => {
    const mocks = createMocks();
    const lanes = new TurnLanes({
      enabled: true,
      maxInjectionsPerTurn: 5,
      extraRoundsPerInjection: 2,
      laneWaitTimeoutMs: 60_000,
      logger: pino({ level: 'silent' }),
    });
    const adapter = makeAdapter(mocks, { maxConcurrentTurns: 4, turnLanes: lanes });
    const gate = hangInbound(mocks.bus);
    const events = new Map<string, BusEvent>();
    const publish = mocks.bus.publish as ReturnType<typeof vi.fn>;
    const hanging = publish.getMockImplementation() as ((layer: string, event: BusEvent) => Promise<void>) | undefined;
    publish.mockImplementation((layer: string, event: BusEvent) => {
      const id = inboundId(event);
      if (id) events.set(id, event);
      return hanging ? hanging(layer, event) : Promise.resolve();
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeMockMessage({ id: 'first', threadId: 'thread-same', from: [{ email: 'ada@example.com' }] }),
      makeMockMessage({ id: 'second', threadId: 'thread-same', from: [{ email: 'ada@example.com' }] }),
      makeMockMessage({ id: 'third', threadId: 'thread-same', from: [{ email: 'ada@example.com' }] }),
      makeMockMessage({ id: 'fourth', threadId: 'thread-same', from: [{ email: 'ada@example.com' }] }),
    ]);

    await adapter.start();
    expect(gate.started).toEqual(['first']);
    const first = events.get('first');
    expect(first).toBeDefined();
    lanes.markIntakeSettled(first!.id);
    await vi.waitFor(() => {
      expect(gate.started).toEqual(['first', 'second']);
    });
    lanes.markIntakeSettled(events.get('second')!.id);
    await vi.waitFor(() => {
      expect(gate.started).toEqual(['first', 'second', 'third']);
    });
    // The first delivery ending must not drop the third's lock.
    gate.release('first');
    await vi.waitFor(() => expect(adapter.inboundInFlight).toBe(2));
    expect(gate.started).toEqual(['first', 'second', 'third']);
    lanes.markIntakeSettled(events.get('third')!.id);
    await vi.waitFor(() => {
      expect(gate.started).toEqual(['first', 'second', 'third', 'fourth']);
    });
    gate.release('second');
    gate.release('third');
    gate.release('fourth');
    await adapter.drainInFlight();
    await adapter.stop();
  });

  it('settles intake when the inbound publish fails so the thread can continue', async () => {
    const mocks = createMocks();
    const lanes = new TurnLanes({
      enabled: true,
      maxInjectionsPerTurn: 5,
      extraRoundsPerInjection: 2,
      laneWaitTimeoutMs: 60_000,
      logger: pino({ level: 'silent' }),
    });
    const adapter = makeAdapter(mocks, { maxConcurrentTurns: 4, turnLanes: lanes });
    const publish = mocks.bus.publish as ReturnType<typeof vi.fn>;
    const started: string[] = [];
    publish.mockImplementation((_layer: string, event: BusEvent) => {
      const id = inboundId(event);
      if (!id) return Promise.resolve();
      started.push(id);
      if (id === 'first') return Promise.reject(new Error('write-ahead failed'));
      return Promise.resolve();
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeMockMessage({ id: 'first', threadId: 'thread-same', from: [{ email: 'ada@example.com' }] }),
      makeMockMessage({ id: 'second', threadId: 'thread-same', from: [{ email: 'ada@example.com' }] }),
    ]);

    await adapter.start();
    await vi.waitFor(() => {
      expect(started).toEqual(['first', 'second']);
    });
    await adapter.drainInFlight();
    await adapter.stop();
  });

  it('caps concurrent turns and continues the oldest waiting thread first', async () => {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks, { maxConcurrentTurns: 1 });
    const gate = hangInbound(mocks.bus);
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeMockMessage({ id: 'a1', threadId: 'thread-a', from: [{ email: 'a@example.com' }] }),
      makeMockMessage({ id: 'a2', threadId: 'thread-a', from: [{ email: 'a@example.com' }] }),
      makeMockMessage({ id: 'b1', threadId: 'thread-b', from: [{ email: 'b@example.com' }] }),
    ]);

    await adapter.start();
    expect(gate.started).toEqual(['a1']);
    expect(adapter.inboundInFlight).toBe(1);
    expect(adapter.inboundPending).toBe(2);
    expect(adapter.oldestInboundPendingAgeMs).toBeGreaterThanOrEqual(0);
    expect(adapter.oldestInboundInFlightAgeMs).toBeGreaterThanOrEqual(0);

    gate.release('a1');
    await vi.waitFor(() => {
      expect(gate.started).toEqual(['a1', 'b1']);
    });

    gate.release('b1');
    await vi.waitFor(() => {
      expect(gate.started).toEqual(['a1', 'b1', 'a2']);
    });
    gate.release('a2');
    await adapter.drainInFlight();
    await adapter.stop();
  });

  it('runs at most the configured cap of 4', async () => {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks, { maxConcurrentTurns: 4 });
    const gate = hangInbound(mocks.bus);
    const messages = ['t1', 't2', 't3', 't4', 't5'].map((id) =>
      makeMockMessage({ id, threadId: `thread-${id}`, from: [{ email: `${id}@example.com` }] }),
    );
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce(messages);

    await adapter.start();
    expect(gate.started).toEqual(['t1', 't2', 't3', 't4']);
    // The fifth message is queued behind the cap, and the poll still counts it.
    // The heartbeat is the fetch, not the later publish.
    const audit = pollEvents(mocks.bus);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload.fetched).toBe(5);
    expect(audit[0]!.payload.processed).toBe(5);

    gate.release('t1');
    await vi.waitFor(() => {
      expect(gate.started).toEqual(['t1', 't2', 't3', 't4', 't5']);
    });
    for (const id of ['t2', 't3', 't4', 't5']) gate.release(id);
    await adapter.drainInFlight();
    await adapter.stop();
  });

  it('rejects a non-positive maxConcurrentTurns', () => {
    const mocks = createMocks();
    expect(() => makeAdapter(mocks, { maxConcurrentTurns: 0 })).toThrow(
      /maxConcurrentTurns must be a positive integer/,
    );
  });

  it('keeps channel.poll counts equal to fetched and logs a pre-handoff failure', async () => {
    const mocks = createMocks();
    const { logger, entries } = collectLogs();
    const adapter = makeAdapter(mocks, {
      logger,
      suppressedSenderEmails: ['blocked@example.com'],
    });
    const broken = {
      ...makeMockMessage({ id: 'broken', threadId: 'thread-broken', from: [{ email: 'pat@example.com' }] }),
      attachments: undefined,
    } as unknown as NylasMessage;
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeMockMessage({ id: 'sent', threadId: 'thread-sent', folders: ['SENT'], from: [{ email: CEO_EMAIL }] }),
      makeMockMessage({ id: 'self', threadId: 'thread-self', from: [{ email: SELF_EMAIL }] }),
      makeMockMessage({ id: 'excluded', threadId: 'thread-ex', from: [{ email: 'blocked@example.com' }] }),
      makeMockMessage({ id: 'good', threadId: 'thread-good', from: [{ email: 'ada@example.com' }] }),
      broken,
    ]);

    await adapter.start();

    const audit = pollEvents(mocks.bus);
    expect(audit).toHaveLength(1);
    const { payload } = audit[0]!;
    expect(payload.fetched).toBe(5);
    expect(payload.processed).toBe(1);
    expect(payload.skipped).toEqual({
      sent_folder: 1,
      recently_sent: 0,
      self: 1,
      excluded: 1,
      failed: 1,
      deferred: 0,
      already_staged: 0,
    });
    const skippedTotal = Object.values(payload.skipped).reduce((sum, n) => sum + n, 0);
    expect(payload.processed + skippedTotal).toBe(payload.fetched);

    const failed = failureLogs(entries);
    expect(failed).toEqual([
      expect.objectContaining({ messageId: 'broken', threadId: 'thread-broken' }),
    ]);

    await adapter.drainInFlight();
    await adapter.stop();
  });

  it('logs a delivery failure after handoff, and still warns when the sender is unverified', async () => {
    const mocks = createMocks();
    const { logger, entries } = collectLogs();
    const adapter = makeAdapter(mocks, { logger });
    (mocks.bus.publish as ReturnType<typeof vi.fn>).mockImplementation((_layer: string, event: BusEvent) => {
      if (event.type === 'inbound.message') return Promise.reject(new Error('bus down'));
      return Promise.resolve();
    });
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeMockMessage({ id: 'msg-fail', threadId: 'thread-fail', from: [{ email: 'ada@example.com' }] }),
    ]);

    await adapter.start();
    await adapter.drainInFlight();

    const audit = pollEvents(mocks.bus);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload.processed).toBe(1);
    expect(audit[0]!.payload.skipped.failed).toBe(0);
    // Pre-handoff failures keep a different message. This rejection is delivery.
    expect(failureLogs(entries)).toEqual([]);
    expect(entries).toContainEqual(expect.objectContaining({
      msg: 'Email received with senderVerified: false — SPF/DKIM/DMARC did not all pass or headers were absent',
      messageId: 'msg-fail',
    }));
    expect(entries).toContainEqual(expect.objectContaining({
      msg: 'Inbound email turn failed after handoff — not retried',
      messageId: 'msg-fail',
      threadId: 'thread-fail',
      conversationId: 'email:thread-fail',
    }));

    await adapter.stop();
  });

  it('still applies reply-loop guards while a turn is in flight', async () => {
    const mocks = createMocks();
    const triggerOutbound = captureHandler('outbound.message', mocks);
    const adapter = makeAdapter(mocks);
    const gate = hangInbound(mocks.bus);
    const list = mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>;

    const live = makeMockMessage({
      id: 'inbound-1',
      threadId: 'thread-live',
      from: [{ email: CEO_EMAIL }],
    });
    list.mockResolvedValueOnce([live]);
    await adapter.start();
    expect(gate.started).toEqual(['inbound-1']);

    (mocks.outboundGateway.send as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      messageId: 'sent-loop-id',
    });
    // Thread lookup for the outbound reply (limit 1), not the next inbox poll.
    list.mockResolvedValueOnce([live]);
    await triggerOutbound(createOutboundMessage({
      conversationId: 'email:thread-live',
      channelId: 'email',
      content: 'Reply in flight.',
      parentEventId: 'task-1',
    }));

    list.mockResolvedValueOnce([
      makeMockMessage({
        id: 'sent-loop-id',
        threadId: 'thread-sent-id',
        from: [{ email: 'alias@example.com' }],
        folders: ['INBOX'],
      }),
      makeMockMessage({
        id: 'in-sent',
        threadId: 'thread-folder',
        from: [{ email: CEO_EMAIL }],
        folders: ['SENT'],
      }),
      makeMockMessage({
        id: 'from-self',
        threadId: 'thread-self',
        from: [{ email: 'curia+tag@example.com' }],
        folders: ['INBOX'],
      }),
      makeMockMessage({
        id: 'legit-2',
        threadId: 'thread-other',
        from: [{ email: 'ada@example.com' }],
        folders: ['INBOX'],
      }),
    ]);

    await pollNow(adapter);

    expect(gate.started).toEqual(['inbound-1', 'legit-2']);
    const secondPoll = pollEvents(mocks.bus).at(-1)!;
    expect(secondPoll.payload.fetched).toBe(4);
    expect(secondPoll.payload.processed).toBe(1);
    expect(secondPoll.payload.skipped).toMatchObject({
      sent_folder: 1,
      recently_sent: 1,
      self: 1,
      excluded: 0,
      failed: 0,
      deferred: 0,
      already_staged: 0,
    });

    gate.release('inbound-1');
    gate.release('legit-2');
    await adapter.drainInFlight();
    await adapter.stop();
  });

  it('runs the older message first when Nylas returns the thread newest-first', async () => {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks);
    const gate = hangInbound(mocks.bus);
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeMockMessage({
        id: 'newer',
        threadId: 'thread-same',
        date: 1_700_000_100,
        from: [{ email: 'ada@example.com' }],
      }),
      makeMockMessage({
        id: 'older',
        threadId: 'thread-same',
        date: 1_700_000_000,
        from: [{ email: 'ada@example.com' }],
      }),
    ]);

    await adapter.start();
    expect(gate.started).toEqual(['older']);

    gate.release('older');
    await vi.waitFor(() => {
      expect(gate.started).toEqual(['older', 'newer']);
    });
    gate.release('newer');
    await adapter.drainInFlight();
    await adapter.stop();
  });

  it('serves a thread already waiting before one that arrives in a later poll', async () => {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks, { maxConcurrentTurns: 1 });
    const gate = hangInbound(mocks.bus);
    const list = mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>;
    list
      .mockResolvedValueOnce([
        makeMockMessage({ id: 'a1', threadId: 'thread-a', from: [{ email: 'a@example.com' }] }),
        makeMockMessage({ id: 'b1', threadId: 'thread-b', from: [{ email: 'b@example.com' }] }),
      ])
      .mockResolvedValueOnce([
        makeMockMessage({ id: 'c1', threadId: 'thread-c', from: [{ email: 'c@example.com' }] }),
      ]);

    await adapter.start();
    expect(gate.started).toEqual(['a1']);

    await pollNow(adapter);
    expect(gate.started).toEqual(['a1']);

    gate.release('a1');
    await vi.waitFor(() => {
      expect(gate.started).toEqual(['a1', 'b1']);
    });

    gate.release('b1');
    await vi.waitFor(() => {
      expect(gate.started).toEqual(['a1', 'b1', 'c1']);
    });
    gate.release('c1');
    await adapter.drainInFlight();
    await adapter.stop();
  });

  it('does not start a queued turn after stop()', async () => {
    vi.useFakeTimers();
    const mocks = createMocks();
    const { logger, entries } = collectLogs();
    const adapter = makeAdapter(mocks, {
      logger,
      maxConcurrentTurns: 1,
      pollingIntervalMs: 7_200_000,
    });
    const gate = hangInbound(mocks.bus);
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeMockMessage({ id: 'busy', threadId: 'thread-a', from: [{ email: 'a@example.com' }] }),
      makeMockMessage({ id: 'queued', threadId: 'thread-b', from: [{ email: 'b@example.com' }] }),
    ]);

    await adapter.start();
    expect(gate.started).toEqual(['busy']);

    const stopping = adapter.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await stopping;

    gate.release('busy');
    await adapter.drainInFlight();
    expect(gate.started).toEqual(['busy']);
    expect(entries).toContainEqual(expect.objectContaining({
      msg: 'Email adapter stopped with inbound mail still queued — message dropped',
      messageId: 'queued',
      threadId: 'thread-b',
      conversationId: 'email:thread-b',
    }));
  });

  it('skips a second poll while the first is still extracting participants', async () => {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks);
    let releaseResolve: (value: { id: string }) => void = () => {};
    const held = new Promise<{ id: string }>((resolve) => {
      releaseResolve = resolve;
    });
    (mocks.contactService.resolveByChannelIdentity as ReturnType<typeof vi.fn>).mockReturnValue(held);
    const list = mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>;
    list.mockResolvedValue([
      makeMockMessage({ id: 'held', threadId: 'thread-held', from: [{ email: 'ada@example.com' }] }),
    ]);

    const starting = adapter.start();
    await Promise.resolve();
    await pollNow(adapter);
    expect(list).toHaveBeenCalledTimes(1);

    releaseResolve({ id: 'existing' });
    await starting;
    await adapter.drainInFlight();
    await adapter.stop();
  });

  it('keeps the watermark at the last write-ahead and retries the rest', async () => {
    const mocks = createMocks();
    const { logger, entries } = collectLogs();
    const adapter = makeAdapter(mocks, { logger });
    const nowSec = Math.floor(Date.now() / 1000);
    const olderDate = nowSec + 10;
    const newerDate = nowSec + 30;
    const publish = mocks.bus.publish as unknown as (layer: string, event: BusEvent) => Promise<void>;
    let newerAttempts = 0;
    (mocks.bus.stagePublish as ReturnType<typeof vi.fn>).mockImplementation(
      async (layer: string, event: BusEvent) => {
        if (inboundId(event) === 'newer' && newerAttempts++ === 0) throw new Error('audit down');
        return { deliver: () => publish(layer, event) };
      },
    );
    const messages = [
      makeMockMessage({
        id: 'newer',
        threadId: 'thread-new',
        date: newerDate,
        from: [{ email: 'new@example.com' }],
      }),
      makeMockMessage({
        id: 'older',
        threadId: 'thread-old',
        date: olderDate,
        from: [{ email: 'old@example.com' }],
      }),
    ];
    const list = mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>;
    // receivedAfter is an inclusive lower bound: date >= receivedAfter.
    list.mockImplementation(async (opts: { receivedAfter: number }) => (
      messages.filter((message) => message.date >= opts.receivedAfter)
    ));

    await adapter.start();
    const first = pollEvents(mocks.bus)[0]!;
    expect(first.payload.processed).toBe(1);
    expect(first.payload.skipped.failed).toBe(0);
    expect(first.payload.skipped.deferred).toBe(1);
    expect(first.payload.fetched).toBe(2);
    expect(entries).toContainEqual(expect.objectContaining({
      msg: 'Inbound email write-ahead failed — will retry next poll',
      messageId: 'newer',
      threadId: 'thread-new',
    }));
    expect(failureLogs(entries)).toEqual([]);

    await pollNow(adapter);
    const secondCall = list.mock.calls[1]![0] as { receivedAfter: number };
    expect(secondCall.receivedAfter).toBe(olderDate + 1);
    const second = pollEvents(mocks.bus).at(-1)!;
    expect(second.payload.processed).toBe(1);
    expect(second.payload.skipped.failed).toBe(0);
    expect(second.payload.skipped.deferred).toBe(0);
    expect(second.payload.fetched).toBe(1);
    const delivered = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .map((args) => args[1] as BusEvent)
      .filter((event) => inboundId(event) === 'newer');
    expect(delivered).toHaveLength(1);

    await adapter.drainInFlight();
    await adapter.stop();
  });

  it('retries a write-ahead failure that shares a second with the message before it', async () => {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks);
    const nowSec = Math.floor(Date.now() / 1000);
    const sharedDate = nowSec + 20;
    const publish = mocks.bus.publish as unknown as (layer: string, event: BusEvent) => Promise<void>;
    let secondAttempts = 0;
    (mocks.bus.stagePublish as ReturnType<typeof vi.fn>).mockImplementation(
      async (layer: string, event: BusEvent) => {
        if (inboundId(event) === 'second' && secondAttempts++ === 0) throw new Error('audit down');
        return { deliver: () => publish(layer, event) };
      },
    );
    const messages = [
      makeMockMessage({
        id: 'first',
        threadId: 'thread-first',
        date: sharedDate,
        from: [{ email: 'first@example.com' }],
      }),
      makeMockMessage({
        id: 'second',
        threadId: 'thread-second',
        date: sharedDate,
        from: [{ email: 'second@example.com' }],
      }),
    ];
    const list = mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>;
    list.mockImplementation(async (opts: { receivedAfter: number }) => (
      messages.filter((message) => message.date >= opts.receivedAfter)
    ));

    await adapter.start();
    expect(pollEvents(mocks.bus)[0]!.payload.skipped.deferred).toBe(1);

    await pollNow(adapter);
    const secondCall = list.mock.calls[1]![0] as { receivedAfter: number };
    expect(secondCall.receivedAfter).toBe(sharedDate);
    const second = pollEvents(mocks.bus).at(-1)!;
    expect(second.payload.fetched).toBe(2);
    expect(second.payload.processed).toBe(1);
    expect(second.payload.skipped.already_staged).toBe(1);
    expect(second.payload.skipped.failed).toBe(0);
    const delivered = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .map((args) => args[1] as BusEvent)
      .map((event) => inboundId(event))
      .filter((id) => id === 'first' || id === 'second');
    expect(delivered).toEqual(['first', 'second']);

    await adapter.drainInFlight();
    await adapter.stop();
  });

  it('skips a message after repeated write-ahead failures and continues the batch', async () => {
    const mocks = createMocks();
    const { logger, entries } = collectLogs();
    const adapter = makeAdapter(mocks, { logger });
    const nowSec = Math.floor(Date.now() / 1000);
    const publish = mocks.bus.publish as unknown as (layer: string, event: BusEvent) => Promise<void>;
    (mocks.bus.stagePublish as ReturnType<typeof vi.fn>).mockImplementation(
      async (layer: string, event: BusEvent) => {
        if (inboundId(event) === 'poison') throw new Error('lone surrogate');
        return { deliver: () => publish(layer, event) };
      },
    );
    const messages = [
      makeMockMessage({
        id: 'after',
        threadId: 'thread-after',
        date: nowSec + 40,
        from: [{ email: 'after@example.com' }],
      }),
      makeMockMessage({
        id: 'poison',
        threadId: 'thread-poison',
        date: nowSec + 10,
        from: [{ email: 'poison@example.com' }],
      }),
    ];
    const list = mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>;
    list.mockImplementation(async (opts: { receivedAfter: number }) => (
      messages.filter((message) => message.date >= opts.receivedAfter)
    ));

    await adapter.start();
    expect(adapter.inboundWriteAheadDegraded).toBe(false);
    for (let poll = 1; poll < WRITE_AHEAD_RETRY_LIMIT - 1; poll++) {
      await pollNow(adapter);
    }
    expect(adapter.inboundWriteAheadDegraded).toBe(false);
    expect(pollEvents(mocks.bus).at(-1)!.payload.skipped.failed).toBe(0);

    await pollNow(adapter);
    const last = pollEvents(mocks.bus).at(-1)!;
    expect(last.payload.fetched).toBe(2);
    expect(last.payload.processed).toBe(1);
    expect(last.payload.skipped.failed).toBe(1);
    expect(last.payload.skipped.deferred).toBe(0);
    expect(adapter.inboundWriteAheadDegraded).toBe(false);
    expect(entries).toContainEqual(expect.objectContaining({
      msg: 'Inbound email write-ahead failed — skipping message after repeated failures',
      messageId: 'poison',
    }));
    const delivered = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .map((args) => args[1] as BusEvent)
      .map((event) => inboundId(event))
      .filter((id) => id === 'after' || id === 'poison');
    expect(delivered).toEqual(['after']);

    await adapter.drainInFlight();
    await adapter.stop();
  });

  it('fails email health when write-ahead keeps failing across polls', async () => {
    const mocks = createMocks();
    const adapter = makeAdapter(mocks, { pollingIntervalMs: 60_000 });
    const nowSec = Math.floor(Date.now() / 1000);
    (mocks.bus.stagePublish as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('audit down'));
    const messages = [
      makeMockMessage({
        id: 'later',
        threadId: 'thread-later',
        date: nowSec + 40,
        from: [{ email: 'later@example.com' }],
      }),
      makeMockMessage({
        id: 'first',
        threadId: 'thread-first',
        date: nowSec + 10,
        from: [{ email: 'first@example.com' }],
      }),
    ];
    const list = mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>;
    list.mockImplementation(async (opts: { receivedAfter: number }) => (
      messages.filter((message) => message.date >= opts.receivedAfter)
    ));

    await adapter.start();
    await pollNow(adapter);
    expect(checkEmail(adapter, 3, new Date())).toBe('ok');
    await pollNow(adapter);
    expect(adapter.inboundWriteAheadDegraded).toBe(true);
    expect(checkEmail(adapter, 3, new Date())).toBe('fail');

    await adapter.stop();
  });

  it('fails email health when every slot is held past 15 minutes', async () => {
    vi.useFakeTimers();
    const mocks = createMocks();
    const { logger, entries } = collectLogs();
    const adapter = makeAdapter(mocks, {
      logger,
      maxConcurrentTurns: 1,
      pollingIntervalMs: 60_000,
    });
    const gate = hangInbound(mocks.bus);
    const list = mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>;
    list.mockResolvedValueOnce([
      makeMockMessage({ id: 'stuck', threadId: 'thread-stuck', from: [{ email: 'ada@example.com' }] }),
    ]).mockResolvedValue([]);

    try {
      await adapter.start();
      expect(checkEmail(adapter, 3, new Date())).toBe('ok');

      await vi.advanceTimersByTimeAsync(EMAIL_INBOUND_TURN_STALL_MS);
      expect(checkEmail(adapter, 3, new Date())).toBe('fail');
      expect(entries).toContainEqual(expect.objectContaining({
        msg: 'Email adapter: inbound turn still running past the stall bound',
        thresholdMs: EMAIL_INBOUND_TURN_STALL_MS,
        conversationId: 'email:thread-stuck',
      }));
    } finally {
      gate.release('stuck');
      await adapter.drainInFlight();
      await adapter.stop();
    }
  });

  it('stays email-ok when a long turn still has a free slot', async () => {
    vi.useFakeTimers();
    const mocks = createMocks();
    const adapter = makeAdapter(mocks, { maxConcurrentTurns: 4, pollingIntervalMs: 60_000 });
    let releaseTurn: () => void = () => {};
    (mocks.bus.publish as ReturnType<typeof vi.fn>).mockImplementation((_layer: string, event: BusEvent) => {
      if (event.type !== 'inbound.message') return Promise.resolve();
      return new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
    });
    const list = mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>;
    list.mockResolvedValueOnce([
      makeMockMessage({ id: 'slow', threadId: 'thread-slow', from: [{ email: 'ada@example.com' }] }),
    ]).mockResolvedValue([]);

    try {
      await adapter.start();
      await vi.advanceTimersByTimeAsync(EMAIL_INBOUND_TURN_STALL_MS);
      expect(adapter.inboundInFlight).toBe(1);
      expect(adapter.inboundMaxConcurrentTurns).toBe(4);
      expect(adapter.inboundStalledTurns).toBe(1);
      expect(adapter.oldestInboundPendingAgeMs).toBeNull();
      expect(checkEmail(adapter, 3, new Date())).toBe('ok');
    } finally {
      releaseTurn();
      await adapter.drainInFlight();
      await adapter.stop();
    }
  });

  it('fails email health when queued mail waits past the stall bound', async () => {
    vi.useFakeTimers();
    const mocks = createMocks();
    const adapter = makeAdapter(mocks, { maxConcurrentTurns: 4, pollingIntervalMs: 60_000 });
    const gate = hangInbound(mocks.bus);
    const list = mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>;
    list.mockResolvedValueOnce([
      makeMockMessage({
        id: 'newer',
        threadId: 'thread-same',
        date: 1_700_000_200,
        from: [{ email: 'ada@example.com' }],
      }),
      makeMockMessage({
        id: 'older',
        threadId: 'thread-same',
        date: 1_700_000_100,
        from: [{ email: 'ada@example.com' }],
      }),
    ]).mockResolvedValue([]);

    try {
      await adapter.start();
      expect(adapter.inboundInFlight).toBe(1);
      expect(adapter.inboundPending).toBe(1);
      expect(checkEmail(adapter, 3, new Date())).toBe('ok');
      await vi.advanceTimersByTimeAsync(EMAIL_INBOUND_TURN_STALL_MS);
      expect(adapter.inboundStalledTurns).toBe(1);
      expect(adapter.inboundMaxConcurrentTurns).toBe(4);
      expect(checkEmail(adapter, 3, new Date())).toBe('fail');
    } finally {
      // stop() drops the queued follower before the in-flight turn is released,
      // so that follower never starts. Fake timers would not fire the drain
      // timeout while the turn is still hung.
      const stopping = adapter.stop();
      gate.release('older');
      await stopping;
    }
  });

  it('does not persist the watermark or emit channel.poll when stop drops the batch', async () => {
    const mocks = createMocks();
    const { logger, entries } = collectLogs();
    const configStore = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue({ stored: true }),
    } as unknown as ConfigStore;
    const adapter = makeAdapter(mocks, { logger, configStore });
    const publish = mocks.bus.publish as unknown as (layer: string, event: BusEvent) => Promise<void>;
    let releaseStage: () => void = () => {};
    let stageEntered: () => void = () => {};
    const stageEnteredPromise = new Promise<void>((resolve) => {
      stageEntered = resolve;
    });
    (mocks.bus.stagePublish as ReturnType<typeof vi.fn>).mockImplementation(
      (layer: string, event: BusEvent) => {
        stageEntered();
        return new Promise<{ deliver: () => Promise<void> }>((resolve) => {
          releaseStage = () => resolve({ deliver: () => publish(layer, event) });
        });
      },
    );
    const nowSec = Math.floor(Date.now() / 1000);
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeMockMessage({
        id: 'mid-poll',
        threadId: 'thread-mid',
        date: nowSec + 10,
        from: [{ email: 'mid@example.com' }],
      }),
    ]);

    const starting = adapter.start();
    await stageEnteredPromise;
    await adapter.stop();
    releaseStage();
    await starting;

    expect(pollEvents(mocks.bus)).toHaveLength(0);
    expect(configStore.set).not.toHaveBeenCalled();
    expect(entries).toContainEqual(expect.objectContaining({
      msg: 'Email adapter stopped with inbound mail still queued — message dropped',
      messageId: 'mid-poll',
    }));
  });

  it('replays unacknowledged inbound mail before the first poll and does not stage it again', async () => {
    const mocks = createMocks();
    const { logger, entries } = collectLogs();
    const replayed = {
      id: 'event-replayed',
      timestamp: new Date(),
      type: 'inbound.message' as const,
      sourceLayer: 'channel' as const,
      payload: {
        conversationId: 'email:thread-replay',
        channelId: 'email',
        accountId: 'curia',
        senderId: 'ada@example.com',
        content: 'Still waiting',
        metadata: {
          nylasMessageId: 'replayed',
          nylasThreadId: 'thread-replay',
          subject: 'Waiting',
          senderVerified: false,
        },
      },
    };
    const adapter = makeAdapter(mocks, {
      logger,
      unacknowledgedInbound: {
        listUnacknowledgedInbound: vi.fn().mockResolvedValue([replayed]),
      },
    });
    const nowSec = Math.floor(Date.now() / 1000);
    (mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      makeMockMessage({
        id: 'replayed',
        threadId: 'thread-replay',
        date: nowSec + 5,
        from: [{ email: 'ada@example.com' }],
      }),
    ]);

    await adapter.start();
    await adapter.drainInFlight();

    expect(mocks.bus.deliverPersisted as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(replayed);
    expect(mocks.bus.stagePublish).not.toHaveBeenCalled();
    const audit = pollEvents(mocks.bus);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload.fetched).toBe(1);
    expect(audit[0]!.payload.processed).toBe(0);
    expect(audit[0]!.payload.skipped.already_staged).toBe(1);
    expect(entries).toContainEqual(expect.objectContaining({
      msg: 'Unacknowledged inbound mail queued for replay',
      messageId: 'replayed',
      replayed: true,
    }));
    expect(entries.some((entry) => entry.msg === 'Email received and queued')).toBe(false);
    expect(entries.some((entry) => (
      entry.msg === 'Email received with senderVerified: false — SPF/DKIM/DMARC did not all pass or headers were absent'
    ))).toBe(false);

    await adapter.stop();
  });

  it('warns when inbound replay fills its limit', async () => {
    const mocks = createMocks();
    const { logger, entries } = collectLogs();
    const events = Array.from({ length: INBOUND_REPLAY_LIMIT }, (_, index) => ({
      id: `event-replay-${index}`,
      timestamp: new Date(),
      type: 'inbound.message' as const,
      sourceLayer: 'channel' as const,
      payload: {
        conversationId: `email:thread-${index}`,
        channelId: 'email',
        accountId: 'curia',
        senderId: 'ada@example.com',
        content: 'queued',
        metadata: { nylasMessageId: `nylas-${index}`, nylasThreadId: `thread-${index}` },
      },
    }));
    const adapter = makeAdapter(mocks, {
      logger,
      unacknowledgedInbound: {
        listUnacknowledgedInbound: vi.fn().mockResolvedValue(events),
      },
    });

    await adapter.start();
    expect(entries).toContainEqual(expect.objectContaining({
      msg: 'Email adapter: inbound replay hit its limit — further rows in the window wait for the next start',
      count: INBOUND_REPLAY_LIMIT,
      limit: INBOUND_REPLAY_LIMIT,
    }));
    expect(MAX_STAGED_INBOUND_IDS).toBe(INBOUND_REPLAY_LIMIT + EMAIL_POLL_PAGE_SIZE);

    await adapter.drainInFlight();
    await adapter.stop();
  });

  it('retries a database outage without skipping the message', async () => {
    const mocks = createMocks();
    const { logger, entries } = collectLogs();
    const adapter = makeAdapter(mocks, { logger, pollingIntervalMs: 60_000 });
    const nowSec = Math.floor(Date.now() / 1000);
    const publish = mocks.bus.publish as unknown as (layer: string, event: BusEvent) => Promise<void>;
    const outagePolls = WRITE_AHEAD_POLL_FAIL_LIMIT + 2;
    let attempts = 0;
    (mocks.bus.stagePublish as ReturnType<typeof vi.fn>).mockImplementation(
      async (layer: string, event: BusEvent) => {
        if (attempts++ < outagePolls) {
          throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        }
        return { deliver: () => publish(layer, event) };
      },
    );
    const messages = [
      makeMockMessage({
        id: 'during-outage',
        threadId: 'thread-outage',
        date: nowSec + 15,
        from: [{ email: 'ada@example.com' }],
      }),
    ];
    const list = mocks.outboundGateway.listEmailMessages as ReturnType<typeof vi.fn>;
    list.mockImplementation(async (opts: { receivedAfter: number }) => (
      messages.filter((message) => message.date >= opts.receivedAfter)
    ));

    await adapter.start();
    for (let poll = 1; poll < outagePolls; poll++) await pollNow(adapter);
    const duringOutage = pollEvents(mocks.bus);
    expect(duringOutage).toHaveLength(outagePolls);
    for (const poll of duringOutage) {
      expect(poll.payload.skipped.failed).toBe(0);
      expect(poll.payload.processed).toBe(0);
    }
    expect(adapter.inboundWriteAheadDegraded).toBe(true);
    expect(checkEmail(adapter, 3, new Date())).toBe('fail');
    expect(entries.some((entry) => (
      entry.msg === 'Inbound email write-ahead failed — skipping message after repeated failures'
    ))).toBe(false);

    await pollNow(adapter);
    const recovered = pollEvents(mocks.bus).at(-1)!;
    expect(recovered.payload.processed).toBe(1);
    expect(recovered.payload.skipped.failed).toBe(0);
    const delivered = (mocks.bus.publish as ReturnType<typeof vi.fn>).mock.calls
      .map((args) => args[1] as BusEvent)
      .filter((event) => inboundId(event) === 'during-outage');
    expect(delivered).toHaveLength(1);

    await adapter.drainInFlight();
    await adapter.stop();
  });
});
