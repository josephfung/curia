import { describe, it, expect } from 'vitest';
import { DEFAULT_OFFICE_IDENTITY } from '../../../src/identity/defaults.js';

describe('DEFAULT_OFFICE_IDENTITY', () => {
  it('defaults the assistant title to "Digital EA"', () => {
    expect(DEFAULT_OFFICE_IDENTITY.assistant.title).toBe('Digital EA');
  });

  // Regression guard for the wizard nit where the seeded Title ("Agent EA") did not
  // match the role line in the seeded signature ("Digital EA"). The two are surfaced
  // side by side in the onboarding wizard, so they must stay consistent.
  it('keeps the title aligned with the signature role line', () => {
    const signatureRoleLine = DEFAULT_OFFICE_IDENTITY.assistant.emailSignature
      .split('\n')
      .at(-1);
    expect(signatureRoleLine).toBe(DEFAULT_OFFICE_IDENTITY.assistant.title);
  });

  // #2159: approvals and urgent pings go out on ONE channel, chosen by the agent from this
  // standing preference. Seeded as an editable example on fresh installs.
  it('seeds a one-channel preference for urgent pings: Signal, then SMS, then email', () => {
    const pref = DEFAULT_OFFICE_IDENTITY.behavioralPreferences.find((p) => /one channel/i.test(p));
    expect(pref).toBeDefined();
    const order = ['Signal', 'SMS', 'email'].map((c) => pref!.indexOf(c));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(pref).toMatch(/digest/);
  });
});
