// tests/integration/email-adapter-persistence.test.ts
//
// Integration tests for #846: email-adapter watermark persistence and stall watchdog.
//
// Two test suites:
//   1. Persistence (describeIf — needs real Postgres) — verifies that restarting
//      the adapter resumes from the stored watermark and does not re-process old messages.
//   2. Stall watchdog (describe — no DB, uses fake timers) — verifies that channel.stalled
//      is emitted exactly once when no successful poll completes within 5 × pollingIntervalMs.

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { ConfigStore } from '../../src/memory/config-store.js';
import { EmailAdapter } from '../../src/channels/email/email-adapter.js';
import { EventBus } from '../../src/bus/bus.js';
import type { BusEvent, ChannelPollEvent, ChannelStalledEvent } from '../../src/bus/events.js';
import type { ContactService } from '../../src/contacts/contact-service.js';

const { Pool } = pg;

// Skip real-Postgres tests when DATABASE_URL is absent (local dev without Docker).
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

// Unique accountId for test isolation — never used in production.
const TEST_ACCOUNT_ID = 'test-persist-846';

// Seed watermark for the persistence tests: messages have dates just above this value so
// the adapter (which reads this persisted value instead of Date.now()) will advance it.
const SEED_WATERMARK = 999_999;

// Minimal NylasMessage-shaped object — only fields the adapter reads before
// calling convertNylasMessage(). Conversion fails on this minimal shape, which is
// caught per-message. The watermark advance (before conversion) is what we test.
function makeTestMessage(id: string, date: number) {
  return {
    id,
    threadId: `thread-${id}`,
    date,
    subject: 'Test subject',
    folders: ['INBOX'],
    from: [{ email: 'sender@example.com', name: 'Sender' }],
    to: [{ email: 'curia@example.com', name: 'Curia' }],
    cc: [],
    bcc: [],
    body: null,
    htmlBody: null,
    attachments: [],
    headers: {},
    unread: true,
  };
}

// Minimal ContactService mock — resolveByChannelIdentity returns null (no existing contacts)
// so the adapter attempts to create contacts (which immediately resolve without doing real work).
function makeContactService(): ContactService {
  return {
    resolveByChannelIdentity: vi.fn().mockResolvedValue(null),
    createContact: vi.fn().mockResolvedValue({ id: 'c-test', displayName: 'Test', status: 'provisional' }),
    linkIdentity: vi.fn().mockResolvedValue(undefined),
  } as unknown as ContactService;
}

// Shared adapter config, minus the fields that vary by test.
function makeAdapterConfig(
  bus: EventBus,
  gateway: ReturnType<typeof makeGateway>,
  configStore?: ConfigStore,
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
    configStore,
  };
}

// Minimal gateway mock — only listEmailMessages matters for these tests.
function makeGateway(listImpl: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue([])) {
  return {
    listEmailMessages: listImpl,
    send: vi.fn(),
    sendNotification: vi.fn(),
    createEmailDraft: vi.fn(),
    linkGatedAction: vi.fn(),
  };
}

// ── Persistence tests (real Postgres / KG required) ─────────────────────────

