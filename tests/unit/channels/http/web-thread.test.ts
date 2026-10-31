import { describe, expect, it } from 'vitest';
import { getOrCreateWebThread, readClientMessageId } from '../../../../src/channels/http/web-thread.js';
import type { WebThreadQueryable } from '../../../../src/channels/http/web-thread.js';

function poolFrom(handler: (sql: string, params?: unknown[]) => { rows: Array<Record<string, unknown>>; rowCount?: number }): WebThreadQueryable & { sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    query: async (statement, params) => {
      sql.push(statement);
      return handler(statement, params);
    },
  };
}

describe('getOrCreateWebThread', () => {
  it('returns the stored thread without reading working memory', async () => {
    const pool = poolFrom((sql) => {
      if (sql.includes('FROM web_thread')) return { rows: [{ conversation_id: 'shared-1' }] };
      throw new Error(`unexpected ${sql}`);
    });
    await expect(getOrCreateWebThread(pool)).resolves.toBe('shared-1');
    await expect(getOrCreateWebThread(pool)).resolves.toBe('shared-1');
    expect(pool.sql).toHaveLength(1);
  });

  it('adopts the most recently active web conversation', async () => {
    const pool = poolFrom((sql) => {
      if (sql.includes('FROM working_memory')) return { rows: [{ conversation_id: 'latest-web' }] };
      if (sql.includes('INSERT INTO web_thread')) return { rows: [{ conversation_id: 'latest-web' }], rowCount: 1 };
      if (sql.includes('FROM web_thread')) return { rows: [] };
      throw new Error(`unexpected ${sql}`);
    });
    await expect(getOrCreateWebThread(pool)).resolves.toBe('latest-web');
    expect(pool.sql.some((sql) => sql.includes('ORDER BY MAX(created_at) DESC'))).toBe(true);
  });

  it('mints an id when there is no web history', async () => {
    const pool = poolFrom((sql) => {
      if (sql.includes('INSERT INTO web_thread')) return { rows: [{ conversation_id: 'fresh-1' }], rowCount: 1 };
      return { rows: [] };
    });
    await expect(getOrCreateWebThread(pool, { newId: () => 'fresh-1' })).resolves.toBe('fresh-1');
  });

  it('reads the winner when another caller inserted first', async () => {
    let selects = 0;
    const pool = poolFrom((sql) => {
      if (sql.includes('INSERT INTO web_thread')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM web_thread')) {
        selects += 1;
        return selects === 1 ? { rows: [] } : { rows: [{ conversation_id: 'winner' }] };
      }
      return { rows: [] };
    });
    await expect(getOrCreateWebThread(pool, { newId: () => 'loser' })).resolves.toBe('winner');
  });
});

describe('readClientMessageId', () => {
  it('keeps a uuid and drops anything that could not be an id', () => {
    expect(readClientMessageId('11111111-1111-4111-8111-111111111111')).toBe('11111111-1111-4111-8111-111111111111');
    expect(readClientMessageId('short')).toBeNull();
    expect(readClientMessageId('has spaces-in-it')).toBeNull();
    expect(readClientMessageId(12)).toBeNull();
  });
});
