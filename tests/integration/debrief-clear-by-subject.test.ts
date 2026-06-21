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

    // 12 active entries total across 4 meetings — more than getActive()'s LIMIT 10.
    // Subjects are suffixed with runId because clearBySubjects matches by subject
    // GLOBALLY (it is conversation-agnostic), so generic titles would collide with
    // other tests' rows and release foreign data. The runId makes them unique.
    await registerForSubject(`Sean Brownlee ${runId}`, 4);
    await registerForSubject(`Khanjan Desai ${runId}`, 2);
    await registerForSubject(`Walk and Ice cream ${runId}`, 3);
    await registerForSubject(`Drinks & AI ${runId}`, 3); // intentionally NOT cleared
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

    // Prove a TARGETED (to-be-cleared) subject has at least one active row OUTSIDE
    // the bounded injection window — not just any row. "Sean Brownlee" is registered
    // first, so 11 of this run's entries are newer than its oldest row; that row is
    // therefore always beyond getActive's 10-row DESC cutoff, regardless of other
    // rows in a shared DB (they only push it further out). If clearBySubjects naively
    // released only what getActive surfaced, that out-of-window Sean row would survive
    // and fail the post-clear DB check below — which is the #975 regression this guards.
    const visibleIds = new Set((await service.getActive(10)).map((e) => e.id));
    const seanActive = await pool.query<{ id: string }>(
      `SELECT id FROM outbound_context
        WHERE conversation_id = $1 AND released = false
          AND lower(metadata->>'subject') = lower($2)`,
      [`conv-${runId}`, `Sean Brownlee ${runId}`],
    );
    const seanHasOutOfWindowRow = seanActive.rows.some((r) => !visibleIds.has(r.id));
    expect(seanHasOutOfWindowRow).toBe(true);

    const result = await service.clearBySubjects([
      `Sean Brownlee ${runId}`,
      `khanjan desai ${runId}`, // case-insensitive (name lowercased; runId already lowercase)
      `Walk and Ice cream ${runId}`,
      `Nonexistent Meeting ${runId}`, // unmatched
    ]);

    expect(result.totalReleased).toBe(9);
    expect(result.perSubject).toEqual(
      expect.arrayContaining([
        { subject: `Sean Brownlee ${runId}`, released: 4 },
        { subject: `khanjan desai ${runId}`, released: 2 },
        { subject: `Walk and Ice cream ${runId}`, released: 3 },
      ]),
    );
    expect(result.unmatched).toEqual([`Nonexistent Meeting ${runId}`]);

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
    expect(bySubject.get(`Sean Brownlee ${runId}`)).toBeUndefined();
    expect(bySubject.get(`Khanjan Desai ${runId}`)).toBeUndefined();
    expect(bySubject.get(`Walk and Ice cream ${runId}`)).toBeUndefined();
    expect(bySubject.get(`Drinks & AI ${runId}`)).toBe(3);
  });
});
