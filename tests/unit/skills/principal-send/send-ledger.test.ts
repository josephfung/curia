import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import {
  PrincipalSendLedger, parseLedgerDoc, PRINCIPAL_SEND_LEDGER_PREFIX, PRINCIPAL_SEND_DOC_TYPE,
} from '../../../../src/skills/principal-send/send-ledger.js';
import type { WorkingDocRow, CreateWorkingDocParams, UpdateWorkingDocParams } from '../../../../src/db/working-docs-repo.js';

const logger = pino({ level: 'silent' });

/** An in-memory stand-in for the four WorkingDocsRepo methods the ledger uses. */
function makeDocs() {
  const docs = new Map<string, WorkingDocRow>();
  const toRow = (p: CreateWorkingDocParams): WorkingDocRow => ({
    id: `id-${docs.size}`, path: p.path, type: p.type, frontmatter: p.frontmatter ?? {}, body: p.body ?? '',
    version: 1, sectionVersions: {}, byteSize: 0, taskId: null, conversationId: null, agentId: null,
    createdAt: '2026-11-07T12:00:00.000Z', updatedAt: '2026-11-07T12:00:00.000Z', archivedAt: null,
  });
  return {
    docs,
    create: vi.fn(async (p: CreateWorkingDocParams) => {
      if (docs.has(p.path)) throw new Error('duplicate path');
      const r = toRow(p);
      docs.set(p.path, r);
      return r;
    }),
    read: vi.fn(async (path: string) => docs.get(path) ?? null),
    update: vi.fn(async (path: string, p: UpdateWorkingDocParams) => {
      const cur = docs.get(path)!;
      const next = { ...cur, frontmatter: p.frontmatter ?? cur.frontmatter, version: cur.version + 1 };
      docs.set(path, next);
      return { ok: true as const, document: next };
    }),
    listByPrefix: vi.fn(async (prefix: string) => [...docs.values()].filter((d) => d.path.startsWith(prefix))),
  };
}

const entry = {
  draftId: 'd1', threadId: 't1', recipients: ['dana@example.org'], mode: 'principal-directed' as const, at: '2026-11-07T12:00:00.000Z',
  mailbox: 'work', conversationIds: [] as string[],
};

describe('PrincipalSendLedger', () => {
  it('recordSending creates a principal-mailbox-send doc under the prefix', async () => {
    const docs = makeDocs();
    await new PrincipalSendLedger(docs, logger).recordSending(entry);
    expect(docs.create).toHaveBeenCalledOnce();
    const params = docs.create.mock.calls[0]![0];
    expect(params.type).toBe(PRINCIPAL_SEND_DOC_TYPE);
    expect(params.path.startsWith(`${PRINCIPAL_SEND_LEDGER_PREFIX}/d1-`)).toBe(true);
    expect(params.path.endsWith('.md')).toBe(true);
    const listed = await new PrincipalSendLedger(docs, logger).list();
    expect(listed).toEqual([{ ...entry, outcome: 'sending' }]);
  });

  it('recordSent sets the message id and outcome sent', async () => {
    const docs = makeDocs();
    const ledger = new PrincipalSendLedger(docs, logger);
    await ledger.recordSending(entry);
    await ledger.recordSent('d1', 'msg-9');
    expect(await ledger.list()).toEqual([{ ...entry, outcome: 'sent', messageId: 'msg-9' }]);
  });

  it('recordSent does not touch another draft whose id shares the prefix', async () => {
    const docs = makeDocs();
    const ledger = new PrincipalSendLedger(docs, logger);
    await ledger.recordSending({ ...entry, draftId: 'd1-x' });
    await ledger.recordSent('d1', 'msg-9');
    expect((await ledger.list())[0]).toMatchObject({ draftId: 'd1-x', outcome: 'sending' });
  });
});

