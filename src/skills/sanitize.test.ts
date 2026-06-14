// sanitize.test.ts — unit tests for output sanitization helpers.
//
// Focus here is redactValues(), the value-aware redaction hook used as the
// backstop for secret-by-reference injection (#973): any literal secret value
// injected into a browser session must be scrubbed from returned page content
// before it can round-trip back into the LLM context.

import { describe, it, expect } from 'vitest';
import { redactValues } from './sanitize.js';

describe('redactValues', () => {
  it('replaces an exact occurrence of a value with [REDACTED]', () => {
    const out = redactValues('your balance is shown after hunter2 logs in', ['hunter2']);
    expect(out).toBe('your balance is shown after [REDACTED] logs in');
    expect(out).not.toContain('hunter2');
  });

  it('replaces every occurrence, not just the first', () => {
    const out = redactValues('hunter2 / hunter2 / hunter2', ['hunter2']);
    expect(out).toBe('[REDACTED] / [REDACTED] / [REDACTED]');
  });

  it('redacts multiple distinct values', () => {
    const out = redactValues('user alice with pw s3cr3t', ['alice', 's3cr3t']);
    expect(out).toBe('user [REDACTED] with pw [REDACTED]');
  });

  it('redacts longer values before shorter overlapping ones to avoid partial leaks', () => {
    // If "pass" were redacted first, "password123" would become "[REDACTED]word123",
    // leaking the rest. Longer-first ordering prevents that.
    const out = redactValues('login=password123', ['pass', 'password123']);
    expect(out).toBe('login=[REDACTED]');
    expect(out).not.toContain('word123');
  });

  it('treats values as literals, not regex patterns', () => {
    const out = redactValues('match a.c here', ['a.c']);
    expect(out).toBe('match [REDACTED] here');
    // A literal "axc" must NOT be redacted (proves "." is not a wildcard).
    expect(redactValues('axc', ['a.c'])).toBe('axc');
  });

  it('ignores empty / whitespace-only values (would otherwise redact everything)', () => {
    expect(redactValues('untouched', [''])).toBe('untouched');
    expect(redactValues('untouched', ['   '])).toBe('untouched');
  });

  it('returns the text unchanged when there are no values', () => {
    expect(redactValues('nothing to do', [])).toBe('nothing to do');
  });

  it('accepts any iterable of values (e.g. a Set)', () => {
    const out = redactValues('a then b', new Set(['a', 'b']));
    expect(out).toBe('[REDACTED] then [REDACTED]');
  });
});
