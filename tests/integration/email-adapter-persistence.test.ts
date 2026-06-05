// tests/integration/email-adapter-persistence.test.ts
//
// Integration tests for #846: email-adapter watermark persistence.
// Requires real Postgres (DATABASE_URL env); tests are skipped when not available.
//
// Stall-watchdog unit tests (mock-only, no DB) live in:
//   tests/unit/channels/email/email-adapter-watchdog.test.ts

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { ConfigStore } from '../../src/memory/config-store.js';
import { EmailAdapter } from '../../src/channels/email/email-adapter.js';
import { EventBus } from '../../src/bus/bus.js';
import type { ChannelPollEvent } from '../../src/bus/events.js';
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