describe('parseLedgerDoc', () => {
  it('rejects a doc of another type', async () => {
    const docs = makeDocs();
    await new PrincipalSendLedger(docs, logger).recordSending(entry);
    const doc = [...docs.docs.values()][0]!;
    expect(parseLedgerDoc(doc)).toMatchObject({ draftId: 'd1' });
    expect(parseLedgerDoc({ ...doc, type: 'voice-learning-draft' })).toBeNull();
  });

  it('keeps a ledger doc with malformed frontmatter, read conservatively (never dropped)', async () => {
    const docs = makeDocs();
    await new PrincipalSendLedger(docs, logger).recordSending(entry);
    const doc = [...docs.docs.values()][0]!;
    expect(parseLedgerDoc({ ...doc, frontmatter: { ...doc.frontmatter, mode: 'whatever' } })).toMatchObject({ mode: 'autonomous' });
    expect(parseLedgerDoc({ ...doc, frontmatter: { ...doc.frontmatter, recipients: 'x' } })).toMatchObject({ recipients: [] });
  });
});

describe('PrincipalSendLedger autonomous lookups (#2474 PR 2)', () => {
  // Final fixes B2 (security review L2): a code, never the free-text reason, in agent-readable /scratch.
  it('recordHeld stores a reason code', async () => {
    const docs = makeDocs();
    const ledger = new PrincipalSendLedger(docs, logger);
    await ledger.recordHeld({ ...entry, mode: 'autonomous', reasonCode: 'recipient_not_on_thread' });
    expect(await ledger.list()).toEqual([{ ...entry, mode: 'autonomous', outcome: 'held', reasonCode: 'recipient_not_on_thread' }]);
    const params = docs.create.mock.calls[0]![0];
    expect(params.path.startsWith(`${PRINCIPAL_SEND_LEDGER_PREFIX}/d1-`)).toBe(true);
    expect(params.frontmatter).toMatchObject({ reason_code: 'recipient_not_on_thread' });
    expect(params.frontmatter).not.toHaveProperty('reason');
  });

  it('parses a PR 1 entry with no reason, and an earlier held entry\'s free-text reason without keeping it', async () => {
    const docs = makeDocs();
    await new PrincipalSendLedger(docs, logger).recordSending(entry);
    const doc = [...docs.docs.values()][0]!;
    expect(parseLedgerDoc(doc)).toEqual({ ...entry, outcome: 'sending' });
    const legacyHeld = { ...doc, frontmatter: { ...doc.frontmatter, mode: 'autonomous', outcome: 'held', reason: 'The reply goes to bob@example.org.' } };
    expect(parseLedgerDoc(legacyHeld)).toEqual({ ...entry, mode: 'autonomous', outcome: 'held' });
  });

  it('recentForThread returns only autonomous entries on that thread inside the window', async () => {
    const docs = makeDocs();
    const ledger = new PrincipalSendLedger(docs, logger);
    const since = Date.parse('2026-11-06T12:00:00.000Z');
    await ledger.recordSending({ ...entry, draftId: 'a', mode: 'autonomous', at: '2026-11-07T10:00:00.000Z' });
    await ledger.recordHeld({ ...entry, draftId: 'b', mode: 'autonomous', at: '2026-11-07T11:00:00.000Z', reasonCode: 'review_hold' });
    await ledger.recordSending({ ...entry, draftId: 'c', mode: 'principal-directed', at: '2026-11-07T10:00:00.000Z' });
    await ledger.recordSending({ ...entry, draftId: 'd', mode: 'autonomous', threadId: 't2', at: '2026-11-07T10:00:00.000Z' });
    await ledger.recordSending({ ...entry, draftId: 'e', mode: 'autonomous', at: '2026-11-05T10:00:00.000Z' });
    await ledger.recordSending({ ...entry, draftId: 'f', mode: 'autonomous', at: 'not a date' });
    const got = await ledger.recentForThread('t1', since, 'work');
    // An unreadable time counts as recent (fail closed).
    expect(got.map((e) => e.draftId).sort()).toEqual(['a', 'b', 'f']);
  });

  it('parseLedgerDoc rejects a non-string reason code', async () => {
    const docs = makeDocs();
    await new PrincipalSendLedger(docs, logger).recordHeld({ ...entry, reasonCode: 'x' });
    const doc = [...docs.docs.values()][0]!;
    expect(parseLedgerDoc({ ...doc, frontmatter: { ...doc.frontmatter, reason_code: 7 } })).not.toHaveProperty('reasonCode');
  });
});

