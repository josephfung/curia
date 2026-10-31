import { describe, expect, it } from 'vitest';
import { rememberFragmentToken, redeemFragmentOnce, resetPairVisitForTests } from './pair-visit.js';

describe('pair visit', () => {
  it('keeps the fragment token after the hash is cleared, and redeems it once', async () => {
    resetPairVisitForTests();
    const token = 'abcDEF1234567890_-token';
    expect(rememberFragmentToken(`#c=${token}`)).toBe(token);
    expect(rememberFragmentToken('')).toBe(token);
    let runs = 0;
    const first = redeemFragmentOnce(token, async () => {
      runs += 1;
      return 'ok';
    });
    const second = redeemFragmentOnce(token, async () => {
      runs += 1;
      return 'other';
    });
    expect(second).toBe(first);
    await expect(first).resolves.toBe('ok');
    expect(runs).toBe(1);
  });
});