describeIf('email-adapter watermark persistence (#846)', () => {
  let pool: pg.Pool;
  let configStore: ConfigStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const logger = pino({ level: 'silent' });
    const embeddingService = EmbeddingService.createForTesting();
    const kgStore = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, logger);
    const validator = new MemoryValidator(kgStore, embeddingService);
    const entityMemory = new EntityMemory(kgStore, validator, embeddingService, logger);
    configStore = new ConfigStore(entityMemory, logger);

    // Fast-fail if KG tables are missing (migrations not yet run).
    await pool.query('SELECT 1 FROM kg_nodes LIMIT 0');
  });

  afterAll(async () => {
    // Clean up the test-specific fact nodes (label = test account key) and their edges.
    // The namespace anchor ('config:system:email-poll-state') is left in place — it is
    // harmless and may be shared with other config-store entries in the dev DB.
    await pool.query(
      `DELETE FROM kg_edges WHERE target_node_id IN (
        SELECT id FROM kg_nodes WHERE label = $1
      )`,
      [`${TEST_ACCOUNT_ID}.last_seen_at`],
    );
    await pool.query('DELETE FROM kg_nodes WHERE label = $1', [`${TEST_ACCOUNT_ID}.last_seen_at`]);
    await pool.end();
  });

  it('persists the watermark and resumes from it on restart (no-replay)', async () => {
    // Pre-seed the watermark so the adapter reads a past value instead of Date.now().
    // This lets us use message dates just above the seed without racing against the clock.
    await configStore.set('system:email-poll-state', `${TEST_ACCOUNT_ID}.last_seen_at`, String(SEED_WATERMARK));

    const msgs = [
      makeTestMessage('msg-a', SEED_WATERMARK + 1),
      makeTestMessage('msg-b', SEED_WATERMARK + 11),
      makeTestMessage('msg-c', SEED_WATERMARK + 21),
    ];
    // max date is SEED_WATERMARK + 21; watermark advances to SEED_WATERMARK + 22.
    const expectedWatermark = SEED_WATERMARK + 22;

    // First adapter run — ingest the three test messages.
    const adapter1 = new EmailAdapter(makeAdapterConfig(
      new EventBus(pino({ level: 'silent' })),
      makeGateway(vi.fn().mockResolvedValueOnce(msgs)),
      configStore,
    ));
    await adapter1.start();
    await adapter1.stop();

    // The watermark must now be persisted in the KG.
    const persisted = await configStore.get('system:email-poll-state', `${TEST_ACCOUNT_ID}.last_seen_at`);
    expect(persisted).toBe(String(expectedWatermark));

    // Second adapter run — verify receivedAfter uses the persisted watermark.
    const listFn = vi.fn().mockResolvedValueOnce([]);
    const adapter2 = new EmailAdapter(makeAdapterConfig(
      new EventBus(pino({ level: 'silent' })),
      makeGateway(listFn),
      configStore,
    ));
    await adapter2.start();
    await adapter2.stop();

    // The first call to listEmailMessages on the second adapter should use the persisted watermark.
    const [callOptions] = listFn.mock.calls[0]!;
    expect(callOptions.receivedAfter).toBe(expectedWatermark);
  });

  it('emits one channel.poll event per successful poll cycle with correct payload shape', async () => {
    const bus = new EventBus(pino({ level: 'silent' }));
    const pollEvents: ChannelPollEvent[] = [];
    bus.subscribe('channel.poll', 'system', async (evt) => {
      pollEvents.push(evt as ChannelPollEvent);
    });

    await configStore.set('system:email-poll-state', `${TEST_ACCOUNT_ID}.last_seen_at`, String(SEED_WATERMARK));

    const adapter = new EmailAdapter(makeAdapterConfig(
      bus,
      makeGateway(vi.fn().mockResolvedValueOnce([makeTestMessage('msg-poll', SEED_WATERMARK + 1)])),
      configStore,
    ));
    await adapter.start();
    await adapter.stop();

    expect(pollEvents).toHaveLength(1);
    const { payload } = pollEvents[0]!;
    expect(payload.accountId).toBe(TEST_ACCOUNT_ID);
    expect(payload.channel).toBe('email');
    expect(payload.fetched).toBe(1);
    // Conversion fails on the minimal mock shape — message lands in skipped.failed.
    // The important thing is the payload shape is present and fetched reflects Nylas count.
    expect(typeof payload.processed).toBe('number');
    expect(typeof payload.skipped.sent_folder).toBe('number');
    expect(typeof payload.durationMs).toBe('number');
    expect(payload.lastSeenAt).toBe(SEED_WATERMARK + 2); // date + 1
  });

  it('does not persist the watermark when no messages are returned (idle poll)', async () => {
    await configStore.set('system:email-poll-state', `${TEST_ACCOUNT_ID}.last_seen_at`, String(SEED_WATERMARK));

    const adapter = new EmailAdapter(makeAdapterConfig(
      new EventBus(pino({ level: 'silent' })),
      makeGateway(vi.fn().mockResolvedValueOnce([])), // empty poll
      configStore,
    ));
    await adapter.start();
    await adapter.stop();

    // Watermark should remain at the seeded value — no write churn on idle polls.
    const afterIdle = await configStore.get('system:email-poll-state', `${TEST_ACCOUNT_ID}.last_seen_at`);
    expect(afterIdle).toBe(String(SEED_WATERMARK));
  });
});

// ── Stall watchdog test (no DB required — uses vi.useFakeTimers) ─────────────

describe('email-adapter stall watchdog (#846)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits exactly one channel.stalled when polls fail for > 5× pollingIntervalMs', async () => {
    vi.useFakeTimers();

    const capturedEvents: BusEvent[] = [];

    // Minimal mock bus — subscribe is a no-op (we don't need outbound handling),
    // publish records emitted events so we can assert on them.
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
});