// Final fixes A4 (security review M2) and A12 (final review M1).
describe('PrincipalSendLedger global lookups', () => {
  it('recentAutonomousSends counts autonomous sending and sent entries on every thread inside the window', async () => {
    const docs = makeDocs();
    const ledger = new PrincipalSendLedger(docs, logger);
    const since = Date.parse('2026-11-06T12:00:00.000Z');
    await ledger.recordSending({ ...entry, draftId: 'a', mode: 'autonomous', at: '2026-11-07T10:00:00.000Z' });
    await ledger.recordSending({ ...entry, draftId: 'b', mode: 'autonomous', threadId: 't2', at: '2026-11-07T10:00:00.000Z' });
    await ledger.recordSent('b', 'msg-b');
    await ledger.recordHeld({ ...entry, draftId: 'c', mode: 'autonomous', at: '2026-11-07T11:00:00.000Z', reasonCode: 'review_hold' });
    await ledger.recordSending({ ...entry, draftId: 'd', mode: 'principal-directed', at: '2026-11-07T10:00:00.000Z' });
    await ledger.recordSending({ ...entry, draftId: 'e', mode: 'autonomous', at: '2026-11-05T10:00:00.000Z' });
    await ledger.recordSending({ ...entry, draftId: 'f', mode: 'autonomous', threadId: 't3', at: 'not a date' });
    const got = await ledger.recentAutonomousSends(since);
    // Held markers are not sends; an unreadable time counts (fail closed).
    expect(got.map((e) => e.draftId).sort()).toEqual(['a', 'b', 'f']);
  });

  it('recentAutonomousSends throws on a repo failure (the gateway fails closed)', async () => {
    const docs = makeDocs();
    docs.listByPrefix.mockRejectedValue(new Error('db down'));
    await expect(new PrincipalSendLedger(docs, logger).recentAutonomousSends(0)).rejects.toThrow('db down');
  });

  it('sentForDraft is true only once a send of that draft was recorded as sent', async () => {
    const docs = makeDocs();
    const ledger = new PrincipalSendLedger(docs, logger);
    await ledger.recordSending({ ...entry, mode: 'autonomous' });
    expect(await ledger.sentForDraft('d1')).toBe(false);
    await ledger.recordSent('d1', 'msg-1');
    expect(await ledger.sentForDraft('d1')).toBe(true);
    // A draft whose id shares the prefix is another draft.
    expect(await ledger.sentForDraft('d')).toBe(false);
  });
});

