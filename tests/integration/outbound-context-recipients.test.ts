// tests/integration/outbound-context-recipients.test.ts
//
// #2261 (Fix B of #1848): entries record who they were sent to, a non-principal sender's
// turn reads only the entries sent to them, and the dispatcher stamps their messages on
// those entries for later principal turns and task wakes. The recipient match is a uuid[]
// containment and the stamp a JSONB-trimming UPDATE, so the SQL is only meaningfully tested
// on Postgres.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { OutboundContextService } from '../../src/dispatch/outbound-context.js';
import { createSilentLogger } from '../../src/logger.js';
import { requireCuriaTestDatabase } from './require-test-db.js';

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf('outbound-context recipients and recorded replies (#2261)', () => {
  let pool: pg.Pool;
  let service: OutboundContextService;
  const conversationId = `test-recipients-${randomUUID()}`;
  // Fresh ids per run: the shared test DB carries other suites' entries.
  const xiaopu = randomUUID();
  const jeff = randomUUID();
  const agentId = `coordinator-${randomUUID()}`;
  // The suite UPDATEs and DELETEs rows, so it runs only once the target is curia_test.
  let dbVerified = false;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    dbVerified = true;
    await pool.query('SELECT recipient_contact_ids, recipient_messages, last_recipient_message_at FROM outbound_context LIMIT 0');
    service = new OutboundContextService(pool, createSilentLogger());
  });

  afterAll(async () => {
    if (dbVerified) {
      await pool.query('DELETE FROM outbound_context WHERE conversation_id = $1', [conversationId]);
    }
    await pool.end();
  });

  async function register(content: string, recipientContactIds?: string[], metadata?: Record<string, unknown>): Promise<string> {
    return service.register({
      conversationId,
      channelId: 'signal',
      agentId,
      content,
      expectedReply: 'which lunch dates work',
      expiresInHours: 1,
      ...(recipientContactIds ? { recipientContactIds } : {}),
      ...(metadata ? { metadata } : {}),
    });
  }

  it('reads only the active entries sent to a contact, case-insensitively', async () => {
    const toXiaopu = await register('Any of these work for you: Thu Nov 5?', [xiaopu.toUpperCase()]);
    const toBoth = await register('Lunch at Wildcraft?', [jeff, xiaopu]);
    const toJeff = await register('Does Thu Nov 5 work?', [jeff]);
    const legacy = await register('Sent before #2261');

    const ids = (await service.getActiveForRecipient(xiaopu)).map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining([toXiaopu, toBoth]));
    expect(ids).not.toContain(toJeff);
    expect(ids).not.toContain(legacy);

    const stored = await service.getEntry(toXiaopu);
    expect(stored?.recipientContactIds).toEqual([xiaopu]);
    expect((await service.getEntry(legacy))?.recipientContactIds).toBeNull();
  });

  it('skips released and expired entries', async () => {
    const released = await register('Released ask', [xiaopu]);
    const expired = await register('Expired ask', [xiaopu]);
    await service.releaseEntry(released);
    await pool.query(`UPDATE outbound_context SET expires_at = now() - interval '1 minute' WHERE id = $1`, [expired]);

    const ids = (await service.getActiveForRecipient(xiaopu)).map((e) => e.id);
    expect(ids).not.toContain(released);
    expect(ids).not.toContain(expired);
  });

  it('records the message on active entries only, and the waking agent sees it', async () => {
    const asked = await register('Any of these work for you: Tue Oct 27, Thu Nov 5?', [xiaopu]);
    const released = await register('Old ask', [xiaopu]);
    await service.releaseEntry(released);

    await service.recordReply([asked, released], { from: 'Xiaopu Fung', content: 'Thur\n Nov 5' });

    const entry = await service.getEntry(asked);
    expect(entry?.recipientMessages).toHaveLength(1);
    expect(entry?.recipientMessages[0]).toMatchObject({ from: 'Xiaopu Fung', preview: 'Thur Nov 5' });
    expect(entry?.recipientMessages[0]?.at).toBeInstanceOf(Date);
    const { rows } = await pool.query<{ last_recipient_message_at: Date | null; recipient_messages: unknown[] }>(
      'SELECT last_recipient_message_at, recipient_messages FROM outbound_context WHERE id = $1', [released],
    );
    expect(rows[0]!.last_recipient_message_at).toBeNull();
    expect(rows[0]!.recipient_messages).toEqual([]);

    const withMessages = await service.getActiveWithReplies(agentId);
    expect(withMessages.map((e) => e.id)).toContain(asked);
    expect(await service.getActiveWithReplies(`someone-else-${randomUUID()}`)).toEqual([]);

    // The principal's block shows it on the entry.
    const block = service.formatInjectionBlock([entry!], 'Any luck with Xiaopu?');
    expect(block).toContain('  - Xiaopu Fung, just now: "Thur Nov 5"');
  });

  it('keeps the first message and the latest two, so a follow-up never replaces the answer', async () => {
    const asked = await register('Which day works for lunch?', [xiaopu]);
    for (const content of ['Thur Nov 5', 'Can you resend the address?', 'Is it the one on Elgin?', 'Thanks!']) {
      await service.recordReply([asked], { from: 'Xiaopu Fung', content });
    }
    const previews = (await service.getEntry(asked))?.recipientMessages.map((m) => m.preview);
    expect(previews).toEqual(['Thur Nov 5', 'Is it the one on Elgin?', 'Thanks!']);
  });

  it('lists the waking task\'s own sends first, ahead of newer messages on other sends', async () => {
    const taskId = randomUUID();
    // A separate agent id so other tests' entries do not share the wake's cap.
    const wakeAgent = `coordinator-${randomUUID()}`;
    const reg = (content: string, metadata?: Record<string, unknown>) => service.register({
      conversationId, channelId: 'signal', agentId: wakeAgent, content, expiresInHours: 1,
      recipientContactIds: [xiaopu], ...(metadata ? { metadata } : {}),
    });
    const ownAsk = await reg('Which day works for lunch?', { bind_reply: true, task_id: taskId });
    await service.recordReply([ownAsk], { from: 'Xiaopu Fung', content: 'Thur Nov 5' });
    const others: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await reg(`Other ask ${i}`);
      await service.recordReply([id], { from: 'Xiaopu Fung', content: `answer ${i}` });
      others.push(id);
    }

    const forTask = await service.getActiveWithReplies(wakeAgent, taskId);
    expect(forTask[0]?.id).toBe(ownAsk);
    expect(forTask).toHaveLength(5);
    // Without the task, the cap keeps the five newest and the older ask drops out.
    expect((await service.getActiveWithReplies(wakeAgent)).map((e) => e.id)).not.toContain(ownAsk);
  });
});
