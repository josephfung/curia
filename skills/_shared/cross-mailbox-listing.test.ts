// Cross-mailbox listing (#2475): what a page token cannot hide, and what a failure logs.
import { describe, expect, it, vi } from 'vitest';
import { encodePageToken } from './composite-page-token.js';
import { collectAcross, listAcrossMailboxes, readPageToken, type Target } from './cross-mailbox-listing.js';
import { mailboxView } from './principal-mailboxes-test-helpers.js';
import type { CeoNylasClient } from './ceo-nylas-client.js';

type Msg = { id: string; date: number };

function target(id: string, messages: Msg[] | Error): Target {
  const client = {
    listMessagesPage: async () => {
      if (messages instanceof Error) throw messages;
      return { messages };
    },
  } as unknown as CeoNylasClient;
  return { mailbox: mailboxView(id, id === 'constructor' ? 'Odd' : id.charAt(0).toUpperCase() + id.slice(1), `${id}@example.com`), client };
}

const fetchPage = (client: CeoNylasClient) => (client as unknown as { listMessagesPage: () => Promise<{ messages: Msg[] }> }).listMessagesPage();

describe('listAcrossMailboxes — page tokens (S2)', () => {
  it('names a live mailbox the token marks finished instead of silently leaving it out', async () => {
    const token = readPageToken({ page_token: encodePageToken({ work: { cursor: null, skip: 0 }, personal: null }, 5) }, 5);
    expect(token.ok).toBe(true);
    if (!token.ok) return;
    const r = await listAcrossMailboxes([target('work', [{ id: 'w1', date: 2 }]), target('personal', [{ id: 'p1', date: 3 }])], token.cursors, {
      limit: 5, need: 6, pageCap: 1, fetchPage, keep: () => true,
    });
    expect(r.items.map((m) => m.id)).toEqual(['w1']);
    expect(r.skipped).toEqual([{ mailbox: 'personal', mailbox_label: 'Personal', note: expect.stringMatching(/Retry without page_token/) }]);
  });

  it('a mailbox id like `constructor` reads only the token\'s own entries', async () => {
    const token = readPageToken({ page_token: encodePageToken({ work: { cursor: null, skip: 0 } }, 5), mailbox: 'constructor' }, 5);
    // The named mailbox is not in the token: refused, not matched through the prototype.
    expect(token.ok).toBe(false);
    const fresh = readPageToken({ page_token: encodePageToken({ work: { cursor: null, skip: 0 } }, 5) }, 5);
    if (!fresh.ok) throw new Error('expected a token');
    const r = await listAcrossMailboxes([target('constructor', [{ id: 'c1', date: 1 }])], fresh.cursors, {
      limit: 5, need: 6, pageCap: 1, fetchPage, keep: () => true,
    });
    // Absent from the token: read from the start, not treated as a position.
    expect(r.items.map((m) => m.id)).toEqual(['c1']);
    expect(r.skipped).toEqual([]);
  });
});

describe('per-mailbox failures are logged (SF4, SF15)', () => {
  it('listAcrossMailboxes and collectAcross log the tool, mailbox and status, never the body', async () => {
    const warn = vi.fn();
    const err = Object.assign(new Error('grant g-secret failed'), { statusCode: 503 });
    await listAcrossMailboxes([target('work', err)], undefined, {
      limit: 5, need: 6, pageCap: 1, fetchPage, keep: () => true, failures: { log: { warn } as never, tool: 'ceo-inbox-list' },
    });
    await collectAcross([target('work', err)], async (c) => fetchPage(c), { log: { warn } as never, tool: 'ceo-inbox-search' });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toMatchObject({ tool: 'ceo-inbox-list', mailboxId: 'work', errName: 'Error', statusCode: 503 });
    expect(warn.mock.calls[1]![0]).toMatchObject({ tool: 'ceo-inbox-search', mailboxId: 'work' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('g-secret');
  });

  it('an undecodable page token is logged by error name and length, never its text', () => {
    const warn = vi.fn();
    const r = readPageToken({ page_token: 'not-a-token-xyz' }, 5, { log: { warn } as never, tool: 'ceo-inbox-list' });
    expect(r.ok).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ tool: 'ceo-inbox-list', tokenLength: 15 }), expect.stringMatching(/could not be decoded/));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('not-a-token-xyz');
  });
});
