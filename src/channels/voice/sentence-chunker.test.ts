import { describe, it, expect } from 'vitest';
import { SentenceChunker } from './sentence-chunker.js';

describe('SentenceChunker', () => {
  it('emits a complete sentence once terminated with trailing whitespace', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('Hello there')).toEqual([]);
    expect(chunker.push('. ')).toEqual(['Hello there.']);
  });

  it('accumulates deltas across multiple push calls', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('The ')).toEqual([]);
    expect(chunker.push('quick brown ')).toEqual([]);
    expect(chunker.push('fox. ')).toEqual(['The quick brown fox.']);
  });

  it('emits multiple sentences from a single delta', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('One. Two! Three? ')).toEqual(['One.', 'Two!', 'Three?']);
  });

  it('keeps a trailing partial sentence buffered until flush', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('Done. And more')).toEqual(['Done.']);
    expect(chunker.flush()).toBe('And more');
  });

  it('flush returns null when nothing is buffered', () => {
    const chunker = new SentenceChunker();
    chunker.push('All done. ');
    expect(chunker.flush()).toBeNull();
  });

  it('handles a sentence terminated only at end-of-stream (no trailing space)', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('No trailing space.')).toEqual([]);
    expect(chunker.flush()).toBe('No trailing space.');
  });

  it('does not split on abbreviations without trailing whitespace boundary', () => {
    const chunker = new SentenceChunker();
    // "3.14" has no whitespace after the period, so it stays buffered.
    expect(chunker.push('Pi is 3.14 roughly. ')).toEqual(['Pi is 3.14 roughly.']);
  });

  it('handles quotes and brackets after terminators', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('She said "hi." Then left. ')).toEqual([
      'She said "hi."',
      'Then left.',
    ]);
  });

  it('reset discards buffered text', () => {
    const chunker = new SentenceChunker();
    chunker.push('partial text');
    chunker.reset();
    expect(chunker.flush()).toBeNull();
  });

  it('ignores empty deltas', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('')).toEqual([]);
    expect(chunker.flush()).toBeNull();
  });
});
