// Conversation skill carry against real Postgres (#2764 / ADR-070).
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import {
  CONVERSATION_ACTIVE_SKILLS_CAP,
  CONVERSATION_ACTIVE_SKILLS_IDLE_TTL_MS,
  PgConversationActiveSkillsStore,
} from '../../src/db/conversation-active-skills.js';
import { createSilentLogger } from '../../src/logger.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

const CONV = 'test-conv-active-skills';
const AGENT = 'coordinator';

describeIf('conversation active skills store (#2764)', () => {
  let pool: pg.Pool;
  let store: PgConversationActiveSkillsStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    store = new PgConversationActiveSkillsStore(pool, createSilentLogger(), {
      idleTtlMs: CONVERSATION_ACTIVE_SKILLS_IDLE_TTL_MS,
      cap: CONVERSATION_ACTIVE_SKILLS_CAP,
    });
  });

  afterEach(async () => {
    await pool.query(
      'DELETE FROM conversation_active_skills WHERE conversation_id = $1',
      [CONV],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('returns skills within the idle TTL, MRU first, and drops expired ones', async () => {
    const now = new Date('2026-11-26T18:00:00.000Z');
    await store.touch(CONV, AGENT, 'tasks', new Date(now.getTime() - 60_000));
    await store.touch(CONV, AGENT, 'browser', now);
    await store.touch(
      CONV,
      AGENT,
      'email',
      new Date(now.getTime() - CONVERSATION_ACTIVE_SKILLS_IDLE_TTL_MS - 1),
    );

    const active = await store.listActive(CONV, AGENT, now);
    expect(active).toEqual(['browser', 'tasks']);
  });

  it('caps at 8, keeping the most recently used', async () => {
    const now = new Date('2026-11-26T18:00:00.000Z');
    for (let i = 0; i < 10; i++) {
      await store.touch(CONV, AGENT, `skill-${i}`, new Date(now.getTime() + i * 1000));
    }
    const active = await store.listActive(CONV, AGENT, new Date(now.getTime() + 20_000));
    expect(active).toHaveLength(CONVERSATION_ACTIVE_SKILLS_CAP);
    expect(active[0]).toBe('skill-9');
    expect(active).not.toContain('skill-0');
    expect(active).not.toContain('skill-1');
  });

  it('re-touching a skill moves it to the front', async () => {
    const t0 = new Date('2026-11-26T18:00:00.000Z');
    await store.touch(CONV, AGENT, 'mailbox', t0);
    await store.touch(CONV, AGENT, 'web', new Date(t0.getTime() + 1000));
    await store.touch(CONV, AGENT, 'mailbox', new Date(t0.getTime() + 2000));
    expect(await store.listActive(CONV, AGENT, new Date(t0.getTime() + 3000))).toEqual([
      'mailbox',
      'web',
    ]);
  });
});
