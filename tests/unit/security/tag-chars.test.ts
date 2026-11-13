import { describe, it, expect } from 'vitest';
import { stripTagCharacters } from '../../../src/security/tag-chars.js';

// Tag characters are built from \u{...} escapes throughout — no invisible
// characters sit in this file.

function tagEncode(text: string): string {
  return [...text]
    .map((c) => String.fromCodePoint(0xe0000 + (c.codePointAt(0) ?? 0)))
    .join('');
}

const ENGLAND_FLAG =
  '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
const SCOTLAND_FLAG =
  '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';

describe('stripTagCharacters', () => {
  it('leaves ordinary text (including emoji) untouched', () => {
    const text = `Hello, world — café ${ENGLAND_FLAG} and 🎉`;
    const result = stripTagCharacters(text);
    expect(result.text).toBe(text);
    expect(result.strippedCount).toBe(0);
    expect(result.decoded).toBe('');
  });

  it('strips a smuggled payload and reports its decoded text', () => {
    const result = stripTagCharacters(`a${tagEncode('do evil')}b`);
    expect(result.text).toBe('ab');
    expect(result.decoded).toBe('do evil');
    expect(result.strippedCount).toBe(7);
  });

  it('preserves well-formed subdivision flags', () => {
    const text = `${ENGLAND_FLAG} ${SCOTLAND_FLAG}`;
    const result = stripTagCharacters(text);
    expect(result.text).toBe(text);
    expect(result.strippedCount).toBe(0);
  });

  it('strips flag tag letters that lack the waving-black-flag base', () => {
    const result = stripTagCharacters(`x${tagEncode('gbeng')}y`);
    expect(result.text).toBe('xy');
    expect(result.decoded).toBe('gbeng');
  });

  it('counts non-printing tag characters as stripped but not decoded', () => {
    // U+E0001 (language tag, decodes to 0x01) and U+E007F (DEL, 0x7F).
    const result = stripTagCharacters('a\u{E0001}b\u{E007F}c');
    expect(result.text).toBe('abc');
    expect(result.strippedCount).toBe(2);
    expect(result.decoded).toBe('');
  });
});
