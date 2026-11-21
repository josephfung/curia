import { describe, it, expect, vi } from 'vitest';
import { isTriageHeld, setTriageHold, releaseTriageHold } from '../../../src/onboarding/triage-hold.js';

function store(initial: string | null) {
  let value = initial;
  return {
    get: vi.fn(async () => value),
    set: vi.fn(async (_ns: string, _key: string, v: string) => { value = v; return { stored: true, action: 'set' }; }),
  };
}

describe('triage hold', () => {
  it('is not held when the key is missing', async () => {
    expect(await isTriageHeld(store(null))).toBe(false);
  });

  it('reads held true and false', async () => {
    expect(await isTriageHeld(store('{"held":true}'))).toBe(true);
    expect(await isTriageHeld(store('{"held":false}'))).toBe(false);
  });

  it('fails closed and warns when malformed', async () => {
    const warn = vi.fn();
    expect(await isTriageHeld(store('nope'), { warn } as never)).toBe(true);
    expect(await isTriageHeld(store('{"held":"yes"}'), { warn } as never)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('set and release round-trip', async () => {
    const s = store(null);
    await setTriageHold(s);
    expect(await isTriageHeld(s)).toBe(true);
    await releaseTriageHold(s);
    expect(s.set).toHaveBeenLastCalledWith('onboarding', 'triage_hold', '{"held":false}');
    expect(await isTriageHeld(s)).toBe(false);
  });
});
