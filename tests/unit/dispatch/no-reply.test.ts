import { describe, it, expect } from 'vitest';
import { NO_REPLY_SENTINEL, isNoReplyContent } from '../../../src/dispatch/no-reply.js';

describe('isNoReplyContent', () => {
  it('matches the exact sentinel', () => {
    expect(isNoReplyContent(NO_REPLY_SENTINEL)).toBe(true);
  });

  it('matches case-insensitively with surrounding whitespace', () => {
    expect(isNoReplyContent('  no_reply\n')).toBe(true);
  });

  it('matches a single layer of quotes or backticks', () => {
    expect(isNoReplyContent('`NO_REPLY`')).toBe(true);
    expect(isNoReplyContent('"NO_REPLY"')).toBe(true);
    expect(isNoReplyContent("'NO_REPLY'")).toBe(true);
  });

  it('rejects narration that merely mentions the sentinel', () => {
    expect(isNoReplyContent('NO_REPLY — I will archive this.')).toBe(false);
    expect(isNoReplyContent('This is an automated notification — no reply needed.')).toBe(false);
    expect(isNoReplyContent('')).toBe(false);
    expect(isNoReplyContent('Thanks for the heads-up.')).toBe(false);
  });
});
