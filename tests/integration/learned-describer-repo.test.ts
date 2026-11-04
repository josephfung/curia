// activity_describers against Postgres (#2455, ADR-059): upsert, reads, and the
// rule that an operator's row is never overwritten by the learner.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { LearnedDescriberRepo } from '../../src/activity/learned-describer-repo.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('LearnedDescriberRepo against Postgres', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('inserts, replaces and reads rows, and leaves an operator row alone', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const repo = new LearnedDescriberRepo(client);
      const agentId = `agent-${randomUUID().slice(0, 8)}`;
      const words = { verb: 'logged', one: 'an expense', many: 'expenses', attempt: 'log an expense' };

      expect(await repo.get(agentId, 'sheet-append')).toBeNull();
      expect(await repo.upsert({ agentId, toolName: 'sheet-append', effect: 'write', descriptionHash: 'h1', source: 'learned', ...words })).toBe(true);
      expect(await repo.upsert({ agentId, toolName: 'sheet-append', effect: 'write', descriptionHash: 'h2', source: 'hint', ...words, verb: 'recorded' }))
        .toBe(true);
      expect(await repo.get(agentId, 'sheet-append')).toMatchObject({ verb: 'recorded', descriptionHash: 'h2', source: 'hint' });

      await client.query(
        `INSERT INTO activity_describers (agent_id, tool_name, effect, verb, one, many, attempt, description_hash, source)
         VALUES ($1, 'sheet-read', 'read', 'checked', 'the ledger', 'the ledger', 'check the ledger', 'old', 'operator')`,
        [agentId],
      );
      expect(await repo.upsert({ agentId, toolName: 'sheet-read', effect: 'write', descriptionHash: 'new', source: 'learned', ...words })).toBe(false);
      expect(await repo.get(agentId, 'sheet-read')).toMatchObject({ effect: 'read', one: 'the ledger', source: 'operator' });

      const mine = (await repo.list()).filter((row) => row.agentId === agentId).map((row) => row.toolName).sort();
      expect(mine).toEqual(['sheet-append', 'sheet-read']);

      await expect(client.query(
        `INSERT INTO activity_describers (agent_id, tool_name, effect, verb, one, many, attempt, description_hash, source)
         VALUES ($1, 'bad', 'delete', 'x', 'y', 'z', 'w', 'h', 'learned')`,
        [agentId],
      )).rejects.toThrow(/check constraint/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
