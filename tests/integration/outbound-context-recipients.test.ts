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
import { ContactService } from '../../src/contacts/contact-service.js';

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

  const from = (contactId: string, content: string, name = 'Xiaopu Fung') => ({ from: name, contactId, content });

  it('records the message on active entries only, and the waking agent sees it', async () => {
    const asked = await register('Any of these work for you: Tue Oct 27, Thu Nov 5?', [xiaopu]);
    const released = await register('Old ask', [xiaopu]);
    await service.releaseEntry(released);

    await service.recordReply([asked, released], { ...from(xiaopu, 'Thur\n Nov 5'), riskScore: 0.2 });

    const entry = await service.getEntry(asked);
    expect(entry?.recipientMessages).toHaveLength(1);
    expect(entry?.recipientMessages[0]).toMatchObject({ from: 'Xiaopu Fung', contactId: xiaopu, preview: 'Thur Nov 5', riskScore: 0.2 });
    expect(entry?.recipientMessages[0]?.at).toBeInstanceOf(Date);
    const { rows } = await pool.query<{ last_recipient_message_at: Date | null; recipient_messages: unknown[] }>(
      'SELECT last_recipient_message_at, recipient_messages FROM outbound_context WHERE id = $1', [released],
    );
    expect(rows[0]!.last_recipient_message_at).toBeNull();
    expect(rows[0]!.recipient_messages).toEqual([]);

    const withMessages = await service.getActiveWithReplies(agentId);
    expect(withMessages.map((e) => e.id)).toContain(asked);
    expect(await service.getActiveWithReplies(`someone-else-${randomUUID()}`)).toEqual([]);

    // The principal's block shows it on the entry, as an untrusted JSON string.
    const block = service.formatInjectionBlock([entry!], 'Any luck with Xiaopu?');
    expect(block).toContain('  - from "Xiaopu Fung", just now, flagged by the injection scan (risk 0.20): "Thur Nov 5"');
  });

  it('keeps the first three messages and the latest three, so neither an early answer nor the latest is lost', async () => {
    const asked = await register('Which day works for lunch?', [xiaopu]);
    // An answer second, after a non-answer: still kept after six more messages.
    const sent = ['one sec', 'Thur Nov 5', 'thanks!', 'is Jeff coming?', 'resend the address?', 'Elgin?', 'see you then', 'bye'];
    for (const content of sent) await service.recordReply([asked], from(xiaopu, content));
    const previews = (await service.getEntry(asked))?.recipientMessages.map((m) => m.preview);
    expect(previews).toEqual(['one sec', 'Thur Nov 5', 'thanks!', 'Elgin?', 'see you then', 'bye']);
  });

  it('lists the waking task\'s own sends first, and an unbound send survives six newer ones', async () => {
    const taskId = randomUUID();
    // A separate agent id so other tests' entries do not share the wake's cap.
    const wakeAgent = `coordinator-${randomUUID()}`;
    const reg = (content: string, metadata?: Record<string, unknown>) => service.register({
      conversationId, channelId: 'signal', agentId: wakeAgent, content, expiresInHours: 1,
      recipientContactIds: [xiaopu], ...(metadata ? { metadata } : {}),
    });
    const ownAsk = await reg('Which day works for lunch?', { bind_reply: true, task_id: taskId });
    await service.recordReply([ownAsk], from(xiaopu, 'Thur Nov 5'));
    const unbound = await reg('Did the photos come through?');
    await service.recordReply([unbound], from(xiaopu, 'yes, thanks'));
    for (let i = 0; i < 10; i++) {
      const id = await reg(`Other ask ${i}`);
      await service.recordReply([id], from(xiaopu, `answer ${i}`));
      if (i === 5) {
        // Six newer replied entries: an unbound send is still inside the 10-entry window.
        expect((await service.getActiveWithReplies(wakeAgent, { taskId })).map((e) => e.id)).toContain(unbound);
      }
    }

    const forTask = await service.getActiveWithReplies(wakeAgent, { taskId });
    expect(forTask[0]?.id).toBe(ownAsk);
    expect(forTask).toHaveLength(10);
    // Without the task, the cap keeps the ten newest and the older ask drops out.
    expect((await service.getActiveWithReplies(wakeAgent)).map((e) => e.id)).not.toContain(ownAsk);
  });

  // A wake an outside contact started can message them, so it reads only entries sent to them.
  it('scopes a wake read to the entries sent to one contact', async () => {
    const wakeAgent = `coordinator-${randomUUID()}`;
    const reg = (content: string, to: string[]) => service.register({
      conversationId, channelId: 'signal', agentId: wakeAgent, content, expiresInHours: 1, recipientContactIds: to,
    });
    const toJeff = await reg('Jeff: does Thu Nov 5 work?', [jeff]);
    await service.recordReply([toJeff], from(jeff, 'JEFF-PRIVATE-ANSWER', 'Jeff Henry'));
    const toXiaopu = await reg('Xiaopu: does Thu Nov 5 work?', [xiaopu]);
    await service.recordReply([toXiaopu], from(xiaopu, 'Thur Nov 5'));

    const forXiaopu = await service.getActiveWithReplies(wakeAgent, { recipientContactId: xiaopu });
    expect(forXiaopu.map((e) => e.id)).toEqual([toXiaopu]);
    expect(JSON.stringify(forXiaopu)).not.toContain('JEFF-PRIVATE-ANSWER');
    expect((await service.getActiveWithReplies(wakeAgent)).map((e) => e.id).sort()).toEqual([toJeff, toXiaopu].sort());
  });
});

