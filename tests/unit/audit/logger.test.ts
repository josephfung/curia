import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditLogger } from '../../../src/audit/logger.js';
import { createSilentLogger } from '../../../src/logger.js';
import { createAgentTaskInputInjected, createInboundMessage, createLlmCall } from '../../../src/bus/events.js';
import { GENESIS_HASH, computeEntryHash, toHashTimestamp } from '../../../src/audit/hash-chain.js';
import {
  INBOUND_REPLAY_AGED_OUT_WARN_HOURS,
  INBOUND_REPLAY_LIMIT,
  INBOUND_REPLAY_MAX_AGE_HOURS,
} from '../../../src/audit/inbound-replay.js';
import type { Pool } from 'pg';

// Minimal mock pool that captures what gets written to the DB.
function makeMockPool() {
  const written: unknown[] = [];
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      // Hash-chain seed SELECT
      if (sql.includes('SELECT entry_hash FROM audit_log')) {
        return { rows: [], rowCount: 0 };
      }
      if (params) written.push(...params);
      return { rows: [], rowCount: 1 };
    }),
    connect: vi.fn(async () => {
      const client = {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params });
          if (params) written.push(...params);
          return { rows: [], rowCount: 1 };
        }),
        release: vi.fn(),
      };
      return client;
    }),
    written,
    queries,
  };
  return pool;
}

describe('AuditLogger.log — null byte sanitization', () => {
  let pool: ReturnType<typeof makeMockPool>;
  let logger: AuditLogger;

  beforeEach(async () => {
    pool = makeMockPool();
    logger = new AuditLogger(pool as unknown as Pool, createSilentLogger());
    await logger.seedHashChain();
  });

  it('strips null bytes from a string field in the payload', async () => {
    const event = createInboundMessage({
      conversationId: 'conv-1',
      channelId: 'test',
      senderId: 'sender',
      // Simulate a web-fetch result that contains null bytes embedded in content
      content: 'before\u0000after',
    });

    await logger.log(event);

    // The payload parameter is the JSON.stringify'd payload written to audit_log.payload
    const serialized = pool.written.find(
      (p) => typeof p === 'string' && p.includes('before') && p.includes('after'),
    ) as string;

    expect(serialized).toBeDefined();
    expect(serialized).toContain('beforeafter');
    expect(serialized).not.toContain('\u0000');
  });

  it('strips null bytes nested inside objects and arrays', async () => {
    const event = createInboundMessage({
      conversationId: 'conv-2',
      channelId: 'test',
      senderId: 'sender',
      content: 'clean',
    });

    // Manually inject a deeply nested null byte into the payload to simulate
    // binary web-fetch content surfacing in a nested skill result structure
    (event.payload as unknown as Record<string, unknown>)['nested'] = {
      arr: ['a\u0000b', { deep: 'x\u0000y' }],
    };

    await logger.log(event);

    const payloadParam = pool.written.find(
      (p) => typeof p === 'string' && (p as string).includes('nested'),
    ) as string;

    expect(payloadParam).toBeDefined();
    expect(payloadParam).not.toContain('\u0000');
    expect(payloadParam).toContain('ab');
    expect(payloadParam).toContain('xy');
  });

  it('passes through payloads with no null bytes unchanged', async () => {
    const event = createInboundMessage({
      conversationId: 'conv-3',
      channelId: 'test',
      senderId: 'sender',
      content: 'clean content',
    });

    await logger.log(event);

    const payloadParam = pool.written.find(
      (p) => typeof p === 'string' && (p as string).includes('clean content'),
    ) as string;

    expect(payloadParam).toBeDefined();
    expect(JSON.parse(payloadParam)).toMatchObject({ content: 'clean content' });
  });

  it('does not throw on null, numeric, or boolean values in the payload', async () => {
    const event = createInboundMessage({
      conversationId: 'conv-4',
      channelId: 'test',
      senderId: 'sender',
      content: 'check',
    });

    (event.payload as unknown as Record<string, unknown>)['meta'] = {
      count: 42,
      flag: true,
      nothing: null,
    };

    await expect(logger.log(event)).resolves.toBeUndefined();
  });

  it('passes Date values through without mangling them to {}', async () => {
    // Date fields exist on live payload types (e.g. ContactMergedPayload.mergedAt,
    // HumanDecisionPayload.presentedAt/decidedAt). Object.entries(new Date()) returns []
    // which would cause Object.fromEntries to produce {} — silently destroying the value.
    const event = createInboundMessage({
      conversationId: 'conv-5',
      channelId: 'test',
      senderId: 'sender',
      content: 'check',
    });

    const ts = new Date('2026-04-10T08:30:00.000Z');
    (event.payload as unknown as Record<string, unknown>)['mergedAt'] = ts;

    await logger.log(event);

    const payloadParam = pool.written.find(
      (p) => typeof p === 'string' && (p as string).includes('mergedAt'),
    ) as string;

    expect(payloadParam).toBeDefined();
    const parsed = JSON.parse(payloadParam);
    // Must serialize as ISO string, not {}
    expect(parsed.mergedAt).toBe('2026-04-10T08:30:00.000Z');
  });
});

