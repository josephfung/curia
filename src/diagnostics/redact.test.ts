// src/diagnostics/redact.test.ts

import { describe, it, expect } from 'vitest';
import { redactText, summarizePayload, DEFAULT_TEXT_PREVIEW } from './redact.js';

describe('redactText', () => {
  it('passes null/undefined through unchanged', () => {
    expect(redactText(null)).toBeNull();
    expect(redactText(undefined)).toBeUndefined();
  });

  it('scrubs PII', () => {
    const out = redactText('email me at bob@example.com');
    expect(out).not.toContain('bob@example.com');
  });

  it('truncates past the preview cap with a marker', () => {
    const long = 'a'.repeat(DEFAULT_TEXT_PREVIEW + 50);
    const out = redactText(long)!;
    expect(out.length).toBeLessThan(long.length);
    expect(out).toMatch(/truncated 50 chars/);
  });

  it('leaves short strings intact (minus PII)', () => {
    expect(redactText('short and clean')).toBe('short and clean');
  });
});

describe('summarizePayload', () => {
  it('keeps primitives and scrubs string leaves', () => {
    const out = summarizePayload({ ok: true, n: 42, who: 'ping alice@example.com now' }) as Record<string, unknown>;
    expect(out.ok).toBe(true);
    expect(out.n).toBe(42);
    expect(out.who).not.toContain('alice@example.com');
  });

  it('elides structure past maxDepth', () => {
    const deep = { a: { b: { c: { d: 'too deep' } } } };
    const out = summarizePayload(deep, { maxDepth: 2 }) as { a: { b: unknown } };
    expect(out.a.b).toBe('{…}');
  });

  it('caps array breadth with an overflow marker', () => {
    const arr = Array.from({ length: 30 }, (_, i) => i);
    const out = summarizePayload(arr, { maxEntries: 5 }) as unknown[];
    expect(out).toHaveLength(6); // 5 kept + 1 overflow marker
    expect(String(out[5])).toMatch(/\+25 more/);
  });

  it('truncates long string leaves', () => {
    const out = summarizePayload({ big: 'y'.repeat(500) }, { maxStringLen: 100 }) as { big: string };
    expect(out.big).toMatch(/\[\+400\]$/);
  });
});