describeIf('a contact merge re-points outbound_context recipients (#2261)', () => {
  let pool: pg.Pool;
  let outbound: OutboundContextService;
  let contacts: ContactService;
  const contactIds: string[] = [];
  const conversationId = `test-merge-recipients-${randomUUID()}`;
  let dbVerified = false;

  async function makeContact(name: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO contacts (display_name, kg_node_id) VALUES ($1, NULL) RETURNING id`, [name]);
    contactIds.push(rows[0]!.id);
    return rows[0]!.id;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await requireCuriaTestDatabase(pool);
    dbVerified = true;
    outbound = new OutboundContextService(pool, createSilentLogger());
    // No entity memory: mergeContacts skips the KG merge, which this test does not need.
    contacts = ContactService.createWithPostgres(pool, undefined, createSilentLogger());
  });

  afterAll(async () => {
    if (dbVerified) {
      await pool.query('DELETE FROM outbound_context WHERE conversation_id = $1', [conversationId]);
      await pool.query('DELETE FROM contacts WHERE id = ANY($1::uuid[])', [contactIds]);
    }
    await pool.end();
  });

  it('an entry sent to the absorbed contact matches the survivor, once, with their messages re-pointed', async () => {
    const survivor = await makeContact('Merge survivor');
    const absorbed = await makeContact('Merge absorbed');
    const other = randomUUID();
    const toAbsorbed = await outbound.register({
      conversationId, channelId: 'signal', agentId: 'coordinator', content: 'Does Thu Nov 5 work?', expiresInHours: 1,
      recipientContactIds: [absorbed, other],
    });
    const toBoth = await outbound.register({
      conversationId, channelId: 'email', agentId: 'coordinator', content: 'Lunch at Wildcraft?', expiresInHours: 1,
      recipientContactIds: [survivor, absorbed],
    });
    await outbound.recordReply([toAbsorbed], { from: 'Absorbed', contactId: absorbed, content: 'Thur Nov 5' });
    await outbound.recordReply([toAbsorbed], { from: 'Other', contactId: other, content: 'not me' });

    await contacts.mergeContacts(survivor, absorbed);

    expect((await outbound.getActiveForRecipient(survivor)).map((e) => e.id).sort()).toEqual([toAbsorbed, toBoth].sort());
    expect(await outbound.getActiveForRecipient(absorbed)).toEqual([]);
    expect((await outbound.getEntry(toAbsorbed))?.recipientContactIds?.sort()).toEqual([survivor, other].sort());
    // De-duplicated: the survivor is listed once on an entry sent to both.
    expect((await outbound.getEntry(toBoth))?.recipientContactIds).toEqual([survivor]);
    expect((await outbound.getEntry(toAbsorbed))?.recipientMessages.map((m) => m.contactId)).toEqual([survivor, other]);
  });
});
