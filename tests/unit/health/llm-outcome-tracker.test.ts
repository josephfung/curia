import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LlmOutcomeTracker } from '../../../src/health/llm-outcome-tracker.js';

describe('LlmOutcomeTracker', () => {
  let tracker: LlmOutcomeTracker;

  beforeEach(() => {
    tracker = new LlmOutcomeTracker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with null outcomes for all keys', () => {
    const outcome = tracker.getOutcome('fast');
    expect(outcome.lastSuccessAt).toBeNull();
    expect(outcome.lastErrorAt).toBeNull();
  });

  it('records success', () => {
    tracker.recordSuccess('fast');
    const outcome = tracker.getOutcome('fast');
    expect(outcome.lastSuccessAt).toBeInstanceOf(Date);
    expect(outcome.lastErrorAt).toBeNull();
  });

  it('records error', () => {
    tracker.recordError('standard');
    const outcome = tracker.getOutcome('standard');
    expect(outcome.lastErrorAt).toBeInstanceOf(Date);
    expect(outcome.lastSuccessAt).toBeNull();
  });

  it('records embeddings key', () => {
    tracker.recordSuccess('embeddings');
    expect(tracker.getOutcome('embeddings').lastSuccessAt).toBeInstanceOf(Date);
  });

  it('records image_gen key', () => {
    tracker.recordError('image_gen');
    expect(tracker.getOutcome('image_gen').lastErrorAt).toBeInstanceOf(Date);
  });

  it('reports error as the most recent outcome after success', () => {
    tracker.recordSuccess('fast');
    tracker.recordError('fast');
    expect(tracker.getOutcome('fast').lastOutcome).toBe('error');
  });

  it('reports success as the most recent outcome after error', () => {
    tracker.recordError('fast');
    tracker.recordSuccess('fast');
    expect(tracker.getOutcome('fast').lastOutcome).toBe('success');
  });

  // Regression (#1163): success and error recorded in the SAME millisecond used to be
  // indistinguishable — health derived failure from `lastErrorAt > lastSuccessAt`, which is
  // false on a tie, so an error landing in the same ms as a success was silently reported
  // healthy (and made the ordering unit test flaky). lastOutcome records insertion order, so
  // the most recent outcome wins regardless of Date's 1ms granularity.
  it('breaks same-millisecond ties by record order, not timestamp comparison', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-24T12:00:00.000Z'));
    // Both calls observe the identical (frozen) clock — lastErrorAt === lastSuccessAt.
    tracker.recordSuccess('fast');
    tracker.recordError('fast');
    const outcome = tracker.getOutcome('fast');
    expect(outcome.lastErrorAt!.getTime()).toBe(outcome.lastSuccessAt!.getTime());
    expect(outcome.lastOutcome).toBe('error');
  });
});
