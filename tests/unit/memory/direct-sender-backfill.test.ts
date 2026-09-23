import { describe, it, expect, vi } from 'vitest';
import { backfillDirectChannelSenders } from '../../../src/memory/direct-sender-backfill.js';
import type { DbPool, DbPoolClient } from '../../../src/db/connection.js';
import type { Logger } from '../../../src/logger.js';

function logger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe('backfillDirectChannelSenders', () => {
  it('stamps Signal 1:1 and SMS in batches and leaves groups and the time bound out', async () => {
    const updates: string[] = [];
    const rowCounts = [2, 0, 1, 0];
    let updateIndex = 0;
    const client = {
      query: vi.fn(async (sql: string) => {
        const text = sql.replace(/\s+/g, ' ').trim();
        if (text.startsWith('UPDATE')) {
          updates.push(text);
          const rowCount = rowCounts[updateIndex] ?? 0;
          updateIndex += 1;
          return { rowCount };
        }
        return { rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as DbPool;

    const result = await backfillDirectChannelSenders(pool, logger(), { batchSize: 2 });

    expect(result).toEqual({ signalRows: 2, smsRows: 1 });
    expect(updates).toHaveLength(4);
    const signal = updates[0]!;
    const sms = updates[2]!;
    expect(signal).toContain("conversation_id NOT LIKE 'signal:group=%'");
    expect(signal).toContain("cci2.channel = 'signal'");
    expect(signal).toContain('sender_contact_id IS NULL');
    expect(signal).not.toContain('archived');
    expect(signal).not.toContain('7 days');
    expect(signal).toContain('LIMIT $1');
    expect(sms).toContain("cci2.channel = 'sms'");
    expect(sms).toContain("conversation_id LIKE 'sms:%'");
    expect(sms).not.toContain('signal:group');
    expect(sms).not.toContain('7 days');
    expect(client.query).toHaveBeenCalledWith("SET LOCAL statement_timeout = '5s'");
    expect(client.release).toHaveBeenCalled();
  });

  it('stops the channel on a batch error and still runs the other channel', async () => {
    let updates = 0;
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.replace(/\s+/g, ' ').trim().startsWith('UPDATE')) {
          updates += 1;
          if (updates === 1) throw new Error('lock timeout');
          return { rowCount: 0 };
        }
        return { rowCount: 0 };
      }),
      release: vi.fn(),
    } as unknown as DbPoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as DbPool;
    const log = logger();

    const result = await backfillDirectChannelSenders(pool, log, { batchSize: 2 });

    expect(result).toEqual({ signalRows: 0, smsRows: 0 });
    expect(log.error).toHaveBeenCalled();
    expect(updates).toBe(2);
  });
});