describe('AuditLogger.log — structured columns + hash chain', () => {
  let pool: ReturnType<typeof makeMockPool>;
  let logger: AuditLogger;

  beforeEach(async () => {
    pool = makeMockPool();
    logger = new AuditLogger(pool as unknown as Pool, createSilentLogger());
    await logger.seedHashChain();
  });

  it('populates structured columns for inbound.message and chains from genesis', async () => {
    const event = createInboundMessage({
      conversationId: 'conv-hash',
      channelId: 'email',
      senderId: 'ceo@example.com',
      content: 'hello',
    });

    await logger.log(event);

    const insert = pool.queries.find((q) => q.sql.includes('INSERT INTO audit_log'));
    expect(insert).toBeDefined();
    const params = insert!.params!;
    // Positional: action, outcome, target_type, target_id, initiator_type, initiator_id, entry_hash
    // are the last 7 params ($10..$16); $2 is event.timestamp (verbatim — never bumped)
    expect(params[1]).toBe(event.timestamp);
    expect(params[9]).toBe('receive');
    expect(params[10]).toBe('success');
    expect(params[11]).toBe('conversation');
    expect(params[12]).toBe('conv-hash');
    expect(params[13]).toBe('human');
    expect(params[14]).toBe('ceo@example.com');

    const entryHash = params[15] as string;
    expect(entryHash).toMatch(/^[a-f0-9]{64}$/);

    const expected = computeEntryHash(
      {
        id: event.id,
        timestamp: toHashTimestamp(event.timestamp),
        event_type: event.type,
        source_layer: event.sourceLayer,
        source_id: 'email',
        payload: event.payload,
        conversation_id: 'conv-hash',
        task_id: null,
        parent_event_id: null,
        action: 'receive',
        outcome: 'success',
        target_type: 'conversation',
        target_id: 'conv-hash',
        initiator_type: 'human',
        initiator_id: 'ceo@example.com',
      },
      GENESIS_HASH,
    );
    expect(entryHash).toBe(expected);
  });

  it('records an injected follow-up under the host task and the inbound parent (#2018)', async () => {
    const host = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const inbound = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const sender = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const event = createAgentTaskInputInjected({
      hostTaskEventId: host,
      inboundEventId: inbound,
      conversationId: 'signal:+1555',
      agentId: 'coordinator',
      drainPoint: 'turn_start',
      senderContactId: sender,
    });

    await logger.log(event);

    const insert = pool.queries.find((q) => q.sql.includes('INSERT INTO audit_log'));
    expect(insert).toBeDefined();
    const params = insert!.params!;
    // $7 conversation_id, $8 task_id, $9 parent_event_id
    expect(params[6]).toBe('signal:+1555');
    expect(params[7]).toBe(host);
    expect(params[8]).toBe(inbound);
    expect(params[9]).toBe('inject');
    expect(params[14]).toBe(sender);
  });

  it('writes llm_call_archive in a transaction when event.archive is set', async () => {
    const event = createLlmCall({
      agentId: 'coordinator',
      conversationId: 'conv-llm',
      requestedModel: 'claude-sonnet-4-6',
      actualModel: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      estimatedCostUsd: 0.001,
      latencyMs: 100,
      providerRequestId: 'req-1',
      promptHash: 'a'.repeat(64),
      responseHash: 'b'.repeat(64),
      parentEventId: 'task-1',
      archive: {
        prompt: { messages: [{ role: 'user', content: 'hi' }] },
        response: { type: 'text', content: 'hello' },
        toolDefinitions: [],
      },
    });

    await logger.log(event);

    expect(pool.connect).toHaveBeenCalled();
    const archiveInsert = pool.queries.find((q) => q.sql.includes('INSERT INTO llm_call_archive'));
    expect(archiveInsert).toBeDefined();
    // archive must not leak into audit_log.payload
    const auditInsert = pool.queries.find((q) => q.sql.includes('INSERT INTO audit_log'));
    const payloadJson = auditInsert!.params![5] as string;
    expect(payloadJson).not.toContain('"archive"');
    expect(payloadJson).not.toContain('hello');
  });

  it('skips llm_call_archive when llmCallArchiveEnabled is false', async () => {
    logger = new AuditLogger(pool as unknown as Pool, createSilentLogger(), {
      llmCallArchiveEnabled: false,
    });
    const event = createLlmCall({
      agentId: 'coordinator',
      conversationId: 'conv-llm-off',
      requestedModel: 'claude-sonnet-4-6',
      actualModel: 'claude-sonnet-4-6',
      provider: 'anthropic',
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      estimatedCostUsd: 0,
      latencyMs: 1,
      providerRequestId: 'req-off',
      promptHash: 'a'.repeat(64),
      responseHash: 'b'.repeat(64),
      parentEventId: 'task-off',
      archive: {
        prompt: { messages: [{ role: 'user', content: 'secret' }] },
        response: { type: 'text', content: 'x' },
      },
    });

    await logger.log(event);

    const archiveInsert = pool.queries.find((q) => q.sql.includes('INSERT INTO llm_call_archive'));
    expect(archiveInsert).toBeUndefined();
    expect(pool.queries.some((q) => q.sql.includes('INSERT INTO audit_log'))).toBe(true);
  });

  it('rejects nested log() inside the audit write transaction', async () => {
    const nestedPool = makeMockPool();
    const nestedLogger = new AuditLogger(nestedPool as unknown as Pool, createSilentLogger());
    // Make the head SELECT invoke a nested log — simulates publishing a bus event
    // from inside the write path (deadlock landmine).
    nestedPool.connect.mockImplementation(async () => {
      const client = {
        query: vi.fn(async (sql: string, params?: unknown[]) => {
          nestedPool.queries.push({ sql, params });
          if (sql.includes('pg_advisory_xact_lock') || sql.includes('BEGIN') || sql.includes('ROLLBACK')) {
            return { rows: [], rowCount: 0 };
          }
          if (sql.includes('ORDER BY seq DESC')) {
            await nestedLogger.log(createInboundMessage({
              conversationId: 'nested',
              channelId: 'test',
              senderId: 'x',
              content: 'should-fail',
            }));
            return { rows: [], rowCount: 0 };
          }
          if (params) nestedPool.written.push(...params);
          return { rows: [], rowCount: 1 };
        }),
        release: vi.fn(),
      };
      return client;
    });

    await expect(
      nestedLogger.log(createInboundMessage({
        conversationId: 'outer',
        channelId: 'test',
        senderId: 'x',
        content: 'outer',
      })),
    ).rejects.toThrow(/nested AuditLogger\.log/);
  });
});

