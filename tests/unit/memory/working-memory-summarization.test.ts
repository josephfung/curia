/**
 * Unit tests for WorkingMemory context summarization.
 *
 * We test the PostgresBackend indirectly via the WorkingMemory.createWithPostgres()
 * factory, using a carefully controlled mock pool. This avoids a real DB while still
 * exercising the summarization logic paths.
 *
 * Acceptance criteria from issue #232:
 *   - Threshold triggers summarization
 *   - LLM condenses the oldest turns into a summary preserving decisions/entities/commitments
 *   - Summarized originals are marked archived = true
 *   - Condensed summary inserted as synthetic system turn at head of kept window
 *   - get() loads the summary instead of archived originals
 *   - Failed LLM call: skips summarization without aborting the agent turn
 */
import { describe, it, expect, vi, type MockedFunction } from 'vitest';
import { WorkingMemory, type SummarizationConfig } from '../../../src/memory/working-memory.js';
import type { LLMProvider } from '../../../src/agents/llm/provider.js';
import type { DbPool } from '../../../src/db/connection.js';

// ---------------------------------------------------------------------------
// Minimal mock pool builder
// ---------------------------------------------------------------------------

type QueryResult<T> = { rows: T[] };

/**
 * Builds a mock pg.Pool that routes `pool.query()` calls to the supplied handler,
 * and provides a mock client for transaction use via `pool.connect()`.
 */
function buildMockPool(
  queryHandler: (sql: string, params?: unknown[]) => QueryResult<unknown>,
): DbPool {
  // Mock client used inside transactions (BEGIN/COMMIT/ROLLBACK + DML)
  const mockClient = {
    query: vi.fn().mockImplementation((sql: string, params?: unknown[]) =>
      Promise.resolve(queryHandler(sql, params)),
    ),
    release: vi.fn(),
  };

  const pool = {
    query: vi.fn().mockImplementation((sql: string, params?: unknown[]) =>
      Promise.resolve(queryHandler(sql, params)),
    ),
    connect: vi.fn().mockResolvedValue(mockClient),
  } as unknown as DbPool;

  return pool;
}

// ---------------------------------------------------------------------------
// Helper: mock LLMProvider
// ---------------------------------------------------------------------------