// #2475 Task 18: the ledger spans mailboxes.
describe('PrincipalSendLedger across mailboxes (#2475)', () => {
  const since = Date.parse('2026-11-06T12:00:00.000Z');
  const recent = '2026-11-07T10:00:00.000Z';

  it('records the mailbox and the conversation ids on the marker', async () => {
    const docs = makeDocs();
    const ledger = new PrincipalSendLedger(docs, logger);
    await ledger.recordSending({ ...entry, mode: 'autonomous', conversationIds: ['a@x', 'b@x'] });
    expect(docs.create.mock.calls[0]![0].frontmatter).toMatchObject({ mailbox: 'work', conversation_ids: ['a@x', 'b@x'] });
    expect(await ledger.list()).toEqual([{ ...entry, mode: 'autonomous', outcome: 'sending', conversationIds: ['a@x', 'b@x'] }]);
  });

  it('reads a legacy entry with no mailbox and no conversation ids', async () => {
    const docs = makeDocs();
    await new PrincipalSendLedger(docs, logger).recordSending(entry);
    const doc = [...docs.docs.values()][0]!;
    const legacy = { ...doc.frontmatter };
    delete legacy['mailbox'];
    delete legacy['conversation_ids'];
    const parsed = parseLedgerDoc({ ...doc, frontmatter: legacy });
    expect(parsed).not.toHaveProperty('mailbox');
    expect(parsed?.conversationIds).toEqual([]);
  });

  it('a legacy entry (no mailbox) still triggers the per-mailbox thread cooldown', async () => {
    const docs = makeDocs();
    const ledger = new PrincipalSendLedger(docs, logger);
    await ledger.recordSending({ ...entry, draftId: 'a', mode: 'autonomous', at: recent });
    const doc = [...docs.docs.values()][0]!;
    const legacy = { ...doc.frontmatter };
    delete legacy['mailbox'];
    docs.docs.set(doc.path, { ...doc, frontmatter: legacy });
    expect((await ledger.recentForThread('t1', since, 'personal')).map((e) => e.draftId)).toEqual(['a']);
  });

  it('recentForThread ignores the same thread id in another mailbox', async () => {
    const docs = makeDocs();
    const ledger = new PrincipalSendLedger(docs, logger);
    await ledger.recordSending({ ...entry, draftId: 'a', mode: 'autonomous', at: recent });
    expect(await ledger.recentForThread('t1', since, 'personal')).toEqual([]);
  });

  it('recentForConversation matches a shared Message-ID in any mailbox, autonomous and in the window only', async () => {
    const docs = makeDocs();
    const ledger = new PrincipalSendLedger(docs, logger);
    await ledger.recordSending({ ...entry, draftId: 'a', mode: 'autonomous', at: recent, conversationIds: ['root@x', 'm2@x'] });
    await ledger.recordSending({ ...entry, draftId: 'b', mode: 'autonomous', threadId: 't9', at: recent, conversationIds: ['other@x'] });
    await ledger.recordSending({ ...entry, draftId: 'c', mode: 'principal-directed', at: recent, conversationIds: ['root@x'] });
    await ledger.recordSending({ ...entry, draftId: 'd', mode: 'autonomous', at: '2026-11-05T10:00:00.000Z', conversationIds: ['root@x'] });
    expect((await ledger.recentForConversation(['ROOT@x'.toLowerCase(), 'zzz@x'], since)).map((e) => e.draftId)).toEqual(['a']);
    expect(await ledger.recentForConversation([], since)).toEqual([]);
  });

  it('an entry with a wrong-typed mailbox still counts toward the cap', async () => {
    const docs = makeDocs();
    const ledger = new PrincipalSendLedger(docs, logger);
    await ledger.recordSending({ ...entry, draftId: 'a', mode: 'autonomous', at: recent });
    const doc = [...docs.docs.values()][0]!;
    docs.docs.set(doc.path, { ...doc, frontmatter: { ...doc.frontmatter, mailbox: 5 } });
    expect(await ledger.recentAutonomousSends(since)).toHaveLength(1);
    // No usable mailbox matches any mailbox: it adds cooldown.
    expect(await ledger.recentForThread('t1', since, 'personal')).toHaveLength(1);
  });

  it('an entry with a non-array conversation_ids still counts toward the cap and the thread cooldown', async () => {
    const docs = makeDocs();
    const ledger = new PrincipalSendLedger(docs, logger);
    await ledger.recordSending({ ...entry, draftId: 'a', mode: 'autonomous', at: recent });
    const doc = [...docs.docs.values()][0]!;
    docs.docs.set(doc.path, { ...doc, frontmatter: { ...doc.frontmatter, conversation_ids: 'nope' } });
    expect(await ledger.recentAutonomousSends(since)).toHaveLength(1);
    expect(await ledger.recentForThread('t1', since, 'work')).toHaveLength(1);
  });

  describe.each([
    ['at', { at: 7 }],
    ['mode', { mode: 'whatever' }],
    ['outcome', { outcome: 'whatever' }],
    ['recipients', { recipients: 'x' }],
    ['draft_id', { draft_id: 7 }],
    ['thread_id', { thread_id: 7 }],
  ])('an entry with an unreadable %s', (_field, bad) => {
    async function ledgerWithBad() {
      const docs = makeDocs();
      const ledger = new PrincipalSendLedger(docs, logger);
      await ledger.recordSending({ ...entry, draftId: 'a', mode: 'autonomous', at: recent });
      const doc = [...docs.docs.values()][0]!;
      docs.docs.set(doc.path, { ...doc, frontmatter: { ...doc.frontmatter, ...bad } });
      return ledger;
    }
    it('still counts toward the daily cap', async () => {
      expect(await (await ledgerWithBad()).recentAutonomousSends(since)).toHaveLength(1);
    });
    it('still triggers the thread cooldown', async () => {
      expect(await (await ledgerWithBad()).recentForThread('t1', since, 'work')).toHaveLength(1);
    });
  });

  it('excludes a cleanly-read limited entry from the cap and the cooldowns', async () => {
    const docs = makeDocs();
    const ledger = new PrincipalSendLedger(docs, logger);
    await ledger.recordSending({ ...entry, draftId: 'a', mode: 'autonomous', at: recent });
    const doc = [...docs.docs.values()][0]!;
    docs.docs.set(doc.path, { ...doc, frontmatter: { ...doc.frontmatter, outcome: 'limited' } });
    expect(await ledger.recentAutonomousSends(since)).toEqual([]);
    expect(await ledger.recentForThread('t1', since, 'work')).toEqual([]);
  });

  it('cap counts sends from every mailbox', async () => {
    const docs = makeDocs();
    const ledger = new PrincipalSendLedger(docs, logger);
    for (let i = 0; i < 10; i++) {
      await ledger.recordSending({ ...entry, draftId: `s${i}`, threadId: `t${i}`, mailbox: i % 2 ? 'work' : 'personal', mode: 'autonomous', at: recent });
    }
    expect(await ledger.recentAutonomousSends(since)).toHaveLength(10);
  });
});

