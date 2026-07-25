import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditLogger } from '../../../src/audit/logger.js';
import { createSilentLogger } from '../../../src/logger.js';
import { createInboundMessage, createLlmCall } from '../../../src/bus/events.js';
import { GENESIS_HASH, computeEntryHash, toHashTimestamp } from '../../../src/audit/hash-chain.js';
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
