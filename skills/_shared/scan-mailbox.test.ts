import { describe, expect, it } from 'vitest';
import { scanMailbox } from './cross-mailbox-listing.js';
import type { MailboxPosition } from './composite-page-token.js';

type Msg = { id: string; date: number; self?: boolean };

function pages(map: Record<string, { messages: Msg[]; next?: string }>) {
  return async (cursor: string | undefined) => {
    const page = map[cursor ?? '']!;
    return { messages: page.messages, ...(page.next ? { nextCursor: page.next } : {}) };
  };
}

describe('scanMailbox continuation under a small page cap', () => {
  it('makes progress past a filtered page followed by an empty page with a cursor', async () => {
    const fetchPage = pages({
      '': { messages: [{ id: 'self', date: 100, self: true }], next: 'c1' },
      c1: { messages: [], next: 'c2' },
      c2: { messages: [{ id: 'real', date: 90 }] },
    });
    let start: MailboxPosition | null = { cursor: null, skip: 0 };
    const found: string[] = [];
    for (let call = 0; call < 5 && start !== null && found.length === 0; call++) {
      const r: Awaited<ReturnType<typeof scanMailbox<Msg>>> = await scanMailbox<Msg>({ start, need: 1, pageCap: 2, fetchPage, keep: (m) => !m.self });
      found.push(...r.items.map((i) => i.item.id));
      start = r.end;
    }
    expect(found).toEqual(['real']);
  });

  it('treats an empty page with a next cursor as not exhausted', async () => {
    const r = await scanMailbox<Msg>({
      start: { cursor: null, skip: 0 },
      need: 5,
      pageCap: 1,
      fetchPage: pages({ '': { messages: [], next: 'c1' } }),
      keep: () => true,
    });
    expect(r.end).toEqual({ cursor: 'c1', skip: 0 });
  });
});
