import { describe, it, expect, beforeEach } from 'vitest';
import { LlmOutcomeTracker } from '../../../src/health/llm-outcome-tracker.js';

describe('LlmOutcomeTracker', () => {
  let tracker: LlmOutcomeTracker;

  beforeEach(() => {
    tracker = new LlmOutcomeTracker();
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

  it('latest error after success indicates failure', async () => {
    tracker.recordSuccess('fast');
    await new Promise(resolve => setTimeout(resolve, 1));
    tracker.recordError('fast');
    const { lastSuccessAt, lastErrorAt } = tracker.getOutcome('fast');
    expect(lastErrorAt!.getTime()).toBeGreaterThan(lastSuccessAt!.getTime());
  });

  it('latest success after error indicates ok', async () => {
    tracker.recordError('fast');
    await new Promise(resolve => setTimeout(resolve, 1));
    tracker.recordSuccess('fast');
    const { lastSuccessAt, lastErrorAt } = tracker.getOutcome('fast');
    expect(lastSuccessAt!.getTime()).toBeGreaterThan(lastErrorAt!.getTime());
  });
});
