import { describe, it, expect } from 'vitest';
// The seed a fresh install loads, imported so the warm template cannot drift from it.
import { DEFAULT_OFFICE_IDENTITY } from '../../../../src/identity/defaults.js';
import { TONE_STYLE_MAX_LENGTH as SERVER_TONE_STYLE_MAX_LENGTH } from '../../../../src/identity/types.js';
import {
  verbosityBand,
  verbosityReviewDesc,
  formalityBand,
  STYLE_TEMPLATES,
  TONE_STYLE_MAX_LENGTH,
  validateToneStyle,
  styleReviewDesc,
  autonomyChange,
  validateNonEmptyName,
  validatePrincipalName,
  PRINCIPAL_NAME_MAX_LENGTH,
  buildIdentityPayload,
  assistantFullName,
  defaultSignature,
  DEFAULT_WIZARD_STATE,
  detectBrowserTimezone,
  validateProfileEmail,
  buildProfilePayload,
  WIZARD_TOTAL_STEPS,
  clampWizardStep,
  type WizardState,
  type LocalIdentity,
} from './wizard-utils.js';

// ── assistantFullName / defaultSignature ──────────────────────────────────────

describe('assistantFullName', () => {
  it('pairs a first name with the Curia surname', () => {
    expect(assistantFullName('Sam')).toBe('Sam Curia');
  });
});

describe('defaultSignature', () => {
  it('builds the full default signature block', () => {
    expect(defaultSignature('Sam')).toBe('--\nSam Curia\nDigital EA');
  });

  it('backs the populated DEFAULT_WIZARD_STATE signature (not blank)', () => {
    expect(DEFAULT_WIZARD_STATE.signature).toBe('--\nAlex Curia\nDigital EA');
  });

  it('backs the DEFAULT_WIZARD_STATE name', () => {
    expect(DEFAULT_WIZARD_STATE.name).toBe('Alex Curia');
  });
});

// ── toggleToneSelection ───────────────────────────────────────────────────────

describe('verbosityBand', () => {
  it('returns brief copy at 0', () => {
    expect(verbosityBand(0)).toBe('"Here\'s the short answer."');
  });

  it('returns brief copy at 25', () => {
    expect(verbosityBand(25)).toBe('"Here\'s the short answer."');
  });

  it('returns concise copy at 26', () => {
    expect(verbosityBand(26)).toBe(
      '"Happy to help — let me know if you\'d like more detail."',
    );
  });

  it('returns thorough copy at 100', () => {
    expect(verbosityBand(100)).toBe('"Let me walk you through this thoroughly."');
  });
});

// ── directnessBand ────────────────────────────────────────────────────────────

describe('verbosityReviewDesc', () => {
  it('returns concise description at 50', () => {
    expect(verbosityReviewDesc(50)).toBe('Concise responses by default.');
  });
});

describe('formalityBand', () => {
  it('returns a casual sample at low formality', () => {
    expect(formalityBand(10)).toContain('Hey');
  });
  it('returns a formal sample at high formality', () => {
    expect(formalityBand(90)).toContain('formally');
  });
});

describe('validateNonEmptyName', () => {
  it('returns true for a non-empty name', () => {
    expect(validateNonEmptyName('Alex')).toBe(true);
  });

  it('returns false for an empty name', () => {
    expect(validateNonEmptyName('')).toBe(false);
  });

  it('returns false for whitespace-only name', () => {
    expect(validateNonEmptyName('   ')).toBe(false);
  });
});

// ── validatePrincipalName ─────────────────────────────────────────────────────

describe('validatePrincipalName', () => {
  it('returns null for a valid name', () => {
    expect(validatePrincipalName('Jane Doe')).toBeNull();
  });

  it('returns an error message for an empty name', () => {
    expect(validatePrincipalName('')).toBe('Your name is required.');
  });

  it('returns an error message for whitespace-only input', () => {
    expect(validatePrincipalName('   ')).toBe('Your name is required.');
  });

  it('returns an error when over the length ceiling', () => {
    const tooLong = 'X'.repeat(PRINCIPAL_NAME_MAX_LENGTH + 1);
    expect(validatePrincipalName(tooLong)).toBe(
      `Name must be ${PRINCIPAL_NAME_MAX_LENGTH} characters or fewer.`,
    );
  });

  it('accepts a name exactly at the length ceiling', () => {
    const atLimit = 'X'.repeat(PRINCIPAL_NAME_MAX_LENGTH);
    expect(validatePrincipalName(atLimit)).toBeNull();
  });
});

