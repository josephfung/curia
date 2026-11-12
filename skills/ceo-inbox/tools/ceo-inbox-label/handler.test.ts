import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import pino from 'pino';
import { CeoInboxLabelHandler } from './handler.js';
import { clearFolderCache } from '../../../_shared/ceo-nylas-client.js';
import type { ToolContext } from '../../../../src/skills/types.js';
import { stubPrincipalMailboxes, twoMailboxFixture } from '../../../_shared/principal-mailboxes-test-helpers.js';

const logger = pino({ level: 'silent' });

function buildCtx(input: Record<string, unknown>): ToolContext {
  return {
    input,
    principalMailboxes: stubPrincipalMailboxes({}),
    log: logger,
  } as unknown as ToolContext;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(status === 200 ? { data } : { error: data }), { status });
}

describe('CeoInboxLabelHandler', () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    clearFolderCache();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    // The first call is the mailbox lookup (GET the message); the sequences below follow it.
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 'm1', folders: ['INBOX'] }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The spot-check pool (#2159) reads subject/from so a triage sample is gradable. The label
  // flow already reads the message, so naming it must not add a provider call.
  it('returns the subject and sender of the labelled message without an extra call', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse([{ id: 'Label_3', name: 'BOARD' }]))
      .mockResolvedValueOnce(jsonResponse({
        id: 'm1', folders: ['INBOX'], subject: 'Statement ready',
        from: [{ name: 'Billing', email: 'billing@example.com' }],
      }))
      .mockResolvedValueOnce(jsonResponse({ id: 'm1', folders: ['INBOX', 'Label_3'] }));

    const result = await new CeoInboxLabelHandler().execute(
      buildCtx({ message_id: '19a2b3c4d5e6f708', labels: ['BOARD'] }),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      message_id: '19a2b3c4d5e6f708',
      subject: 'Statement ready',
      from: 'Billing (billing@example.com)',
    });
    // locate, list folders, read message, write folders.
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  // Nylas answers 400 "unsupported Google label: SENT" if a write lists a system label (#2426).
  it('does not send SENT or DRAFT back when labelling a message the principal sent', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse([{ id: 'Label_3', name: 'BOARD' }]))
      .mockResolvedValueOnce(jsonResponse({ id: 'm1', folders: ['INBOX', 'SENT', 'DRAFT'] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'm1', folders: ['INBOX', 'SENT', 'Label_3'] }));

    const result = await new CeoInboxLabelHandler().execute(
      buildCtx({ message_id: '19a2b3c4d5e6f708', labels: ['BOARD'] }),
    );

    expect(result.success).toBe(true);
    const putBody = JSON.parse(String((fetchSpy.mock.calls[3]![1] as RequestInit).body));
    expect(putBody).toEqual({ folders: ['INBOX', 'Label_3'] });
  });

  it('reports a requested SENT label as skipped, not applied', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse([{ id: 'Label_3', name: 'BOARD' }, { id: 'SENT', name: 'SENT' }]))
      .mockResolvedValueOnce(jsonResponse({ id: 'm1', folders: ['INBOX'] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'm1', folders: ['INBOX', 'Label_3'] }));

    const result = await new CeoInboxLabelHandler().execute(
      buildCtx({ message_id: '19a2b3c4d5e6f708', labels: ['BOARD', 'SENT'] }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { applied: string[]; read_only_skipped: string[] };
      expect(data.applied).toEqual(['BOARD']);
      expect(data.read_only_skipped).toEqual(['SENT']);
    }
  });

  it('refuses a request for only SENT or DRAFT without calling Nylas', async () => {
    const result = await new CeoInboxLabelHandler().execute(
      buildCtx({ message_id: '19a2b3c4d5e6f708', labels: ['SENT', 'draft'] }),
    );

    expect(result.success).toBe(false);
    if (!result.success) expect(result.errorType).toBe('VALIDATION_ERROR');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('CeoInboxLabelHandler mailbox selection (#2475)', () => {
  afterEach(() => vi.restoreAllMocks());

  function run(holders: Array<'work' | 'personal'>, extra: Record<string, unknown> = {}) {
    clearFolderCache();
    const f = twoMailboxFixture(holders);
    const stub = f.fetchStub;
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: unknown, init?: RequestInit) => {
      const u = new URL(String(url));
      const method = (init?.method ?? 'GET').toUpperCase();
      const held = u.pathname.includes('grant-work') ? holders.includes('work') : holders.includes('personal');
      if (u.pathname.endsWith('/folders')) {
        f.calls.push({ grant: /grant-[a-z]+/.exec(u.pathname)![0], method, path: '/folders' });
        if (method === 'POST') return jsonResponse({ id: 'Label_new', name: 'BOARD' });
        return jsonResponse([]);
      }
      if (method === 'PUT' && held) {
        f.calls.push({ grant: /grant-[a-z]+/.exec(u.pathname)![0], method, path: u.pathname });
        return jsonResponse({ id: 'x1', folders: ['INBOX', 'Label_new'] });
      }
      return stub(url, init);
    }) as typeof fetch);
    const ctx = {
      input: { message_id: 'x1', labels: ['BOARD'], ...extra }, principalMailboxes: f.principalMailboxes,
      log: logger,
    } as unknown as ToolContext;
    return { f, result: new CeoInboxLabelHandler().execute(ctx) };
  }

  it('creates no label when the message is not in the mailbox', async () => {
    const { f, result } = run(['personal'], { mailbox: 'work' });
    const r = await result;
    expect(r.success).toBe(false);
    expect(f.calls.filter((c) => c.path === '/folders')).toHaveLength(0);
    expect(f.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('labels in the mailbox holding the message', async () => {
    const { f, result } = run(['personal']);
    const r = await result;
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ mailbox: 'personal', mailbox_label: 'Personal', created: ['BOARD'] });
    const writes = f.calls.filter((c) => c.method !== 'GET');
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((c) => c.grant === 'grant-personal')).toBe(true);
    expect(f.calls.filter((c) => c.path === '/folders').every((c) => c.grant === 'grant-personal')).toBe(true);
  });
});