describe('limit stops (#2475 Task 19)', () => {
  const recent = new Date().toISOString();
  const since = Date.now() - 24 * 3600_000;
  const base = { draftId: 'd1', threadId: 't1', recipients: [] as string[], mode: 'autonomous' as const, at: recent, mailbox: 'work', conversationIds: ['a@x'] };

  it('a limited entry is ignored by the cap and by both cooldowns', async () => {
    const docs = makeDocs();
    const ledger = new PrincipalSendLedger(docs, logger);
    await ledger.recordSending({ ...base, draftId: 'old', at: '2020-01-01T00:00:00.000Z' });
    await ledger.recordLimitStop({ draftId: 'd2', mailbox: 'work', reason: 'daily_cap', at: recent });
    const doc = [...docs.docs.values()].find((d) => d.frontmatter['outcome'] === 'limited')!;
    // Even a limited marker that carries the thread and the conversation must not count.
    const entries = [parseLedgerDoc({ ...doc, frontmatter: { ...doc.frontmatter, thread_id: 't1', conversation_ids: ['a@x'] } })!];
    expect(entries[0]!.outcome).toBe('limited');
    expect(await ledger.recentAutonomousSends(since, entries)).toEqual([]);
    expect(await ledger.recentForThread('t1', since, 'work', entries)).toEqual([]);
    expect(await ledger.recentForConversation(['a@x'], since, entries)).toEqual([]);
  });

  it('limitStopsSince returns only limited entries for that reason inside the window', async () => {
    const docs = makeDocs();
    const ledger = new PrincipalSendLedger(docs, logger);
    await ledger.recordLimitStop({ draftId: 'a', mailbox: 'work', reason: 'daily_cap', at: recent });
    await ledger.recordLimitStop({ draftId: 'b', mailbox: 'work', reason: 'thread_cooldown', at: recent });
    await ledger.recordLimitStop({ draftId: 'c', mailbox: 'work', reason: 'daily_cap', at: '2020-01-01T00:00:00.000Z' });
    await ledger.recordHeld({ ...base, draftId: 'e', reasonCode: 'daily_cap' });
    const got = await ledger.limitStopsSince(since, 'daily_cap');
    expect(got.map((e) => e.draftId)).toEqual(['a']);
  });

  it('limitStopsSince throws on a repo failure', async () => {
    const docs = makeDocs();
    docs.listByPrefix.mockRejectedValue(new Error('db down'));
    await expect(new PrincipalSendLedger(docs, logger).limitStopsSince(since, 'daily_cap')).rejects.toThrow('db down');
  });
});