// ── buildIdentityPayload ──────────────────────────────────────────────────────

describe('buildIdentityPayload', () => {
  const existingIdentity: LocalIdentity = {
    assistant: { name: 'Old', title: 'Old Title', emailSignature: '' },
    tone: { style: 'Warm.', verbosity: 50 },
    behavioralPreferences: ['existing pref'],
    constraints: ['no spam'],
  };

  const state: WizardState = {
    principalName: 'Jane Doe',
    name: 'Alex Curia',
    title: 'Executive Assistant to the CEO',
    signature: 'Best, Alex',
    toneStyle: '  Dry and brief.\nSounds like: "Done."  ',
    verbosity: 60,
    autonomyBand: 'spot-check',
    preferences: 'Flag investor emails',
    timezone: 'America/Toronto',
    email: '',
    preferredName: '',
    principalTitle: '',
    workingHours: null,
  };

  it('maps WizardState onto identity correctly', () => {
    const { identity } = buildIdentityPayload(state, existingIdentity);
    expect(identity.assistant.name).toBe('Alex Curia');
    expect(identity.assistant.title).toBe('Executive Assistant to the CEO');
    expect(identity.assistant.emailSignature).toBe('Best, Alex');
    expect(identity.tone).toEqual({ style: 'Dry and brief.\nSounds like: "Done."', verbosity: 60 });
    // The identity no longer carries a decision style; autonomy is saved separately.
    expect(identity).not.toHaveProperty('decisionStyle');
  });

  it('appends preferences to existing behavioralPreferences', () => {
    const { identity } = buildIdentityPayload(state, existingIdentity);
    expect(identity.behavioralPreferences).toEqual([
      'existing pref',
      'Flag investor emails',
    ]);
  });

  it('does not append when preferences is empty', () => {
    const { identity } = buildIdentityPayload(
      { ...state, preferences: '' },
      existingIdentity,
    );
    expect(identity.behavioralPreferences).toEqual(['existing pref']);
  });

  it('preserves constraints from existing identity', () => {
    const { identity } = buildIdentityPayload(state, existingIdentity);
    expect(identity.constraints).toEqual(['no spam']);
  });

  it('sets note to "Saved via onboarding wizard"', () => {
    const { note } = buildIdentityPayload(state, existingIdentity);
    expect(note).toBe('Saved via onboarding wizard');
  });
});

// ── validateProfileEmail ──────────────────────────────────────────────────────

describe('validateProfileEmail', () => {
  it('returns null for empty (optional field)', () => {
    expect(validateProfileEmail('')).toBeNull();
    expect(validateProfileEmail('   ')).toBeNull();
  });
  it('returns null for a valid address', () => {
    expect(validateProfileEmail('a@b.com')).toBeNull();
  });
  it('returns an error for a malformed address', () => {
    expect(validateProfileEmail('not-an-email')).toMatch(/valid/i);
  });
});

// ── buildProfilePayload ───────────────────────────────────────────────────────

describe('buildProfilePayload', () => {
  it('includes timezone and omits empty optionals', () => {
    const state = { ...DEFAULT_WIZARD_STATE, timezone: 'America/Vancouver' };
    expect(buildProfilePayload(state)).toEqual({ timezone: 'America/Vancouver' });
  });
  it('includes provided optionals and trims them', () => {
    const state = {
      ...DEFAULT_WIZARD_STATE, timezone: 'America/Toronto',
      email: '  Me@Example.com ', preferredName: ' Jo ', principalTitle: ' CEO ',
      workingHours: { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] },
    };
    expect(buildProfilePayload(state)).toEqual({
      timezone: 'America/Toronto', email: 'Me@Example.com', preferredName: 'Jo',
      title: 'CEO', workingHours: { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] },
    });
  });
});

// ── detectBrowserTimezone ─────────────────────────────────────────────────────

