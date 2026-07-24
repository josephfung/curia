import { describe, it, expect, vi } from 'vitest';
import { AuditLogger } from '../../../src/audit/logger.js';
import type { DbPool } from '../../../src/db/connection.js';
import { createLogger } from '../../../src/logger.js';
import { createAgentTask } from '../../../src/bus/events.js';
import { isDbUnavailableError } from '../../../src/db/resilience.js';

describe('AuditLogger — database unavailable (#1381)', () => {
  it('fails fast on log() with classified DB outage (critical path)', async () => {
    const dbErr = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    const pool = {
      query: vi.fn().mockRejectedValue(dbErr),
    } as unknown as DbPool;

    const logger = new AuditLogger(pool, createLogger('error'));
    const event = createAgentTask({
      agentId: 'coordinator',
      conversationId: 'c1',
      channelId: 'cli',
      senderId: 'u',
      content: 'hi',
      parentEventId: 'parent-1',
    });

    await expect(logger.log(event)).rejects.toSatisfy((err: unknown) => {
      expect(isDbUnavailableError(err)).toBe(true);
      expect((err as { agentError?: { type: string } }).agentError?.type).toBe('DATABASE_UNAVAILABLE');
      return true;
    });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('retries markAcknowledged on transient DB blip (non-critical path)', async () => {
    const blip = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    const pool = {
      query: vi
        .fn()
        .mockRejectedValueOnce(blip)
        .mockResolvedValueOnce({ rowCount: 1, rows: [] }),
    } as unknown as DbPool;

    const logger = new AuditLogger(pool, createLogger('error'));
    await expect(logger.markAcknowledged('evt-1')).resolves.toBeUndefined();
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});
