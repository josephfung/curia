import { describe, it, expect } from 'vitest';
import { DEFAULT_OFFICE_IDENTITY } from './defaults.js';

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
});