function buildMockProvider(summaryText = 'SUMMARY: key decisions made.'): LLMProvider {
  return {
    id: 'mock',
    chat: vi.fn().mockResolvedValue({
      type: 'text' as const,
      content: summaryText,
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkingMemory — context summarization', () => {
  const CONV = 'conv-summarize';
  const AGENT = 'coordinator';

  const makeId = (i: number) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;

  /**
   * Build a pool that simulates:
   *  - INSERT of a new turn (no-op returns)
   *  - COUNT query returning activeCount
   *  - SELECT of oldest toArchiveCount turns (returns mock rows)
   *  - SELECT oldest kept turn created_at
   *  - Transaction: UPDATE archived=true, INSERT summary
   */
  function buildPool(activeCount: number, toArchiveCount: number): { pool: DbPool; mockProvider: LLMProvider } {
    const now = new Date('2026-01-01T12:00:00Z');
    const archivedRows = Array.from({ length: toArchiveCount }, (_, i) => ({
      id: makeId(i),
      role: 'user',
      content: `Turn ${i}`,
      created_at: new Date(now.getTime() + i * 1000),
    }));
    const oldestKeptAt = new Date(now.getTime() + toArchiveCount * 1000);

    const mockProvider = buildMockProvider();

    const queryHandler = (sql: string, _params?: unknown[]): QueryResult<unknown> => {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      if (normalized.startsWith('INSERT INTO working_memory')) {
        return { rows: [] };
      }
      if (normalized.startsWith('SELECT COUNT(*)')) {
        return { rows: [{ count: String(activeCount) }] };
      }
      if (normalized.startsWith('SELECT id, role, content, created_at')) {
        return { rows: archivedRows };
      }
      if (normalized.startsWith('SELECT created_at')) {
        return { rows: [{ created_at: oldestKeptAt }] };
      }
      // Transaction queries (BEGIN, COMMIT, UPDATE, INSERT summary)
      return { rows: [] };
    };

    return { pool: buildMockPool(queryHandler), mockProvider };
  }

  it('does not call LLM when active count is at or below threshold', async () => {
    const mockProvider = buildMockProvider();
    let insertCount = 0;
    let countQueried = false;

    const queryHandler = (sql: string): QueryResult<unknown> => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('INSERT INTO working_memory')) {
        insertCount++;
        return { rows: [] };
      }
      if (normalized.startsWith('SELECT COUNT(*)')) {
        countQueried = true;
        // Return exactly at threshold — should NOT trigger summarization
        return { rows: [{ count: '20' }] };
      }
      return { rows: [] };
    };

    const pool = buildMockPool(queryHandler);
    const config: SummarizationConfig = { threshold: 20, keepWindow: 10, provider: mockProvider };
    const memory = WorkingMemory.createWithPostgres(pool, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never, config);

    await memory.addTurn(CONV, AGENT, { role: 'user', content: 'Hello' });

    expect(insertCount).toBe(1);
    expect(countQueried).toBe(true);
    expect(mockProvider.chat).not.toHaveBeenCalled();
  });

  it('calls LLM when active count exceeds threshold', async () => {
    const { pool, mockProvider } = buildPool(21, 11); // 21 active, keep 10, archive 11
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    const config: SummarizationConfig = { threshold: 20, keepWindow: 10, provider: mockProvider };

    const memory = WorkingMemory.createWithPostgres(pool, logger, config);
    await memory.addTurn(CONV, AGENT, { role: 'user', content: 'Trigger turn' });

    expect(mockProvider.chat).toHaveBeenCalledOnce();
    // Verify the prompt includes the transcript of archived turns
    const callArg = (mockProvider.chat as MockedFunction<LLMProvider['chat']>).mock.calls[0]![0];
    const promptContent = callArg.messages[0]!.content as string;
    expect(promptContent).toContain('Turn 0');
    expect(promptContent).toContain('Condense');
  });

  it('archives old turns and inserts synthetic summary in a transaction', async () => {
    const toArchiveCount = 11;
    const { pool, mockProvider } = buildPool(21, toArchiveCount);
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    const config: SummarizationConfig = { threshold: 20, keepWindow: 10, provider: mockProvider };

    const memory = WorkingMemory.createWithPostgres(pool, logger, config);
    await memory.addTurn(CONV, AGENT, { role: 'user', content: 'Trigger turn' });

    // Retrieve the mock client used for the transaction
    const client = await (pool as unknown as { connect(): Promise<{ query: MockedFunction<() => unknown>; release: () => void }> }).connect();

    // BEGIN and COMMIT must have been called
    const clientCalls = (client.query as MockedFunction<() => unknown>).mock.calls.map((c) => (c[0] as string).trim());
    expect(clientCalls).toContain('BEGIN');
    expect(clientCalls).toContain('COMMIT');

    // UPDATE archived = true must reference the archived IDs
    const updateCall = clientCalls.find((sql) => sql.startsWith('UPDATE working_memory'));
    expect(updateCall).toBeDefined();

    // INSERT of synthetic summary must be present
    const insertCall = clientCalls.find((sql) => sql.startsWith('INSERT INTO working_memory'));
    expect(insertCall).toBeDefined();

    // Verify the summary content is the LLM's response
    const insertParams = (client.query as MockedFunction<() => unknown>).mock.calls.find(
      (c) => (c[0] as string).startsWith('INSERT INTO working_memory'),
    );
    // Third parameter ($3) is the summary content
    expect((insertParams![1] as string[])[2]).toContain('[Conversation summary]');
    expect((insertParams![1] as string[])[2]).toContain('SUMMARY: key decisions made.');
  });

  it('get() excludes archived rows (queries with archived = false)', async () => {
    const activeRows = [
      { role: 'system', content: '[Conversation summary]\nSome prior context.' },
      { role: 'user', content: 'Recent message' },
    ];
    let getQuery = '';
    const queryHandler = (sql: string): QueryResult<unknown> => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('SELECT role, content')) {
        getQuery = normalized;
        return { rows: activeRows };
      }
      return { rows: [] };
    };

    const pool = buildMockPool(queryHandler);
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    const memory = WorkingMemory.createWithPostgres(pool, logger);

    const history = await memory.getHistory(CONV, AGENT);

    // get() must filter by archived = false
    expect(getQuery).toContain('archived = false');
    expect(history).toHaveLength(2);
    expect(history[0]?.role).toBe('system');
    expect(history[0]?.content).toContain('[Conversation summary]');
    expect(history[1]?.content).toBe('Recent message');
  });

  it('skips summarization without throwing when LLM returns an error response', async () => {
    const errorProvider: LLMProvider = {
      id: 'mock',
      chat: vi.fn().mockResolvedValue({
        type: 'error' as const,
        error: { type: 'PROVIDER_ERROR', source: 'mock', message: 'oops', retryable: false, timestamp: new Date() },
      }),
    };

    let insertCount = 0;
    const queryHandler = (sql: string): QueryResult<unknown> => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('INSERT INTO working_memory')) {
        insertCount++;
        return { rows: [] };
      }
      if (normalized.startsWith('SELECT COUNT(*)')) {
        return { rows: [{ count: '21' }] };
      }
      if (normalized.startsWith('SELECT id, role')) {
        return { rows: [{ id: makeId(0), role: 'user', content: 'Old', created_at: new Date() }] };
      }
      if (normalized.startsWith('SELECT created_at')) {
        return { rows: [{ created_at: new Date() }] };
      }
      return { rows: [] };
    };

    const pool = buildMockPool(queryHandler);
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    const config: SummarizationConfig = { threshold: 20, keepWindow: 10, provider: errorProvider };

    const memory = WorkingMemory.createWithPostgres(pool, logger, config);

    // Should NOT throw — failed summarization is non-fatal
    await expect(memory.addTurn(CONV, AGENT, { role: 'user', content: 'Message' })).resolves.toBeUndefined();
    expect(insertCount).toBe(1); // The turn was still written
    expect((logger as unknown as { error: MockedFunction<() => void> }).error).toHaveBeenCalledOnce();
  });

  it('skips summarization without throwing when LLM call throws', async () => {
    const throwingProvider: LLMProvider = {
      id: 'mock',
      chat: vi.fn().mockRejectedValue(new Error('Network timeout')),
    };

    const queryHandler = (sql: string): QueryResult<unknown> => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('INSERT INTO working_memory')) return { rows: [] };
      if (normalized.startsWith('SELECT COUNT(*)')) return { rows: [{ count: '21' }] };
      if (normalized.startsWith('SELECT id, role')) {
        return { rows: [{ id: makeId(0), role: 'user', content: 'Old', created_at: new Date() }] };
      }
      if (normalized.startsWith('SELECT created_at')) return { rows: [{ created_at: new Date() }] };
      return { rows: [] };
    };

    const pool = buildMockPool(queryHandler);
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    const config: SummarizationConfig = { threshold: 20, keepWindow: 10, provider: throwingProvider };

    const memory = WorkingMemory.createWithPostgres(pool, logger, config);
    await expect(memory.addTurn(CONV, AGENT, { role: 'user', content: 'Message' })).resolves.toBeUndefined();
    expect((logger as unknown as { error: MockedFunction<() => void> }).error).toHaveBeenCalledOnce();
  });
});
