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
