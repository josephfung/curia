import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditLogger } from '../../../src/audit/logger.js';
import { createSilentLogger } from '../../../src/logger.js';
import { createInboundMessage } from '../../../src/bus/events.js';
import type { DbPool } from '../../../src/db/connection.js';

// Minimal mock pool that captures what gets written to the DB.
function makeMockPool() {
  const written: unknown[] = [];
  const pool = {
    query: vi.fn(async (_sql: string, params?: unknown[]) => {
      if (params) written.push(...params);
      return { rows: [], rowCount: 1 };
    }),
    written,
  };
  return pool;
}

describe('AuditLogger.log — null byte sanitization', () => {
  let pool: ReturnType<typeof makeMockPool>;
  let logger: AuditLogger;

  beforeEach(() => {
    pool = makeMockPool();
    logger = new AuditLogger(pool as unknown as DbPool, createSilentLogger());
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

    // The $6 parameter is the JSON.stringify'd payload written to audit_log.payload
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
    (event.payload as Record<string, unknown>)['nested'] = {
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

    (event.payload as Record<string, unknown>)['meta'] = {
      count: 42,
      flag: true,
      nothing: null,
    };

    await expect(logger.log(event)).resolves.toBeUndefined();
  });
});
