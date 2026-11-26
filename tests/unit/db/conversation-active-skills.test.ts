// Conversation skill carry (#2764 / ADR-070): idle TTL, cap, MRU ordering.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import {
  CONVERSATION_ACTIVE_SKILLS_CAP,
  CONVERSATION_ACTIVE_SKILLS_IDLE_TTL_MS,
  PgConversationActiveSkillsStore,
} from '../../../src/db/conversation-active-skills.js';
import type { Logger } from '../../../src/logger.js';

function createLogger(): Logger {
  return {
    child: () => createLogger(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: 'info',
  } as unknown as Logger;
}

describe('PgConversationActiveSkillsStore', () => {
  let query: ReturnType<typeof vi.fn>;
  let store: PgConversationActiveSkillsStore;
  let logger: Logger;

  beforeEach(() => {
    query = vi.fn();
    logger = createLogger();
    store = new PgConversationActiveSkillsStore(
      { query } as unknown as Pool,
      logger,
    );
  });

  it('defaults idle TTL to 24h and the cap to 8 (owner decisions)', () => {
    expect(CONVERSATION_ACTIVE_SKILLS_IDLE_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(CONVERSATION_ACTIVE_SKILLS_CAP).toBe(8);
  });

  it('listActive queries within the idle window, MRU first, with the cap', async () => {
    query.mockResolvedValueOnce({ rows: [{ skill: 'browser' }, { skill: 'tasks' }] });
    const now = new Date('2026-11-26T18:00:00.000Z');
    const skills = await store.listActive('conv-1', 'coordinator', now);

    expect(skills).toEqual(['browser', 'tasks']);
    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain('conversation_active_skills');
    expect(sql).toContain('ORDER BY last_used_at DESC');
    expect(sql).toContain('LIMIT');
    expect(params[0]).toBe('conv-1');
    expect(params[1]).toBe('coordinator');
    // cutoff = now - 24h
    expect(params[2]).toBe(new Date(now.getTime() - CONVERSATION_ACTIVE_SKILLS_IDLE_TTL_MS).toISOString());
    expect(params[3]).toBe(CONVERSATION_ACTIVE_SKILLS_CAP);
  });

  it('listActive honours configured idleTtlMs and cap', async () => {
    const custom = new PgConversationActiveSkillsStore(
      { query } as unknown as Pool,
      logger,
      { idleTtlMs: 60_000, cap: 3 },
    );
    query.mockResolvedValueOnce({ rows: [{ skill: 'email' }] });
    const now = new Date('2026-11-26T18:00:00.000Z');
    await custom.listActive('c', 'a', now);
    const params = query.mock.calls[0]![1] as unknown[];
    expect(params[2]).toBe(new Date(now.getTime() - 60_000).toISOString());
    expect(params[3]).toBe(3);
  });

  it('listActive returns [] and logs when the query fails', async () => {
    query.mockRejectedValueOnce(new Error('relation missing'));
    await expect(store.listActive('c', 'a')).resolves.toEqual([]);
    expect(logger.error).toHaveBeenCalled();
  });

  it('touch upserts last_used_at then trims past the cap', async () => {
    query.mockResolvedValue({ rows: [] });
    const now = new Date('2026-11-26T18:00:00.000Z');
    await store.touch('conv-1', 'coordinator', 'browser', now);

    expect(query).toHaveBeenCalledTimes(2);
    const [upsertSql, upsertParams] = query.mock.calls[0]!;
    expect(upsertSql).toContain('INSERT INTO conversation_active_skills');
    expect(upsertSql).toContain('ON CONFLICT');
    expect(upsertParams).toEqual(['conv-1', 'coordinator', 'browser', now.toISOString()]);

    const [trimSql, trimParams] = query.mock.calls[1]!;
    expect(trimSql).toContain('DELETE FROM conversation_active_skills');
    expect(trimSql).toContain('OFFSET');
    expect(trimParams).toEqual(['conv-1', 'coordinator', CONVERSATION_ACTIVE_SKILLS_CAP]);
  });

  it('touch ignores blank skill names without querying', async () => {
    await store.touch('conv-1', 'coordinator', '   ');
    expect(query).not.toHaveBeenCalled();
  });

  it('touch rethrows after logging when the upsert fails', async () => {
    query.mockRejectedValueOnce(new Error('disk full'));
    await expect(store.touch('c', 'a', 'tasks')).rejects.toThrow('disk full');
    expect(logger.error).toHaveBeenCalled();
  });
});
