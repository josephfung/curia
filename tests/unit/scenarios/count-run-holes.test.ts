// countRunHoles (#2192): a bounced relay's rewrite turn is not captured, so a refusal or
// canned answer made in it exists only in the stub layer's record. The stub-coverage gate
// reads this count, so such a hole must still count, once.
import { describe, it, expect } from 'vitest';
import { countRunHoles } from '../../scenarios/harness.js';
import type { CapturedToolCall } from '../../scenarios/types.js';
import type { StubbedCall } from '../../scenarios/stub-layer.js';

const call = (id: string, disposition: CapturedToolCall['disposition']): CapturedToolCall =>
  ({ name: 'email-send', input: {}, invokeEventId: id, disposition });
const stub = (id: string | undefined, disposition: StubbedCall['disposition']): StubbedCall =>
  ({ agentId: 'coordinator', invokeEventId: id, toolName: 'email-send', input: {}, disposition });

describe('countRunHoles', () => {
  it('counts an observed refusal once, not again for its stub-layer record', () => {
    expect(countRunHoles([call('a', 'refused')], [stub('a', 'refused')])).toBe(1);
  });

  it('counts refusals and canned answers no observed call matches (a rewrite turn)', () => {
    expect(countRunHoles([call('a', 'stubbed')], [stub('a', 'stubbed'), stub('b', 'refused'), stub('c', 'canned')])).toBe(2);
  });

  it('counts a stub-layer refusal with no invoke id', () => {
    expect(countRunHoles([], [stub(undefined, 'refused')])).toBe(1);
  });

  it('does not count unobserved stubbed or passthrough calls', () => {
    expect(countRunHoles([], [stub('x', 'stubbed'), stub('y', 'passthrough')])).toBe(0);
  });
});
