// tests/integration/ceo-inbox-list-watermark.test.ts
//
// Integration tests for #866: ceo-inbox-list watermark management.
// Verifies that last_processed_at is read and written by the skill handler
// in code, not by the LLM, and that a future watermark is clamped and healed.
//
// Requires real Postgres (DATABASE_URL env); tests are skipped when not available.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import pino from 'pino';
import { KnowledgeGraphStore } from '../../src/memory/knowledge-graph.js';
import { EmbeddingService } from '../../src/memory/embedding.js';
import { EntityMemory } from '../../src/memory/entity-memory.js';
import { MemoryValidator } from '../../src/memory/validation.js';
import { ConfigStore } from '../../src/memory/config-store.js';
import { CeoInboxListHandler } from '../../skills/ceo-inbox-list/handler.js';
import type { SkillContext } from '../../src/skills/types.js';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

// Test-scoped namespace so tests cannot corrupt the production watermark even
// when DATABASE_URL points at a shared database.
const WATERMARK_NAMESPACE = 'ceo_inbox_test';
const WATERMARK_KEY = 'last_processed_at';

const SEED_WATERMARK = 1_000_000;

// Minimal Nylas message shape — only fields the handler reads.
function makeNylasMessage(id: string, date: number) {
  return {
    id,
    threadId: `thread-${id}`,
    date,
    subject: 'Test',
    from: [{ email: 'sender@example.com', name: 'Sender' }],
    to: [{ email: 'ceo@example.com', name: 'CEO' }],
    cc: [],
    snippet: 'snippet',
    unread: true,
    folders: ['INBOX'],
    attachments: [],
  };
}

// Return a fetch mock that answers with the given messages list.
function stubNylasMessages(messages: ReturnType<typeof makeNylasMessage>[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: messages }),
  } as unknown as Response);
}

// Minimal SkillContext with real entityMemory wired in.
function makeCtx(entityMemory: EntityMemory): SkillContext {
  return {
    input: { unread_only: true },
    secret(name: string) {
      if (name === 'nylas_api_key') return 'test-key';
      if (name === 'ceo_nylas_grant_id') return 'test-grant';
      // nylas_self_email not set — handler degrades gracefully.
      throw new Error(`unknown secret: ${name}`);
    },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    entityMemory,
  };
}

describeIf('ceo-inbox-list watermark (#866)', () => {
  let pool: pg.Pool;
  let entityMemory: EntityMemory;
  let configStore: ConfigStore;
  let handler: CeoInboxListHandler;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const logger = pino({ level: 'silent' });
    const embeddingService = EmbeddingService.createForTesting();
    const kgStore = KnowledgeGraphStore.createWithPostgres(pool, embeddingService, logger);
    const validator = new MemoryValidator(kgStore, embeddingService);
    entityMemory = new EntityMemory(kgStore, validator, embeddingService, logger);
    configStore = new ConfigStore(entityMemory, logger);
    // Pass the test namespace so the handler writes to an isolated scope and
    // never touches the production ceo_inbox watermark.
    handler = new CeoInboxListHandler(WATERMARK_NAMESPACE);

    await pool.query('SELECT 1 FROM kg_nodes LIMIT 0');
  });

  afterAll(async () => {
    // Remove the test fact node and its edges. Leave the namespace anchor.
    await pool.query(
      `DELETE FROM kg_edges WHERE target_node_id IN (
        SELECT id FROM kg_nodes WHERE label = $1
      )`,
      [WATERMARK_KEY],
    );
    await pool.query('DELETE FROM kg_nodes WHERE label = $1', [WATERMARK_KEY]);
    await pool.end();
  });

  beforeEach(async () => {
    // Reset the stored watermark before each test.
    await configStore.set(WATERMARK_NAMESPACE, WATERMARK_KEY, String(SEED_WATERMARK));
  });

  it('advances watermark to max(date) of returned messages', async () => {
    const msgs = [
      makeNylasMessage('a', SEED_WATERMARK + 10),
      makeNylasMessage('b', SEED_WATERMARK + 30),
      makeNylasMessage('c', SEED_WATERMARK + 20),
    ];

    vi.stubGlobal('fetch', stubNylasMessages(msgs));

    const ctx = makeCtx(entityMemory);
    const result = await handler.execute(ctx);

    expect(result.success).toBe(true);
    const data = result.data as { count: number };
    expect(data.count).toBe(3);

    // Give the async ConfigStore write time to complete.
    await new Promise((r) => setTimeout(r, 200));

    const stored = await configStore.get(WATERMARK_NAMESPACE, WATERMARK_KEY);
    // Should advance to max(date) = SEED_WATERMARK + 30
    expect(stored).toBe(String(SEED_WATERMARK + 30));
  });

  it('does not advance watermark on an empty run', async () => {
    vi.stubGlobal('fetch', stubNylasMessages([]));

    const ctx = makeCtx(entityMemory);
    await handler.execute(ctx);

    await new Promise((r) => setTimeout(r, 200));

    const stored = await configStore.get(WATERMARK_NAMESPACE, WATERMARK_KEY);
    // Watermark must remain unchanged — nothing arrived, nothing to advance past.
    expect(stored).toBe(String(SEED_WATERMARK));
  });

  it('clamps a future watermark, returns the backlog, and heals the stored value', async () => {
    // Poison the watermark to 29 days in the future — the exact bug from #866.
    const nowBeforeRun = Math.floor(Date.now() / 1_000);
    const futureTs = nowBeforeRun + 29 * 24 * 3600;
    await configStore.set(WATERMARK_NAMESPACE, WATERMARK_KEY, String(futureTs));

    // Messages with dates in the recent past (the "blind window" backlog).
    const msgs = [
      makeNylasMessage('d', nowBeforeRun - 3600),
      makeNylasMessage('e', nowBeforeRun - 1800),
    ];

    vi.stubGlobal('fetch', stubNylasMessages(msgs));

    const ctx = makeCtx(entityMemory);
    const result = await handler.execute(ctx);

    // The handler must return the backlog even though the stored watermark was in the future.
    expect(result.success).toBe(true);
    const data = result.data as { count: number };
    expect(data.count).toBe(2);

    // The warn log must have fired for the future watermark.
    expect((ctx.log.warn as ReturnType<typeof vi.fn>).mock.calls.some(
      (call: unknown[]) => typeof call[1] === 'string' && call[1].includes('future'),
    )).toBe(true);

    // Give the async heal write time to complete.
    await new Promise((r) => setTimeout(r, 200));

    // Stored watermark must now be healed to ~now (not the future, not a past date).
    // The advance guard prevents the past message dates from overwriting the healed nowSeconds.
    const stored = await configStore.get(WATERMARK_NAMESPACE, WATERMARK_KEY);
    const storedNum = Number(stored);
    expect(storedNum).toBeGreaterThanOrEqual(nowBeforeRun); // healed to at least nowSeconds
    expect(storedNum).toBeLessThanOrEqual(Math.floor(Date.now() / 1_000) + 2); // not in the future
  });

  it('passes received_after = storedWatermark + 1 to Nylas', async () => {
    const fetchSpy = stubNylasMessages([]);
    vi.stubGlobal('fetch', fetchSpy);

    const ctx = makeCtx(entityMemory);
    await handler.execute(ctx);

    const url = new URL(fetchSpy.mock.calls[0]![0] as string);
    const receivedAfterParam = url.searchParams.get('received_after');
    // Must pass stored watermark + 1 for exclusive semantics.
    expect(receivedAfterParam).toBe(String(SEED_WATERMARK + 1));
  });
});
