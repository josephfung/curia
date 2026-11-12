import { describe, expect, it } from 'vitest';
import { decodePageToken, encodePageToken } from './composite-page-token.js';

describe('composite page token', () => {
  it('round-trips per-mailbox positions, including exhausted ones', () => {
    const positions = {
      work: { cursor: 'abc', skip: 3 },
      personal: null,
      third: { cursor: null, skip: 0 },
    };
    expect(decodePageToken(encodePageToken(positions))).toEqual(positions);
  });

  it('is URL-safe', () => {
    expect(encodePageToken({ work: { cursor: 'a/b+c==', skip: 1 } })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['not base64 json', '%%%'],
    ['a raw provider cursor', 'dGhpcyBpcyBub3QganNvbg'],
    ['a json array', Buffer.from('[]').toString('base64url')],
    ['a non-object position', Buffer.from('{"work":"x"}').toString('base64url')],
    ['a negative skip', Buffer.from('{"work":{"cursor":null,"skip":-1}}').toString('base64url')],
    ['a fractional skip', Buffer.from('{"work":{"cursor":null,"skip":1.5}}').toString('base64url')],
    ['a non-string cursor', Buffer.from('{"work":{"cursor":5,"skip":0}}').toString('base64url')],
    ['an empty string', ''],
  ])('throws on %s', (_name, token) => {
    expect(() => decodePageToken(token)).toThrow();
  });
});
