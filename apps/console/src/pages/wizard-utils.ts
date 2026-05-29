// Pure helper functions for the wizard — no React, no DOM, fully testable.

export interface WizardState {
  name: string;
  title: string;
  signature: string;
  toneBaseline: string[];
  verbosity: number;   // 0–100
  directness: number;  // 0–100
  posture: 'conservative' | 'balanced' | 'proactive';
  preferences: string;
}

// Local mirror of the OfficeIdentity shape from the backend identity API.
// Kept in-app to avoid importing from src/ (different package).
export interface LocalIdentity {
  assistant: { name: string; title: string; emailSignature: string };
  tone: { baseline: string[]; verbosity: number; directness: number };
  behavioralPreferences: string[];
  decisionStyle: {
    externalActions: 'conservative' | 'balanced' | 'proactive';
    internalAnalysis: 'conservative' | 'balanced' | 'proactive';
  };
  constraints: string[];
}

export const DEFAULT_WIZARD_STATE: WizardState = {
  name: 'Alex Curia',
  title: 'Executive Assistant to the CEO',
  signature: '',
  toneBaseline: ['warm', 'direct'],
  verbosity: 50,
  directness: 75,
  posture: 'conservative',
  preferences: '',
};

// All valid tone words — mirrors BASELINE_TONE_OPTIONS in src/identity/types.ts.
// @TODO: consider exposing this via the API so both sides stay in sync automatically.
export const TONE_OPTIONS: readonly string[] = [
  'warm', 'friendly', 'approachable', 'personable', 'empathetic', 'encouraging', 'gracious', 'caring',
  'direct', 'blunt', 'candid', 'frank', 'matter-of-fact', 'no-nonsense',
  'energetic', 'calm', 'composed', 'enthusiastic', 'steady', 'measured',
  'playful', 'witty', 'dry', 'charming', 'diplomatic', 'tactful', 'thoughtful', 'curious',
  'confident', 'assured', 'polished', 'authoritative', 'professional',
];

// Toggles a tone word in the selection. Enforces min=1 (can't remove last) and max=3.
export function toggleToneSelection(current: string[], word: string): string[] {
  const idx = current.indexOf(word);
  if (idx !== -1) {
    if (current.length <= 1) return current; // min 1 — no-op
    return current.filter(w => w !== word);
  }
  if (current.length >= 3) return current; // max 3 — no-op
  return [...current, word];
}

// Live preview sentence shown under the verbosity slider.
export function verbosityBand(v: number): string {
  if (v <= 25) return '"Here\'s the short answer."';
  if (v <= 50) return '"Happy to help — let me know if you\'d like more detail."';
  if (v <= 75) return '"Here\'s what you need to know, plus a bit of context."';
  return '"Let me walk you through this thoroughly."';
}

// Live preview sentence shown under the directness slider.
export function directnessBand(v: number): string {
  if (v <= 25) return '"There are a few things worth considering here — it\'s hard to say definitively."';
  if (v <= 50) return '"I\'d lean toward option A, though it depends on your priorities."';
  if (v <= 75) return '"Thursday works. I\'ll send the invite."';
  return '"Do it. The risk is low and the upside is clear."';
}

// Prose sentence shown in the tone pill preview area.
export function tonePreviewText(words: string[]): string {
  if (words.length === 0) return '';
  const phrase =
    words.length === 1
      ? words[0]!
      : words.length === 2
        ? `${words[0]} and ${words[1]}`
        : `${words[0]}, ${words[1]} and ${words[2]}`;
  const suffix = words.length >= 3 ? ' (Pick up to 3)' : '';
  return `Your tone is ${phrase}.${suffix}`;
}

// Short descriptions used in the review card (step 4).
export function verbosityReviewDesc(v: number): string {
  if (v <= 25) return 'Very brief responses — just the essentials.';
  if (v <= 50) return 'Concise responses by default.';
  if (v <= 75) return 'Adapts length to the situation.';
  return 'Thorough by default — full context included.';
}

export function directnessReviewDesc(d: number): string {
  if (d <= 25) return 'Measured — acknowledges uncertainty carefully.';
  if (d <= 50) return 'Leans direct but hedges where uncertain.';
  if (d <= 75) return 'Direct — minimal unnecessary hedging.';
  return 'States positions plainly; no softening.';
}

export function postureReviewDesc(posture: WizardState['posture']): string {
  const map: Record<WizardState['posture'], string> = {
    conservative: 'Verifies before acting on external requests.',
    balanced:     'Acts when confident; flags when uncertain.',
    proactive:    'Biases toward action with less checking in.',
  };
  return map[posture];
}

// Returns true if the user can advance past step 1 (name is required).
export function validateStep1(name: string): boolean {
  return name.trim().length > 0;
}

// Maps WizardState onto an existing LocalIdentity, appending preferences.
// The internalAnalysis and constraints fields are always preserved from the
// existing identity since the wizard does not expose them.
export function buildIdentityPayload(
  state: WizardState,
  existing: LocalIdentity,
): { identity: LocalIdentity; note: string } {
  const prefs = state.preferences.trim()
    ? [...existing.behavioralPreferences, state.preferences.trim()]
    : [...existing.behavioralPreferences];

  const identity: LocalIdentity = {
    assistant: {
      name: state.name.trim(),
      title: state.title.trim(),
      emailSignature: state.signature.trim(),
    },
    tone: {
      baseline: state.toneBaseline,
      verbosity: state.verbosity,
      directness: state.directness,
    },
    behavioralPreferences: prefs,
    decisionStyle: {
      externalActions: state.posture,
      internalAnalysis: existing.decisionStyle.internalAnalysis,
    },
    constraints: existing.constraints,
  };

  return { identity, note: 'Saved via onboarding wizard' };
}
