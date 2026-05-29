import { describe, it, expect } from 'vitest';
import {
  toggleToneSelection,
  verbosityBand,
  directnessBand,
  tonePreviewText,
  verbosityReviewDesc,
  directnessReviewDesc,
  postureReviewDesc,
  validateStep1,
  buildIdentityPayload,
  type WizardState,
  type LocalIdentity,
} from './wizard-utils.js';

// ── toggleToneSelection ───────────────────────────────────────────────────────

describe('toggleToneSelection', () => {
  it('adds a word when under the max', () => {
    expect(toggleToneSelection(['warm'], 'direct')).toEqual(['warm', 'direct']);
  });

  it('removes a word when it is already selected', () => {
    expect(toggleToneSelection(['warm', 'direct'], 'warm')).toEqual(['direct']);
  });

  it('prevents removing the last word (min 1)', () => {
    expect(toggleToneSelection(['warm'], 'warm')).toEqual(['warm']);
  });

  it('prevents adding a 4th word (max 3)', () => {
    const current = ['warm', 'direct', 'calm'];
    expect(toggleToneSelection(current, 'witty')).toEqual(current);
  });

  it('allows toggling when exactly 3 are selected — remove one', () => {
    expect(toggleToneSelection(['warm', 'direct', 'calm'], 'calm'))
      .toEqual(['warm', 'direct']);
  });
});

// ── verbosityBand ─────────────────────────────────────────────────────────────

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

describe('directnessBand', () => {
  it('returns hedged copy at 0', () => {
    expect(directnessBand(0)).toBe(
      '"There are a few things worth considering here — it\'s hard to say definitively."',
    );
  });

  it('returns direct copy at 100', () => {
    expect(directnessBand(100)).toBe('"Do it. The risk is low and the upside is clear."');
  });
});

// ── tonePreviewText ───────────────────────────────────────────────────────────

describe('tonePreviewText', () => {
  it('formats single word', () => {
    expect(tonePreviewText(['warm'])).toBe('Your tone is warm.');
  });

  it('formats two words with "and"', () => {
    expect(tonePreviewText(['warm', 'direct'])).toBe('Your tone is warm and direct.');
  });

  it('formats three words with Oxford comma + note', () => {
    expect(tonePreviewText(['warm', 'direct', 'calm'])).toBe(
      'Your tone is warm, direct and calm. (Pick up to 3)',
    );
  });

  it('returns empty string for empty array', () => {
    expect(tonePreviewText([])).toBe('');
  });
});

// ── verbosityReviewDesc / directnessReviewDesc / postureReviewDesc ────────────

describe('verbosityReviewDesc', () => {
  it('returns concise description at 50', () => {
    expect(verbosityReviewDesc(50)).toBe('Concise responses by default.');
  });
});

describe('directnessReviewDesc', () => {
  it('returns direct description at 75', () => {
    expect(directnessReviewDesc(75)).toBe('Direct — minimal unnecessary hedging.');
  });
});

describe('postureReviewDesc', () => {
  it('maps conservative', () => {
    expect(postureReviewDesc('conservative')).toBe(
      'Verifies before acting on external requests.',
    );
  });
  it('maps balanced', () => {
    expect(postureReviewDesc('balanced')).toBe('Acts when confident; flags when uncertain.');
  });
  it('maps proactive', () => {
    expect(postureReviewDesc('proactive')).toBe('Biases toward action with less checking in.');
  });
});

// ── validateStep1 ─────────────────────────────────────────────────────────────

describe('validateStep1', () => {
  it('returns true for a non-empty name', () => {
    expect(validateStep1('Alex')).toBe(true);
  });

  it('returns false for an empty name', () => {
    expect(validateStep1('')).toBe(false);
  });

  it('returns false for whitespace-only name', () => {
    expect(validateStep1('   ')).toBe(false);
  });
});

// ── buildIdentityPayload ──────────────────────────────────────────────────────

describe('buildIdentityPayload', () => {
  const existingIdentity: LocalIdentity = {
    assistant: { name: 'Old', title: 'Old Title', emailSignature: '' },
    tone: { baseline: ['warm'], verbosity: 50, directness: 75 },
    behavioralPreferences: ['existing pref'],
    decisionStyle: { externalActions: 'balanced', internalAnalysis: 'proactive' },
    constraints: ['no spam'],
  };

  const state: WizardState = {
    name: 'Alex Curia',
    title: 'Executive Assistant to the CEO',
    signature: 'Best, Alex',
    toneBaseline: ['warm', 'direct'],
    verbosity: 60,
    directness: 80,
    posture: 'conservative',
    preferences: 'Flag investor emails',
  };

  it('maps WizardState onto identity correctly', () => {
    const { identity } = buildIdentityPayload(state, existingIdentity);
    expect(identity.assistant.name).toBe('Alex Curia');
    expect(identity.assistant.title).toBe('Executive Assistant to the CEO');
    expect(identity.assistant.emailSignature).toBe('Best, Alex');
    expect(identity.tone.baseline).toEqual(['warm', 'direct']);
    expect(identity.tone.verbosity).toBe(60);
    expect(identity.tone.directness).toBe(80);
    expect(identity.decisionStyle.externalActions).toBe('conservative');
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

  it('preserves internalAnalysis from existing identity', () => {
    const { identity } = buildIdentityPayload(state, existingIdentity);
    expect(identity.decisionStyle.internalAnalysis).toBe('proactive');
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
