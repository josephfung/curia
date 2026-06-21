// tests/integration/debrief-clear-by-subject.test.ts
//
// Integration test for #975: clearBySubjects releases EVERY active entry for a
// named meeting, including entries that fall outside the bounded getActive()
// injection window — the bug was that only injected entry_ids got released.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { OutboundContextService } from '../../src/dispatch/outbound-context.js';
import { createSilentLogger } from '../../src/logger.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('clearBySubjects across the injection window (#975)', () => {
  let pool: pg.Pool;
  let service: OutboundContextService;
  let runId: string;

  // Register N entries for one subject in the same conversation, spaced so the
  // most recent push older ones out of any small getActive() window.
  async function registerForSubject(subject: string, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await service.register({
        conversationId: `conv-${runId}`,
        channelId: 'signal',
        agentId: 'meeting-debrief',
        content: `Debrief nudge for ${subject} (#${i})`,
        expectedReply: `CEO's takeaways for ${subject}`,
        delegationHint: 'meeting-debrief',
        metadata: { subject, eventId: `evt-${runId}-${subject}-${i}` },
        expiresInHours: 48,
      });
    }
  }

  beforeAll(async () => {
    runId = randomUUID();
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1 FROM outbound_context LIMIT 0');
    service = new OutboundContextService(pool, createSilentLogger());

    // 12 active entries total across 3 meetings — more than getActive()'s LIMIT 10.
    await registerForSubject('Sean Brownlee', 4);
    await registerForSubject('Khanjan Desai', 2);
    await registerForSubject('Walk and Ice cream', 3);
    await registerForSubject('Drinks & AI', 3); // intentionally NOT cleared
  });

  afterAll(async () => {
    try {
      await pool.query(`DELETE FROM outbound_context WHERE conversation_id = $1`, [`conv-${runId}`]);
    } finally {
      await pool.end();
    }
  });

  it('releases every matching active entry even though the injection window is bounded', async () => {
    // This run created 12 active entries in one conversation; the bounded
    // injection view (getActive's LIMIT 10) structurally cannot show them all,
    // so at least some of this meeting's entries are invisible to any single
    // turn — exactly the window the bug fell into. Assert that explicitly
    // rather than the vacuous "<= 10" (always true given LIMIT 10).
    const totalActive = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM outbound_context WHERE conversation_id = $1 AND released = false`,
      [`conv-${runId}`],
    );
    expect(Number(totalActive.rows[0]!.n)).toBe(12);
    const active = await service.getActive(10);
    const mineActive = active.filter((e) => e.conversationId === `conv-${runId}`);
    expect(mineActive.length).toBeLessThan(12); // some of this run's entries fall outside the window

    const result = await service.clearBySubjects([
      'Sean Brownlee',
      'khanjan desai', // case-insensitive
      'Walk and Ice cream',
      'Nonexistent Meeting', // unmatched
    ]);

    expect(result.totalReleased).toBe(9);
    expect(result.perSubject).toEqual(
      expect.arrayContaining([
        { subject: 'Sean Brownlee', released: 4 },
        { subject: 'khanjan desai', released: 2 },
        { subject: 'Walk and Ice cream', released: 3 },
      ]),
    );
    expect(result.unmatched).toEqual(['Nonexistent Meeting']);

    // Verify directly in the DB: 0 active rows remain for the three cleared subjects,
    // and the un-cleared "Drinks & AI" subject is untouched (3 still active).
    const remaining = await pool.query<{ subject: string; n: string }>(
      `SELECT metadata->>'subject' AS subject, count(*)::text AS n
         FROM outbound_context
        WHERE conversation_id = $1 AND released = false
        GROUP BY metadata->>'subject'`,
      [`conv-${runId}`],
    );
    const bySubject = new Map(remaining.rows.map((r) => [r.subject, Number(r.n)]));
    expect(bySubject.get('Sean Brownlee')).toBeUndefined();
    expect(bySubject.get('Khanjan Desai')).toBeUndefined();
    expect(bySubject.get('Walk and Ice cream')).toBeUndefined();
    expect(bySubject.get('Drinks & AI')).toBe(3);
  });
});
