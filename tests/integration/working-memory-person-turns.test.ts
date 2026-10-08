// The Postgres twin of tests/unit/memory/working-memory-person-turns.test.ts (#2061).
// Skips when DATABASE_URL is unset.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { WorkingMemory } from '../../src/memory/working-memory.js';
import { createLogger } from '../../src/logger.js';
import { requireCuriaTestDatabase } from './require-test-db.js';
import { PERSON_TURN_CONTENTS, seedPersonTurnConversation } from '../helpers/person-turns-fixture.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;
const CONVERSATION = 'person-turns-2061:conv';

describeIf('WorkingMemory.getPersonTurns (Postgres, #2061)', () => {
  let pool: pg.Pool;
  let memory: WorkingMemory;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    memory = WorkingMemory.createWithPostgres(pool, createLogger('error'));
  });

  afterAll(async () => {
    try {
      await pool.query('DELETE FROM working_memory WHERE conversation_id = $1', [CONVERSATION]);
    } finally {
      await pool.end();
    }
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM working_memory WHERE conversation_id = $1', [CONVERSATION]);
  });

  it('returns only the user turns a person sent, newest first', async () => {
    await seedPersonTurnConversation(memory, CONVERSATION, 'coordinator');
    await expect(memory.getPersonTurns(CONVERSATION, 'coordinator')).resolves.toEqual([...PERSON_TURN_CONTENTS].reverse());
  });

  it('leaves out an archived person turn', async () => {
    await seedPersonTurnConversation(memory, CONVERSATION, 'coordinator');
    await pool.query(
      `UPDATE working_memory SET archived = true WHERE conversation_id = $1 AND content = $2`,
      [CONVERSATION, PERSON_TURN_CONTENTS[0]],
    );
    await expect(memory.getPersonTurns(CONVERSATION, 'coordinator')).resolves.toEqual([PERSON_TURN_CONTENTS[1]]);
  });
});