describe('AuditLogger.listUnacknowledgedInbound', () => {
  const readable = {
    id: '11111111-1111-1111-1111-111111111111',
    timestamp: new Date('2026-10-24T12:00:00Z'),
    payload: {
      conversationId: 'email:thread-1',
      channelId: 'email',
      accountId: 'curia',
      senderId: 'ada@example.com',
      content: 'hello',
      metadata: { nylasMessageId: 'nylas-1' },
    },
    parent_event_id: null,
  };
  const unreadable = {
    id: '22222222-2222-2222-2222-222222222222',
    timestamp: new Date('2026-10-24T12:01:00Z'),
    payload: { conversationId: 'email:thread-2' },
    parent_event_id: 'parent-1',
  };

  function poolFor(rows: unknown[], excluded: { count: string; oldest: Date | null } = { count: '0', oldest: null }) {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('MIN(timestamp)')) {
          return { rows: [excluded], rowCount: 1 };
        }
        return { rows, rowCount: rows.length };
      }),
      queries,
    };
    return pool;
  }

  it('returns readable inbound rows for the account and skips a bad payload', async () => {
    const pool = poolFor([readable, unreadable]);
    const logger = new AuditLogger(pool as unknown as Pool, createSilentLogger());

    const events = await logger.listUnacknowledgedInbound('curia');

    const list = pool.queries.find((query) => query.sql.includes('NOT EXISTS'));
    expect(list?.sql).toContain("a.payload->>'accountId' = $1");
    expect(list?.sql).toContain("later.payload->'metadata'->>'nylasMessageId'");
    expect(list?.sql).toContain("now() - ($3::int * interval '1 hour')");
    expect(list?.params).toEqual(['curia', INBOUND_REPLAY_LIMIT, INBOUND_REPLAY_MAX_AGE_HOURS]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: readable.id,
      type: 'inbound.message',
      sourceLayer: 'channel',
      payload: readable.payload,
    });
  });

  it('warns with the count and oldest timestamp when rows fall outside the window', async () => {
    const oldest = new Date('2026-01-01T00:00:00Z');
    const pool = poolFor([readable], { count: '2', oldest });
    const warns: Array<{ fields: Record<string, unknown>; msg: string }> = [];
    const logger = new AuditLogger(pool as unknown as Pool, {
      error: () => {},
      warn: (fields: Record<string, unknown>, msg: string) => {
        warns.push({ fields, msg });
      },
      info: () => {},
      debug: () => {},
    } as unknown as ReturnType<typeof createSilentLogger>);

    const events = await logger.listUnacknowledgedInbound('curia');

    expect(events).toHaveLength(1);
    expect(warns).toEqual([
      {
        fields: {
          accountId: 'curia',
          count: 2,
          oldestTimestamp: oldest,
          maxAgeHours: INBOUND_REPLAY_MAX_AGE_HOURS,
          warnWindowHours: INBOUND_REPLAY_AGED_OUT_WARN_HOURS,
        },
        msg: 'Unacknowledged inbound mail older than the replay window was left out',
      },
    ]);
    const countQuery = pool.queries.find((query) => query.sql.includes('MIN(timestamp)'));
    expect(countQuery?.sql).toContain("timestamp > now() - ($3::int * interval '1 hour')");
    expect(countQuery?.params).toEqual([
      'curia',
      INBOUND_REPLAY_MAX_AGE_HOURS,
      INBOUND_REPLAY_AGED_OUT_WARN_HOURS,
    ]);
  });

  it('rehydrates metadata.receivedAt as a Date, as the live event carries it', async () => {
    const receivedAt = '2026-10-24T11:59:00.000Z';
    const pool = poolFor([
      { ...readable, payload: { ...readable.payload, metadata: { nylasMessageId: 'nylas-1', receivedAt } } },
    ]);
    const logger = new AuditLogger(pool as unknown as Pool, createSilentLogger());

    const [event] = await logger.listUnacknowledgedInbound('curia');

    const replayed = event!.payload.metadata?.receivedAt;
    expect(replayed).toBeInstanceOf(Date);
    expect((replayed as Date).toISOString()).toBe(receivedAt);
  });

  it('leaves a missing or unparseable receivedAt as it is', async () => {
    const pool = poolFor([
      readable,
      {
        ...readable,
        id: '33333333-3333-3333-3333-333333333333',
        payload: { ...readable.payload, metadata: { nylasMessageId: 'nylas-3', receivedAt: 'not-a-date' } },
      },
    ]);
    const logger = new AuditLogger(pool as unknown as Pool, createSilentLogger());

    const events = await logger.listUnacknowledgedInbound('curia');

    expect(events[0]!.payload.metadata).toEqual({ nylasMessageId: 'nylas-1' });
    expect(events[1]!.payload.metadata?.receivedAt).toBe('not-a-date');
  });
});
