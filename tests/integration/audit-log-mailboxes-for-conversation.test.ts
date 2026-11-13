// findMailboxesForConversation against real Postgres (#2475, D8): the mailboxes a conversation's
// ceo-inbox tool calls touched, for the cheap provenance suffix on checkpoint extraction.
// audit_log is append-only, so the rows this suite seeds stay; each test uses its own random
// conversation id and reads nothing else.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { AuditLogRepo } from '../../src/audit/audit-log-repo.js';
import { createSilentLogger } from '../../src/logger.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('audit-log findMailboxesForConversation (#2475)', () => {
  let pool: pg.Pool;
  let repo: AuditLogRepo;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    repo = new AuditLogRepo(pool, createSilentLogger());
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seedResult(conversationId: string, toolName: string, data: unknown, eventType = 'tool.result', at?: Date): Promise<void> {
    await pool.query(
      `INSERT INTO audit_log (timestamp, event_type, source_layer, source_id, payload, conversation_id)
       VALUES (COALESCE($4::timestamptz, now()), $1, 'test-provenance', 'test-agent', $2::jsonb, $3)`,
      [eventType, JSON.stringify({ conversationId, toolName, result: { success: true, data } }), conversationId, at ?? null],
    );
  }

  it('returns the distinct mailboxes a conversation touched', async () => {
    const conv = `conv-${randomUUID()}`;
    const other = `conv-${randomUUID()}`;
    await seedResult(conv, 'ceo-inbox-read', { mailbox: 'work' });
    await seedResult(conv, 'ceo-inbox-draft-reply', { mailbox: 'work' });
    await seedResult(conv, 'ceo-inbox-archive', { mailbox: 'personal' });
    await seedResult(conv, 'ceo-inbox-list', { messages: [{ id: 'm1', mailbox: 'family' }, { id: 'm2', mailbox: 'work' }] });
    // Not ceo-inbox, not a result row, no mailbox, or another conversation: all ignored.
    await seedResult(conv, 'calendar-list', { mailbox: 'ignored-tool' });
    await seedResult(conv, 'ceo-inbox-read', { mailbox: 'ignored-invoke' }, 'tool.invoke');
    await seedResult(conv, 'ceo-inbox-label', { ok: true });
    await seedResult(other, 'ceo-inbox-read', { mailbox: 'ignored-conversation' });

    expect(await repo.findMailboxesForConversation(conv)).toEqual(['family', 'personal', 'work']);
  });

  it('with a since, reads only rows after it: touched since the last checkpoint (P14)', async () => {
    const conv = `conv-${randomUUID()}`;
    const since = new Date(Date.now() - 60 * 60_000);
    await seedResult(conv, 'ceo-inbox-read', { mailbox: 'old' }, 'tool.result', new Date(since.getTime() - 60_000));
    await seedResult(conv, 'ceo-inbox-read', { mailbox: 'new' });
    expect(await repo.findMailboxesForConversation(conv, since.toISOString())).toEqual(['new']);
    expect(await repo.findMailboxesForConversation(conv)).toEqual(['new', 'old']);
  });

  it('returns an empty list when the conversation touched no mailbox', async () => {
    expect(await repo.findMailboxesForConversation(`conv-${randomUUID()}`)).toEqual([]);
  });
});
