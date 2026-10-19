import { describe, it, expect } from 'vitest';
import { normalizeCode, isCodeShaped, extractCodeCandidates } from '../../../src/verification/code-shape.js';

describe('normalizeCode', () => {
  it('uppercases and strips one internal space or dash', () => {
    expect(normalizeCode('123 456')).toBe('123456');
    expect(normalizeCode('g-482913')).toBe('G482913');
    expect(normalizeCode('  ab12cd  ')).toBe('AB12CD');
  });

  it('removes at most one separator', () => {
    expect(normalizeCode('12 34 56')).toBe('12 34 56');
    expect(normalizeCode('12-34-56')).toBe('12-34-56');
  });
});

describe('isCodeShaped', () => {
  it('accepts 6-8 digits or alphanumerics with a digit', () => {
    expect(isCodeShaped('123456')).toBe(true);
    expect(isCodeShaped('123 456')).toBe(true);
    expect(isCodeShaped('G-482913')).toBe(true);
    expect(isCodeShaped('AB12CD34')).toBe(true);
  });

  it('rejects letters-only, too short, too long, and multi-separator values', () => {
    expect(isCodeShaped('ABCDEFG')).toBe(false);
    expect(isCodeShaped('12345')).toBe(false);
    expect(isCodeShaped('123456789')).toBe(false);
    expect(isCodeShaped('12 34 56')).toBe(false);
    expect(isCodeShaped('12.3456')).toBe(false);
  });

  it('admits 4-5 characters only with allowShort', () => {
    expect(isCodeShaped('4821', { allowShort: true })).toBe(true);
    expect(isCodeShaped('48215', { allowShort: true })).toBe(true);
    expect(isCodeShaped('4821')).toBe(false);
    expect(isCodeShaped('482', { allowShort: true })).toBe(false);
  });
});

describe('extractCodeCandidates', () => {
  it('extracts a code split by one space', () => {
    expect(extractCodeCandidates('the code is 123 456')).toEqual(['123456']);
  });

  it('extracts a prefixed code split by a dash', () => {
    expect(extractCodeCandidates('G-482913 thanks')).toEqual(['G482913']);
  });

  it('extracts a plain code', () => {
    expect(extractCodeCandidates('code 482913 ok')).toEqual(['482913']);
  });

  it('does not glue a trailing word onto the code', () => {
    expect(extractCodeCandidates('123456 is the code')).toEqual(['123456']);
  });

  it('excludes phone numbers, dates and times', () => {
    expect(extractCodeCandidates('call me at 519-555-0199 on 2026-10-19 at 14:30')).toEqual([]);
    expect(extractCodeCandidates('+1 519 555 0199')).toEqual([]);
    expect(extractCodeCandidates('(519) 555-0199')).toEqual([]);
    expect(extractCodeCandidates('due 10/19/2026')).toEqual([]);
    expect(extractCodeCandidates('at 9:05:30 today')).toEqual([]);
  });

  it('keeps a code that sits next to a phone number or date', () => {
    expect(extractCodeCandidates('code 482913. Call 519-555-0199')).toEqual(['482913']);
    expect(extractCodeCandidates('2026-10-19 code 482913')).toEqual(['482913']);
  });

  it('ignores short values and letters-only words', () => {
    expect(extractCodeCandidates('it was 1234')).toEqual([]);
    expect(extractCodeCandidates('reference ABCDEFG')).toEqual([]);
  });

  it('rejects tokens that are part of a longer run', () => {
    expect(extractCodeCandidates('number 123456789012')).toEqual([]);
    expect(extractCodeCandidates('abc123456def')).toEqual([]);
    expect(extractCodeCandidates('mail user482913@example.com')).toEqual([]);
    expect(extractCodeCandidates('pi is 3.141592')).toEqual([]);
  });

  it('de-duplicates and preserves order', () => {
    expect(extractCodeCandidates('482913 then 111 222 then 482913')).toEqual(['482913', '111222']);
  });

  it('accepts a code followed by end-of-text punctuation', () => {
    expect(extractCodeCandidates('The code is 482913.')).toEqual(['482913']);
    expect(extractCodeCandidates('use 482913.')).toEqual(['482913']);
    expect(extractCodeCandidates('it is 482913/')).toEqual(['482913']);
    expect(extractCodeCandidates('code 482913,')).toEqual(['482913']);
    expect(extractCodeCandidates('(code 482913)')).toEqual(['482913']);
    expect(extractCodeCandidates('here it is: 482913!')).toEqual(['482913']);
  });

  it('accepts a split code followed by a trailing period', () => {
    expect(extractCodeCandidates('your code: 123 456.')).toEqual(['123456']);
    expect(extractCodeCandidates('G-482913.')).toEqual(['G482913']);
  });

  it('accepts a code preceded by start-of-text punctuation', () => {
    expect(extractCodeCandidates('.482913')).toEqual(['482913']);
  });

  it('returns an empty list for empty text', () => {
    expect(extractCodeCandidates('')).toEqual([]);
  });
});