describe('detectBrowserTimezone', () => {
  it('returns a non-empty IANA-looking string', () => {
    // CI environments often report 'UTC' — a valid IANA zone without a slash.
    // Accept any non-empty string that Intl recognises as a real zone.
    const tz = detectBrowserTimezone();
    expect(tz.length).toBeGreaterThan(0);
    expect(() => Intl.DateTimeFormat(undefined, { timeZone: tz })).not.toThrow();
  });
});

// ── clampWizardStep ───────────────────────────────────────────────────────────

describe('clampWizardStep', () => {
  it('accepts every real step, including the final review step (#2146)', () => {
    for (let step = 1; step <= WIZARD_TOTAL_STEPS; step++) {
      expect(clampWizardStep(step)).toBe(step);
    }
    expect(clampWizardStep(6)).toBe(6);
  });

  it('clamps out-of-range steps to the nearest real step', () => {
    expect(clampWizardStep(0)).toBe(1);
    expect(clampWizardStep(-3)).toBe(1);
    expect(clampWizardStep(WIZARD_TOTAL_STEPS + 1)).toBe(WIZARD_TOTAL_STEPS);
  });

  it('rounds fractional steps', () => {
    expect(clampWizardStep(2.6)).toBe(3);
  });

  it('falls back to step 1 for non-numeric values', () => {
    expect(clampWizardStep(undefined)).toBe(1);
    expect(clampWizardStep('3')).toBe(1);
    expect(clampWizardStep(Number.NaN)).toBe(1);
    expect(clampWizardStep(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

// ── Tone & style (#2143) ──────────────────────────────────────────────────────

describe('STYLE_TEMPLATES', () => {
  it('offers the four starters, each ending in one example line', () => {
    expect(STYLE_TEMPLATES.map(t => t.label)).toEqual(['Dry & understated', 'Warm & personable', 'Crisp & direct', 'Formal']);
    for (const t of STYLE_TEMPLATES) {
      expect(t.text.split('\n').at(-1)).toMatch(/^Sounds like: ".+"$/);
      expect(validateToneStyle(t.text)).toBeNull();
    }
  });

  it('keeps the warm template identical to the seeded default style', () => {
    // A fresh install's wizard loads the seed: it must read as an untouched template.
    expect(STYLE_TEMPLATES.find(t => t.id === 'warm')!.text).toBe(DEFAULT_OFFICE_IDENTITY.tone.style);
  });
});

describe('validateToneStyle', () => {
  it('requires some text', () => {
    expect(validateToneStyle('')).toMatch(/Describe how/);
    expect(validateToneStyle('   ')).toMatch(/Describe how/);
  });
  it('caps the length at the identity limit', () => {
    expect(TONE_STYLE_MAX_LENGTH).toBe(SERVER_TONE_STYLE_MAX_LENGTH);
    expect(validateToneStyle('x'.repeat(TONE_STYLE_MAX_LENGTH))).toBeNull();
    expect(validateToneStyle('x'.repeat(TONE_STYLE_MAX_LENGTH + 1))).toMatch(/801/);
  });
});

describe('styleReviewDesc', () => {
  it('shows the first line', () => {
    expect(styleReviewDesc('Dry and brief.\nSounds like: "Done."')).toBe('Dry and brief.');
  });
  it('cuts a long first line short', () => {
    const out = styleReviewDesc('word '.repeat(60));
    expect(out.length).toBeLessThanOrEqual(118);
    expect(out.endsWith('…')).toBe(true);
  });
});

// ── Autonomy band (#2143) ─────────────────────────────────────────────────────

describe('autonomyChange', () => {
  it('skips the save when the picked band is the current one', () => {
    expect(autonomyChange(84, 'spot-check')).toBeNull();
    expect(autonomyChange(60, 'draft-only')).toBeNull();
  });
  it('saves a changed band at its lower bound, with the wizard reason', () => {
    expect(autonomyChange(84, 'full')).toEqual({ score: 90, reason: 'Set via onboarding wizard' });
    expect(autonomyChange(84, 'approval-required')).toEqual({ score: 70, reason: 'Set via onboarding wizard' });
    expect(autonomyChange(75, 'restricted')).toEqual({ score: 0, reason: 'Set via onboarding wizard' });
  });
});
