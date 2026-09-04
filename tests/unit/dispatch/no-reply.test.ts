import { describe, it, expect } from 'vitest';
import {
  NO_REPLY_SENTINEL,
  classifyNoReply,
  isNoReplyContent,
  containsStandaloneNoReplyToken,
  prepareAgentResponseContent,
} from '../../../src/dispatch/no-reply.js';

describe('classifyNoReply', () => {
  it('classifies the exact sentinel', () => {
    expect(classifyNoReply(NO_REPLY_SENTINEL)).toBe('exact');
    expect(isNoReplyContent(NO_REPLY_SENTINEL)).toBe(true);
  });

  it('classifies case-insensitively with surrounding whitespace', () => {
    expect(classifyNoReply('  no_reply\n')).toBe('exact');
  });

  it('classifies a single layer of quotes or backticks as exact', () => {
    expect(classifyNoReply('`NO_REPLY`')).toBe('exact');
    expect(classifyNoReply('"NO_REPLY"')).toBe('exact');
    expect(classifyNoReply("'NO_REPLY'")).toBe('exact');
  });

  it('classifies a markdown fence as exact', () => {
    expect(classifyNoReply('```NO_REPLY```')).toBe('exact');
    expect(classifyNoReply('```\nNO_REPLY\n```')).toBe('exact');
  });

  it('classifies trailing punctuation as exact', () => {
    expect(classifyNoReply('NO_REPLY.')).toBe('exact');
    expect(classifyNoReply('NO_REPLY!')).toBe('exact');
  });

  it('classifies a sentinel plus prose as ambiguous', () => {
    expect(classifyNoReply('NO_REPLY — I will archive this.')).toBe('ambiguous');
    expect(classifyNoReply('NO_REPLY\n\n(archiving, no action needed)')).toBe('ambiguous');
  });

  it('classifies whitespace-only as empty', () => {
    expect(classifyNoReply('')).toBe('empty');
    expect(classifyNoReply('   \n\t')).toBe('empty');
    expect(isNoReplyContent('')).toBe(false);
  });

  it('returns null for a real reply that does not start with the token', () => {
    expect(classifyNoReply('This is an automated notification — no reply needed.')).toBeNull();
    expect(classifyNoReply('Thanks for the heads-up.')).toBeNull();
  });
});

describe('containsStandaloneNoReplyToken', () => {
  it('detects the token as a standalone word in a longer body', () => {
    expect(containsStandaloneNoReplyToken('Please reply with exactly NO_REPLY')).toBe(true);
    expect(containsStandaloneNoReplyToken(NO_REPLY_SENTINEL)).toBe(true);
  });

  it('does not fire on ordinary prose without the token', () => {
    expect(containsStandaloneNoReplyToken('no reply needed from me')).toBe(false);
  });
});

describe('prepareAgentResponseContent', () => {
  it('blanks exact sentinel content and sets suppressDelivery', () => {
    expect(prepareAgentResponseContent('NO_REPLY')).toEqual({
      content: '',
      suppressDelivery: true,
    });
  });

  it('keeps ambiguous near-miss text for salvage and sets suppressDelivery', () => {
    const raw = 'NO_REPLY — I will archive this.';
    expect(prepareAgentResponseContent(raw)).toEqual({
      content: raw,
      suppressDelivery: true,
    });
  });

  it('leaves ordinary replies unchanged', () => {
    expect(prepareAgentResponseContent('Thanks for the heads-up.')).toEqual({
      content: 'Thanks for the heads-up.',
      suppressDelivery: false,
    });
  });
});
