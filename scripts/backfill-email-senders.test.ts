import { describe, it, expect, vi } from 'vitest';
import pg from 'pg';
import {
  planEmailSenderBackfill,
  runEmailSenderBackfill,
  type ResolvedEmailTurn,
} from './backfill-email-senders.js';

const ALICE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function turn(partial: Partial<ResolvedEmailTurn> & Pick<ResolvedEmailTurn, 'id' | 'conversationId'>): ResolvedEmailTurn {
  return {
    senderCount: 1,
    senderEmail: 'alice@example.com',
    contactMatches: 1,
    contactId: ALICE,
    ...partial,
  };
}

describe('planEmailSenderBackfill', () => {
  it('stamps a thread whose every unattributed turn resolves to one contact', () => {
    const plan = planEmailSenderBackfill([
      turn({ id: 'r1', conversationId: 'email:t1' }),
      turn({ id: 'r2', conversationId: 'email:t1' }),
    ]);
    expect(plan.updates).toEqual([
      { id: 'r1', contactId: ALICE },
      { id: 'r2', contactId: ALICE },
    ]);
    expect(plan.conversations).toEqual([
      { conversationId: 'email:t1', rows: 2, stamped: 2, status: 'complete', unresolved: [] },
    ]);
  });

  it('records a thread as partial when only some rows resolve, because the rest still mark it shared', () => {
    // Stamping 1 of 2 buys nothing for recall: the leftover null keeps the
    // conversation shared. The plan still applies it, but must not report success.
    const plan = planEmailSenderBackfill([
      turn({ id: 'r1', conversationId: 'email:t2' }),
      turn({ id: 'r2', conversationId: 'email:t2', senderEmail: 'stranger@example.com', contactMatches: 0, contactId: null }),
    ]);
    expect(plan.updates).toEqual([{ id: 'r1', contactId: ALICE }]);
    expect(plan.conversations).toEqual([
      {
        conversationId: 'email:t2',
        rows: 2,
        stamped: 1,
        status: 'partial',
        unresolved: [{ id: 'r2', reason: 'sender-not-a-contact' }],
      },
    ]);
  });

  it('reports a thread with no resolvable rows separately from a partial one', () => {
    const plan = planEmailSenderBackfill([
      turn({ id: 'r1', conversationId: 'email:t3', senderEmail: 'news@example.com', contactMatches: 0, contactId: null }),
    ]);
    expect(plan.updates).toEqual([]);
    expect(plan.conversations[0]?.status).toBe('none');
  });

  it('refuses a row whose content matched more than one sender', () => {
    // Ambiguity is the one thing that could attribute one person's words to
    // another, so it is never guessed.
    const plan = planEmailSenderBackfill([
      turn({ id: 'r1', conversationId: 'email:t4', senderCount: 2 }),
    ]);
    expect(plan.updates).toEqual([]);
    expect(plan.conversations[0]?.unresolved).toEqual([{ id: 'r1', reason: 'ambiguous-sender' }]);
  });

  it('refuses a row whose sender address maps to more than one contact', () => {
    const plan = planEmailSenderBackfill([
      turn({ id: 'r1', conversationId: 'email:t5', contactMatches: 2, contactId: BOB }),
    ]);
    expect(plan.updates).toEqual([]);
    expect(plan.conversations[0]?.unresolved).toEqual([{ id: 'r1', reason: 'ambiguous-contact' }]);
  });

  it('refuses a row with no matching inbound audit event', () => {
    const plan = planEmailSenderBackfill([
      turn({ id: 'r1', conversationId: 'email:t6', senderCount: 0, senderEmail: null, contactMatches: 0, contactId: null }),
    ]);
    expect(plan.updates).toEqual([]);
    expect(plan.conversations[0]?.unresolved).toEqual([{ id: 'r1', reason: 'no-audit-match' }]);
  });

  it('counts a multi-contact thread as complete — it is correctly shared, not broken', () => {
    const plan = planEmailSenderBackfill([
      turn({ id: 'r1', conversationId: 'email:t7', contactId: ALICE }),
      turn({ id: 'r2', conversationId: 'email:t7', senderEmail: 'bob@example.com', contactId: BOB }),
    ]);
    expect(plan.conversations[0]?.status).toBe('complete');
    expect(plan.summary.threadsMultiContact).toBe(1);
  });

  it('summarizes threads and rows for the operator', () => {
    const plan = planEmailSenderBackfill([
      turn({ id: 'r1', conversationId: 'email:a' }),
      turn({ id: 'r2', conversationId: 'email:b' }),
      turn({ id: 'r3', conversationId: 'email:b', contactMatches: 0, contactId: null, senderEmail: 'x@y.z' }),
      turn({ id: 'r4', conversationId: 'email:c', contactMatches: 0, contactId: null, senderEmail: 'n@y.z' }),
    ]);
    expect(plan.summary).toEqual({
      rows: 4,
      rowsStampable: 2,
      threads: 3,
      threadsComplete: 1,
      threadsPartial: 1,
      threadsNone: 1,
      threadsMultiContact: 0,
      contactsAffected: 1,
    });
  });
});

describe('runEmailSenderBackfill', () => {
  function poolFor(rows: unknown[], applied: { sql: string[]; params: unknown[][] }): pg.Pool {
    return {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.trim().startsWith('UPDATE')) {
          applied.sql.push(sql);
          if (params) applied.params.push(params);
          return { rows: [], rowCount: (params?.[0] as string[] | undefined)?.length ?? 0 };
        }
        return { rows, rowCount: rows.length };
      }),
    } as unknown as pg.Pool;
  }

  const resolvedRows = [
    { id: 'r1', conversation_id: 'email:t1', sender_count: '1', sender_email: 'alice@example.com', contact_matches: '1', contact_id: ALICE },
  ];

  it('writes nothing in a dry run', async () => {
    const applied = { sql: [] as string[], params: [] as unknown[][] };
    const report = await runEmailSenderBackfill(poolFor(resolvedRows, applied), { dryRun: true });
    expect(applied.sql).toEqual([]);
    expect(report.applied).toBe(0);
    expect(report.summary.rowsStampable).toBe(1);
  });

  it('applies the stamps when asked, and only to rows that are still null', async () => {
    const applied = { sql: [] as string[], params: [] as unknown[][] };
    const report = await runEmailSenderBackfill(poolFor(resolvedRows, applied), { dryRun: false });
    expect(applied.sql).toHaveLength(1);
    expect(applied.sql[0]).toContain('sender_contact_id IS NULL');
    expect(applied.params[0]?.[0]).toEqual(['r1']);
    expect(report.applied).toBe(1);
  });
});
