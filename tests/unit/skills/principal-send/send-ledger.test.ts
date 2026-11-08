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

const entry = { draftId: 'd1', threadId: 't1', recipients: ['dana@example.org'], mode: 'principal-directed' as const, at: '2026-11-07T12:00:00.000Z' };

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

  it('rejects a doc with malformed frontmatter', async () => {
    const docs = makeDocs();
    await new PrincipalSendLedger(docs, logger).recordSending(entry);
    const doc = [...docs.docs.values()][0]!;
    expect(parseLedgerDoc({ ...doc, frontmatter: { ...doc.frontmatter, mode: 'whatever' } })).toBeNull();
    expect(parseLedgerDoc({ ...doc, frontmatter: { ...doc.frontmatter, recipients: 'x' } })).toBeNull();
  });
});

describe('PrincipalSendLedger autonomous lookups (#2474 PR 2)', () => {
  it('recordHeld stores the reason', async () => {
    const docs = makeDocs();
    const ledger = new PrincipalSendLedger(docs, logger);
    await ledger.recordHeld({ ...entry, mode: 'autonomous', reason: 'thread_cooldown' });
    expect(await ledger.list()).toEqual([{ ...entry, mode: 'autonomous', outcome: 'held', reason: 'thread_cooldown' }]);
    expect(docs.create.mock.calls[0]![0].path.startsWith(`${PRINCIPAL_SEND_LEDGER_PREFIX}/d1-`)).toBe(true);
  });

  it('recentForThread returns only autonomous entries on that thread inside the window', async () => {
    const docs = makeDocs();
    const ledger = new PrincipalSendLedger(docs, logger);
    const since = Date.parse('2026-11-06T12:00:00.000Z');
    await ledger.recordSending({ ...entry, draftId: 'a', mode: 'autonomous', at: '2026-11-07T10:00:00.000Z' });
    await ledger.recordHeld({ ...entry, draftId: 'b', mode: 'autonomous', at: '2026-11-07T11:00:00.000Z', reason: 'hold' });
    await ledger.recordSending({ ...entry, draftId: 'c', mode: 'principal-directed', at: '2026-11-07T10:00:00.000Z' });
    await ledger.recordSending({ ...entry, draftId: 'd', mode: 'autonomous', threadId: 't2', at: '2026-11-07T10:00:00.000Z' });
    await ledger.recordSending({ ...entry, draftId: 'e', mode: 'autonomous', at: '2026-11-05T10:00:00.000Z' });
    await ledger.recordSending({ ...entry, draftId: 'f', mode: 'autonomous', at: 'not a date' });
    const got = await ledger.recentForThread('t1', since);
    // An unreadable time counts as recent (fail closed).
    expect(got.map((e) => e.draftId).sort()).toEqual(['a', 'b', 'f']);
  });

  it('parseLedgerDoc rejects a non-string reason', async () => {
    const docs = makeDocs();
    await new PrincipalSendLedger(docs, logger).recordHeld({ ...entry, reason: 'x' });
    const doc = [...docs.docs.values()][0]!;
    expect(parseLedgerDoc({ ...doc, frontmatter: { ...doc.frontmatter, reason: 7 } })).toBeNull();
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
    await ledger.recordHeld({ ...entry, draftId: 'c', mode: 'autonomous', at: '2026-11-07T11:00:00.000Z', reason: 'hold' });
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
