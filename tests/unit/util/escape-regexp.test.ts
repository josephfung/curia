// escape-regexp.test.ts — pins the escape set documented in escape-regexp.ts.
//
// The failure this guards against is the one CodeQL found in
// config.timer-limits.test.ts (js/incomplete-sanitization, code-scanning alert
// 284): an escape that covers the meta-characters its author happened to think
// of and silently mis-handles the rest. Backslash is the one that gets missed,
// so it is tested first and explicitly.

import { describe, it, expect } from 'vitest';
import { escapeRegExp } from '../../../src/util/escape-regexp.js';

describe('escapeRegExp', () => {
  it('escapes a backslash — the character an ad-hoc escape forgets', () => {
    // Unescaped, the `\` would pair with whatever follows it and change meaning.
    expect(new RegExp(escapeRegExp('a\\b')).test('a\\b')).toBe(true);
    expect(new RegExp(escapeRegExp('a\\b')).test('ab')).toBe(false);
  });

  // Every meta-character, one case each, so a narrowed character class fails loudly
  // instead of only mattering once some caller passes that character.
  it.each([
    ['dot', 'a.b', 'axb'],
    ['star', 'a*b', 'aaab'],
    ['plus', 'a+b', 'aab'],
    ['question mark', 'a?b', 'b'],
    ['caret', 'a^b', 'ab'],
    ['dollar', 'a$b', 'ab'],
    ['open brace', 'a{2}', 'aa'],
    ['open paren', '(ab)', 'ab'],
    ['pipe', 'a|b', 'a'],
    ['open bracket', 'a[bc]', 'ab'],
  ])('escapes a %s so the literal matches itself and not the pattern', (_label, literal, wouldMatchUnescaped) => {
    const re = new RegExp(`^${escapeRegExp(literal)}$`);
    expect(re.test(literal)).toBe(true);
    expect(re.test(wouldMatchUnescaped)).toBe(false);
  });

  it('produces a compilable pattern from input that is not valid regex on its own', () => {
    // `(` alone throws a SyntaxError when compiled raw — the latent trap in alert 284.
    expect(() => new RegExp('(')).toThrow();
    expect(() => new RegExp(escapeRegExp('('))).not.toThrow();
    expect(new RegExp(escapeRegExp('(')).test('(')).toBe(true);
  });

  it('leaves a string with no meta-characters untouched', () => {
    expect(escapeRegExp('tasks-heartbeat_1')).toBe('tasks-heartbeat_1');
  });

  it('escapes every occurrence, not just the first', () => {
    // The other half of the CodeQL rule: a non-global replace escapes one and stops.
    expect(new RegExp(`^${escapeRegExp('a.b.c')}$`).test('a.b.c')).toBe(true);
    expect(new RegExp(`^${escapeRegExp('a.b.c')}$`).test('a.bxc')).toBe(false);
  });

  it('handles the empty string', () => {
    expect(escapeRegExp('')).toBe('');
  });
});
