// tests/integration/outbound-context-recipients.test.ts
//
// #2261 (Fix B of #1848): entries record who they were sent to, a non-principal sender's
// turn reads only the entries sent to them, and the dispatcher stamps their reply on those
// entries for later principal turns and task wakes. The recipient match is a uuid[] ANY()
// and the stamp a conditional UPDATE, so the SQL is only meaningfully tested on Postgres.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { OutboundContextService } from '../../src/dispatch/outbound-context.js';
import { createSilentLogger } from '../../src/logger.js';

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

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT recipient_contact_ids, last_reply_at FROM outbound_context LIMIT 0');
    service = new OutboundContextService(pool, createSilentLogger());
  });

  afterAll(async () => {
    await pool.query('DELETE FROM outbound_context WHERE conversation_id = $1', [conversationId]);
    await pool.end();
  });

  async function register(content: string, recipientContactIds?: string[]): Promise<string> {
    return service.register({
      conversationId,
      channelId: 'signal',
      agentId,
      content,
      expectedReply: 'which lunch dates work',
      expiresInHours: 1,
      ...(recipientContactIds ? { recipientContactIds } : {}),
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

  it('records the reply on active entries only, and the waking agent sees it', async () => {
    const asked = await register('Any of these work for you: Tue Oct 27, Thu Nov 5?', [xiaopu]);
    const released = await register('Old ask', [xiaopu]);
    await service.releaseEntry(released);

    await service.recordReply([asked, released], { from: 'Xiaopu Fung', content: 'Thur\n Nov 5' });

    const entry = await service.getEntry(asked);
    expect(entry?.lastReply).toMatchObject({ from: 'Xiaopu Fung', preview: 'Thur Nov 5' });
    expect(entry?.lastReply?.at).toBeInstanceOf(Date);
    const { rows } = await pool.query<{ last_reply_at: Date | null }>('SELECT last_reply_at FROM outbound_context WHERE id = $1', [released]);
    expect(rows[0]!.last_reply_at).toBeNull();

    const replies = await service.getActiveWithReplies(agentId);
    expect(replies.map((e) => e.id)).toContain(asked);
    expect(await service.getActiveWithReplies(`someone-else-${randomUUID()}`)).toEqual([]);

    // The principal's block shows it on the entry.
    const block = service.formatInjectionBlock([entry!], 'Any luck with Xiaopu?');
    expect(block).toContain('latest message back from Xiaopu Fung, just now: "Thur Nov 5"');
  });
});
