import { describe, it, expect } from 'vitest';
import { parseSuggestedFirstName } from './suggest-name.js';

// The parse/validate path is the security-relevant surface of the
// suggest-name feature: an LLM is free-text and may return anything, so we
// accept only a single, plausible first name and fall back otherwise. These
// tests pin the accept/reject contract (issue #799 acceptance criteria).

describe('parseSuggestedFirstName', () => {
  it('accepts a clean single first name', () => {
    expect(parseSuggestedFirstName('Sam')).toBe('Sam');
  });

  it('capitalises a lowercase name', () => {
    expect(parseSuggestedFirstName('sam')).toBe('Sam');
  });

  it('preserves internal capitals (e.g. McKenzie)', () => {
    expect(parseSuggestedFirstName('McKenzie')).toBe('McKenzie');
  });

  it('trims surrounding whitespace', () => {
    expect(parseSuggestedFirstName('  Sam  ')).toBe('Sam');
  });

  it('accepts accented letters (non-English names)', () => {
    expect(parseSuggestedFirstName('Renée')).toBe('Renée');
  });

  it('rejects a multi-word response', () => {
    expect(parseSuggestedFirstName('Sam Smith')).toBeNull();
  });

  it('rejects trailing punctuation', () => {
    expect(parseSuggestedFirstName('Sam.')).toBeNull();
  });

  it('rejects surrounding quotes', () => {
    expect(parseSuggestedFirstName('"Sam"')).toBeNull();
  });

  it('rejects digits', () => {
    expect(parseSuggestedFirstName('Sam1')).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(parseSuggestedFirstName('')).toBeNull();
  });

  it('rejects a whitespace-only string', () => {
    expect(parseSuggestedFirstName('   ')).toBeNull();
  });

  it('rejects a single letter (implausibly short)', () => {
    expect(parseSuggestedFirstName('A')).toBeNull();
  });

  it('rejects an implausibly long token', () => {
    expect(parseSuggestedFirstName('A'.repeat(21))).toBeNull();
  });

  it('rejects a sentence wrapping the name', () => {
    expect(parseSuggestedFirstName('Sure! How about Sam?')).toBeNull();
  });
});
