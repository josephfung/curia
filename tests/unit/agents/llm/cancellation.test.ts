import { describe, expect, it } from 'vitest';
import { isCallerCancellation } from '../../../../src/agents/llm/cancellation.js';

describe('isCallerCancellation', () => {
  it('is false with no signal, or one that has not fired', () => {
    expect(isCallerCancellation(undefined)).toBe(false);
    expect(isCallerCancellation({})).toBe(false);
    expect(isCallerCancellation({ signal: new AbortController().signal })).toBe(false);
  });

  it('is true when the caller aborted, with or without a reason', () => {
    const plain = new AbortController();
    plain.abort();
    expect(isCallerCancellation({ signal: plain.signal })).toBe(true);
    const reasoned = new AbortController();
    reasoned.abort(new Error('barge-in'));
    expect(isCallerCancellation({ signal: reasoned.signal })).toBe(true);
  });

  it('is false when the signal fired because the request timed out', () => {
    const controller = new AbortController();
    controller.abort(new DOMException('timed out', 'TimeoutError'));
    expect(isCallerCancellation({ signal: controller.signal })).toBe(false);
  });

  it('ignores a signal field that is not an AbortSignal', () => {
    expect(isCallerCancellation({ signal: { aborted: true } })).toBe(false);
  });
});
