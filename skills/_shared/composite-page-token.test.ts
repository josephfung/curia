import { describe, expect, it } from 'vitest';
import { decodePageToken, encodePageToken, pageScope } from './composite-page-token.js';

describe('composite page token', () => {
  it('round-trips per-mailbox positions, including exhausted ones', () => {
    const positions = {
      work: { cursor: 'abc', skip: 3 },
      personal: null,
      third: { cursor: null, skip: 0 },
      anchored: { cursor: 'def', skip: 2, after: { id: 'm2', date: 1700 } },
    };
    expect(decodePageToken(encodePageToken(positions, 7, 'scope-a'))).toEqual({ limit: 7, scope: 'scope-a', positions });
  });

  it('fingerprints the request: stable for the same parts, different for another query', () => {
    expect(pageScope({ tool: 't', query: 'invoice', spam: false })).toBe(pageScope({ spam: false, query: 'invoice', tool: 't' }));
    expect(pageScope({ tool: 't', query: 'invoice' })).not.toBe(pageScope({ tool: 't', query: 'receipt' }));
    expect(pageScope({ tool: 't', query: 'invoice' })).not.toContain('invoice');
  });

  it('is URL-safe', () => {
    expect(encodePageToken({ work: { cursor: 'a/b+c==', skip: 1 } }, 5, 's')).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['not base64 json', '%%%'],
    ['a raw provider cursor', 'dGhpcyBpcyBub3QganNvbg'],
    ['a json array', Buffer.from('[]').toString('base64url')],
    ['a token without a page size', Buffer.from('{"mailboxes":{}}').toString('base64url')],
    ['a non-object position', Buffer.from('{"limit":5,"mailboxes":{"work":"x"}}').toString('base64url')],
    ['a negative skip', Buffer.from('{"limit":5,"mailboxes":{"work":{"cursor":null,"skip":-1}}}').toString('base64url')],
    ['a fractional skip', Buffer.from('{"limit":5,"mailboxes":{"work":{"cursor":null,"skip":1.5}}}').toString('base64url')],
    ['a non-string cursor', Buffer.from('{"limit":5,"mailboxes":{"work":{"cursor":5,"skip":0}}}').toString('base64url')],
    ['a non-string scope', Buffer.from('{"limit":5,"scope":3,"mailboxes":{}}').toString('base64url')],
    ['a malformed anchor', Buffer.from('{"limit":5,"mailboxes":{"work":{"cursor":null,"skip":1,"after":{"id":1}}}}').toString('base64url')],
    ['an empty string', ''],
  ])('throws on %s', (_name, token) => {
    expect(() => decodePageToken(token)).toThrow();
  });
});
