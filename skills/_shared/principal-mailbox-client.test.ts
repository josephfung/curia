import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clearFolderCache, CeoNylasClient } from './ceo-nylas-client.js';
import { allMailboxClients, locate, locateError, mailboxClient } from './principal-mailbox-client.js';
import type { ToolContext } from '../../src/skills/types.js';
import type { PrincipalMailboxView } from '../../src/principal-mailboxes/service.js';

function view(id: string, label: string, isDefault = false): PrincipalMailboxView {
  return { id, label, address: `${id}@example.com`, isDefault, triageStartAt: null };
}

function makeCtx(mailboxes: PrincipalMailboxView[]): ToolContext {
  const principalMailboxes = {
    list: async () => mailboxes,
    get: async (id: string) => {
      const m = mailboxes.find((x) => x.id === id);
      if (!m) throw new Error(`unknown ${id}`);
      return m;
    },
    credentials: async (id: string) => ({ apiKey: 'key', grantId: `grant-${id}` }),
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { principalMailboxes, log } as unknown as ToolContext;
}

function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
    body: { cancel: vi.fn() },
  } as unknown as Response;
}

const msgBody = { data: { id: 'm1', subject: 's' } };

/** fetch stub: grants listed in `hits` return 200, `errors` return 500-class (status given), others 404. */
function stubFetch(hits: string[], errors: Record<string, number> = {}) {
  const fn = vi.fn(async (url: string) => {
    const grant = /grants\/([^/]+)\//.exec(url)![1]!;
    if (hits.includes(grant)) return res(200, msgBody);
    if (errors[grant] !== undefined) return res(errors[grant]!, { error: 'x' });
    return res(404, { error: 'not found' });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => clearFolderCache());
afterEach(() => vi.unstubAllGlobals());

describe('principal-mailbox-client', () => {
  const two = [view('work', 'Work', true), view('personal', 'Personal')];

  it('found in exactly one mailbox', async () => {
    stubFetch(['grant-personal']);
    const r = await locate(makeCtx(two), 'message', 'm1');
    expect(r.kind).toBe('found');
    if (r.kind === 'found') expect(r.at.mailbox.id).toBe('personal');
  });

  it('ambiguous when found in two mailboxes', async () => {
    stubFetch(['grant-work', 'grant-personal']);
    const r = await locate(makeCtx(two), 'message', 'm1');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.mailboxes.map((m) => m.id).sort()).toEqual(['personal', 'work']);
    expect(locateError(r as Exclude<typeof r, { kind: 'found' }>, 'message')).toContain('Work');
  });

  it('explicit wrong mailbox is not_found without probing others', async () => {
    const fetchMock = stubFetch(['grant-personal']);
    const r = await locate(makeCtx(two), 'message', 'm1', 'work');
    expect(r).toEqual({ kind: 'not_found', definitive: true, failed: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a failing mailbox makes a miss non-definitive', async () => {
    stubFetch([], { 'grant-personal': 400 });
    const ctx = makeCtx(two);
    const r = await locate(ctx, 'message', 'm1');
    expect(r.kind).toBe('not_found');
    if (r.kind === 'not_found') {
      expect(r.definitive).toBe(false);
      expect(r.failed.map((f) => f.mailboxId)).toEqual(['personal']);
      expect(JSON.stringify(r)).not.toContain('grant-');
    }
  });

  it('single mailbox makes one call', async () => {
    const fetchMock = stubFetch(['grant-work']);
    const r = await locate(makeCtx([view('work', 'Work', true)]), 'draft', 'd1');
    expect(r.kind).toBe('found');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('deleteDraft issues DELETE /drafts/:id', async () => {
    const fetchMock = stubFetch([]);
    fetchMock.mockResolvedValueOnce(res(200, { data: {} }));
    const client = new CeoNylasClient('key', 'g1', makeCtx([]).log as never);
    await client.deleteDraft('d 1');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/grants\/g1\/drafts\/d%201$/);
    expect(init.method).toBe('DELETE');
  });

  it('fails clearly without the capability', async () => {
    const ctx = { log: {} } as unknown as ToolContext;
    await expect(mailboxClient(ctx, 'work')).rejects.toThrow(/principalMailboxes/);
    await expect(allMailboxClients(ctx)).rejects.toThrow(/principalMailboxes/);
  });

  it('blank explicit mailbox is an unknown-mailbox error, not the implicit path', async () => {
    const fetchMock = stubFetch(['grant-work']);
    await expect(locate(makeCtx(two), 'message', 'm1', '')).rejects.toThrow(/unknown/);
    await expect(locate(makeCtx(two), 'message', 'm1', '  ')).rejects.toThrow(/unknown/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('implicit path survives one mailbox failing credentials', async () => {
    stubFetch(['grant-personal']);
    const ctx = makeCtx(two);
    const orig = ctx.principalMailboxes!.credentials.bind(ctx.principalMailboxes!);
    ctx.principalMailboxes!.credentials = async (id: string) => {
      if (id === 'work') throw new Error('Mailbox "work" has no Nylas grant configured');
      return orig(id);
    };
    const hit = await locate(ctx, 'message', 'm1');
    expect(hit.kind).toBe('found');
    stubFetch([]);
    const miss = await locate(ctx, 'message', 'm1');
    expect(miss).toEqual({ kind: 'not_found', definitive: false, failed: [{ mailboxId: 'work', detail: 'Error' }] });
  });

  it('explicit path still throws when credentials fail', async () => {
    stubFetch([]);
    const ctx = makeCtx(two);
    ctx.principalMailboxes!.credentials = async () => {
      throw new Error('no grant');
    };
    await expect(locate(ctx, 'message', 'm1', 'work')).rejects.toThrow('no grant');
  });

  it('zero mailboxes says none is connected', async () => {
    const fetchMock = stubFetch([]);
    const r = await locate(makeCtx([]), 'message', 'm1');
    expect(r.kind).toBe('no_mailboxes');
    expect(locateError(r as Exclude<typeof r, { kind: 'found' }>, 'message')).toMatch(/No principal mailbox is connected/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('non-404 on the explicit path is non-definitive', async () => {
    stubFetch([], { 'grant-work': 403 });
    const r = await locate(makeCtx(two), 'message', 'm1', 'work');
    expect(r).toEqual({ kind: 'not_found', definitive: false, failed: [{ mailboxId: 'work', detail: 'HTTP 403' }] });
    expect(locateError(r as Exclude<typeof r, { kind: 'found' }>, 'draft')).toMatch(/could not check mailbox work/);
  });

  it('deleteDraft tolerates a response with no envelope', async () => {
    const client = new CeoNylasClient('key', 'g1', makeCtx([]).log as never);
    const noBody = { ...res(200, null), json: async () => { throw new Error('no json'); } } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn(async () => noBody));
    await expect(client.deleteDraft('d1')).resolves.toBeUndefined();
    vi.stubGlobal('fetch', vi.fn(async () => res(200, null)));
    await expect(client.deleteDraft('d1')).resolves.toBeUndefined();
  });

  it('deleteDraft rejects on DELETE 404 and 500', async () => {
    const client = new CeoNylasClient('key', 'g1', makeCtx([]).log as never);
    vi.stubGlobal('fetch', vi.fn(async () => res(404, { error: 'x' })));
    await expect(client.deleteDraft('d1')).rejects.toMatchObject({ status: 404 });
    vi.stubGlobal('fetch', vi.fn(async () => res(500, { error: 'x' })));
    await expect(client.deleteDraft('d1')).rejects.toMatchObject({ status: 500 });
  });
});
