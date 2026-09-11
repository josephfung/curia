// Postgres counterpart of tests/unit/contacts/grant-recommendation-create-race.test.ts
// (issue #1067). The in-memory backend can only imitate ON CONFLICT; this suite
// races two inserts against the real UNIQUE (contact_id, permission) constraint.
//
// Cleanup is scoped to contacts this file created. Skips when DATABASE_URL is unset.

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import pg from 'pg';
import { ContactService } from '../../src/contacts/contact-service.js';
import { createSilentLogger } from '../../src/logger.js';
import {
  GRANT_REC_RACE_PERMISSION,
  assertConcurrentCreateGrantRecommendationRace,
  assertSequentialCreateGrantRecommendationDedup,
} from '../helpers/grant-recommendation-create-race.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('createGrantRecommendation race (issue #1067, postgres)', () => {
  let pool: pg.Pool;
  let service: ContactService;
  const createdContactIds: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1 FROM grant_recommendations LIMIT 0');
    service = ContactService.createWithPostgres(pool, undefined, createSilentLogger());
  });

  afterEach(async () => {
    if (createdContactIds.length > 0) {
      await pool.query('DELETE FROM contacts WHERE id = ANY($1::uuid[])', [createdContactIds]);
      createdContactIds.length = 0;
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  async function makeContact(displayName: string): Promise<string> {
    const contact = await service.createContact({ displayName, source: 'integration-test' });
    createdContactIds.push(contact.id);
    return contact.id;
  }

  it('concurrent creates persist one row; loser returns the winner\'s real id', async () => {
    const contactId = await makeContact('Grant Rec Create Race');
    await assertConcurrentCreateGrantRecommendationRace(service, contactId);
    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM grant_recommendations
       WHERE contact_id = $1 AND permission = $2`,
      [contactId, GRANT_REC_RACE_PERMISSION],
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it('sequential duplicate returns created:false with the persisted winner', async () => {
    const contactId = await makeContact('Grant Rec Sequential Dedup');
    await assertSequentialCreateGrantRecommendationDedup(service, contactId);
  });
});
