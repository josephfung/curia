// Pure helper functions for the wizard — no React, no DOM, fully testable.

export interface WizardWorkingHours {
  start: string; // "HH:MM"
  end: string;   // "HH:MM"
  days: number[]; // 0=Sun..6=Sat
}

export interface WizardState {
  // Step 1 — About you. Captured separately from the assistant identity below
  // and POSTed to /api/setup/principal so the principal contact exists before
  // the rest of the form is saved. Pre-populated on a re-run; never auto-skipped.
  principalName: string;
  // Steps 3–6 — assistant identity, tone, posture, review.
  name: string;
  title: string;
  signature: string;
  toneBaseline: string[];
  verbosity: number;   // 0–100
  directness: number;  // 0–100
  posture: DecisionPosture;
  preferences: string;
  // Step 2 — Your details (principal operational profile, #392).
  timezone: string;
  email: string;
  preferredName: string;
  principalTitle: string; // distinct from `title` (the assistant's title, Step 3)
  workingHours: WizardWorkingHours | null;
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

// The assistant's surname. The LLM only ever suggests a first name (issue #799);
// the wizard pairs it with this fixed brand surname to form the full name shown
// in the name field and the email signature.
export const ASSISTANT_SURNAME = 'Curia';

// First name used in the static defaults when no LLM suggestion is available
// (the call hasn't returned, failed, or returned an unusable value).
export const DEFAULT_ASSISTANT_FIRST_NAME = 'Alex';

// Full assistant name from a first name: "Sam" → "Sam Curia".
export function assistantFullName(firstName: string): string {
  return `${firstName} ${ASSISTANT_SURNAME}`;
}

// Default email signature from a first name. Pre-populated into the signature
// field (not just shown as a placeholder) so a fresh install ships with a
// sensible signature the operator can keep or edit:
//
//   --
//   Sam Curia
//   Digital EA
//
// NOTE: `defaultSignature(DEFAULT_ASSISTANT_FIRST_NAME)` must match the seed
// `DEFAULT_OFFICE_IDENTITY.assistant.emailSignature` in src/identity/defaults.ts
// — that backend seed is what the wizard actually loads on a fresh install.
export function defaultSignature(firstName: string): string {
  return `--\n${assistantFullName(firstName)}\nDigital EA`;
}

export const DEFAULT_WIZARD_STATE: WizardState = {
  principalName: '',
  name: assistantFullName(DEFAULT_ASSISTANT_FIRST_NAME),
  title: 'Executive Assistant to the CEO',
  signature: defaultSignature(DEFAULT_ASSISTANT_FIRST_NAME),
  toneBaseline: ['warm', 'direct'],
  verbosity: 50,
  directness: 75,
  posture: 'conservative',
  preferences: '',
  timezone: '',
  email: '',
  preferredName: '',
  principalTitle: '',
  workingHours: null,
};

// Backend's POST /api/setup/principal accepts up to 200 characters; enforce the
// same ceiling client-side so the user sees the error before a round-trip.
export const PRINCIPAL_NAME_MAX_LENGTH = 200;

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

export type DecisionPosture = 'conservative' | 'balanced' | 'proactive';

export const POSTURE_OPTIONS: ReadonlyArray<{
  value: DecisionPosture;
  title: string;
  desc: string;
}> = [
  { value: 'conservative', title: 'Conservative', desc: 'Verify before acting; flag ambiguity' },
  { value: 'balanced',     title: 'Balanced',     desc: 'Act when confident, flag when uncertain' },
  { value: 'proactive',    title: 'Proactive',    desc: 'Bias toward action; less checking in' },
];

export function postureReviewDesc(posture: DecisionPosture): string {
  const map: Record<DecisionPosture, string> = {
    conservative: 'Verifies before acting on external requests.',
    balanced:     'Acts when confident; flags when uncertain.',
    proactive:    'Biases toward action with less checking in.',
  };
  return map[posture];
}

/** Live preview sentence under the executive writing-voice formality slider. */
export function formalityBand(v: number): string {
  if (v <= 25) return '"Hey — quick note on this."';
  if (v <= 50) return '"Sharing a brief update on the situation."';
  if (v <= 75) return '"Please find a concise summary below."';
  return '"I am writing to formally address the matter."';
}

// Returns true if a string is non-empty after trimming. Shared validator for
// both the principal name (step 1) and the assistant name (step 2) — both
// follow the same "must not be blank" rule.
export function validateNonEmptyName(name: string): boolean {
  return name.trim().length > 0;
}

// Returns null if the principal name passes both the non-empty and length
// checks; otherwise returns an error string suitable for inline display.
// Two checks instead of a single boolean because the user-visible message
// needs to distinguish "missing" from "too long".
export function validatePrincipalName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'Your name is required.';
  if (trimmed.length > PRINCIPAL_NAME_MAX_LENGTH) {
    return `Name must be ${PRINCIPAL_NAME_MAX_LENGTH} characters or fewer.`;
  }
  return null;
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

// Browser timezone detection for the Step 2 prefill (#392). Falls back to the
// backend default if the platform doesn't expose a resolved zone.
export function detectBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Toronto';
  } catch (err) {
    // Should never fire in a modern browser — defensive guard only.
    console.warn('[wizard-utils] detectBrowserTimezone failed, using default:', err);
    return 'America/Toronto';
  }
}

const PROFILE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Email is optional in Step 2. Returns null when blank (allowed) or valid; an error
// string when present-but-malformed.
export function validateProfileEmail(email: string): string | null {
  const trimmed = email.trim();
  if (trimmed.length === 0) return null;
  if (!PROFILE_EMAIL_RE.test(trimmed)) return 'Enter a valid email address.';
  return null;
}

// Builds the POST /api/setup/principal/profile body, omitting empty optionals so the
// backend never clobbers an existing value with a blank.
export function buildProfilePayload(state: WizardState): {
  timezone: string; email?: string; preferredName?: string; title?: string;
  workingHours?: WizardWorkingHours;
} {
  const payload: {
    timezone: string; email?: string; preferredName?: string; title?: string;
    workingHours?: WizardWorkingHours;
  } = { timezone: state.timezone.trim() };
  if (state.email.trim()) payload.email = state.email.trim();
  if (state.preferredName.trim()) payload.preferredName = state.preferredName.trim();
  if (state.principalTitle.trim()) payload.title = state.principalTitle.trim();
  if (state.workingHours) payload.workingHours = state.workingHours;
  return payload;
}
