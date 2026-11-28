import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import {
  CONVERSATION_ACTIVE_SKILLS_IDLE_TTL_MS,
  conversationActiveSkillsIdleTtlMs,
  PgConversationActiveSkillsStore,
} from '../../../src/db/conversation-active-skills.js';

describe('conversationActiveSkillsIdleTtlMs (#2764)', () => {
  it('honours 0 hours: the schema allows it, and it means nothing carries', () => {
    expect(conversationActiveSkillsIdleTtlMs(0)).toBe(0);
  });

  it('converts positive hours to milliseconds', () => {
    expect(conversationActiveSkillsIdleTtlMs(2)).toBe(2 * 60 * 60 * 1000);
  });

  it('falls back to the 24-hour default when absent, negative or not a number', () => {
    for (const v of [undefined, -1, Number.NaN, '6']) {
      expect(conversationActiveSkillsIdleTtlMs(v)).toBe(CONVERSATION_ACTIVE_SKILLS_IDLE_TTL_MS);
    }
  });
});

describe('PgConversationActiveSkillsStore with a zero TTL (#2764)', () => {
  it('carries nothing, even a skill touched in the same millisecond, without querying', async () => {
    const now = new Date('2026-11-27T12:00:00.000Z');
    // A row stamped at exactly `now` would pass a `>=` cutoff of `now`.
    const query = vi.fn(async () => ({ rows: [{ skill: 'browser', last_used_at: now }] }));
    const store = new PgConversationActiveSkillsStore(
      { query } as unknown as Pool,
      { error: vi.fn() } as unknown as Logger,
      { idleTtlMs: 0 },
    );
    expect(await store.listActive('conv-1', 'coordinator', now)).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
