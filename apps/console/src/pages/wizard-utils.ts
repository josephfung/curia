// Pure helpers shared by the Setup page and the Personality settings — no React, no DOM, fully testable.

import { bandForScore, scoreForBand, type AutonomyBand } from '../autonomy-bands.js';

// Local mirror of the OfficeIdentity shape from the backend identity API.
// Kept in-app to avoid importing from src/ (different package).
export interface LocalIdentity {
  assistant: { name: string; title: string; emailSignature: string };
  tone: { style: string; verbosity: number };
  behavioralPreferences: string[];
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

// The signature the gateway sends when the signature field is empty: the assistant's
// name over its title (#2554). Mirrors `emailSignatureText` in
// src/channels/email/signature.ts, so the console shows exactly what goes out.
export function fallbackEmailSignature(name: string, title: string): string {
  return [name, title].map(s => s.trim()).filter(Boolean).join('\n');
}

// Backend's POST /api/setup/principal accepts up to 200 characters; enforce the
// same ceiling client-side so the user sees the error before a round-trip.
export const PRINCIPAL_NAME_MAX_LENGTH = 200;

// The longest tone & style text the identity accepts (TONE_STYLE_MAX_LENGTH in
// src/identity/types.ts).
export const TONE_STYLE_MAX_LENGTH = 800;

// Starter templates for Tone & style. Each ends with one example line: an example does
// more than any adjective, and operators get one without having to write it.
//
// NOTE: the "warm" text must match DEFAULT_OFFICE_IDENTITY.tone.style in
// src/identity/defaults.ts, the seed a fresh install's wizard loads, so the seed reads as
// an untouched template.
export const STYLE_TEMPLATES: ReadonlyArray<{ id: string; label: string; text: string }> = [
  {
    id: 'dry',
    label: 'Dry & understated',
    text: 'Dry and understated. Plain statements; no exclamation marks, no enthusiasm, no pleasantries. Says what happened and stops.\n'
      + 'Sounds like: "Done. Thursday\'s call is now at 3."',
  },
  {
    id: 'warm',
    label: 'Warm & personable',
    text: 'Warm and personable, but brief. Friendly in a few words, never gushing; the point comes first.\n'
      + 'Sounds like: "All set: Thursday\'s call is now at 3. Enjoy the long weekend."',
  },
  {
    id: 'crisp',
    label: 'Crisp & direct',
    text: 'Crisp and direct. Leads with the answer or the decision needed; short sentences, no hedging, no filler.\n'
      + 'Sounds like: "Moved Thursday\'s call to 3. Need your OK on the Lumen invoice."',
  },
  {
    id: 'formal',
    label: 'Formal',
    text: 'Formal and polished. Complete sentences, courteous, no slang or contractions; precise rather than wordy.\n'
      + 'Sounds like: "Thursday\'s call has been moved to 3:00 p.m."',
  },
];

// Returns null when the tone & style text is usable, or an error for inline display.
export function validateToneStyle(text: string): string | null {
  if (text.trim().length === 0) return 'Describe how your assistant should sound, or start from a template.';
  if (text.length > TONE_STYLE_MAX_LENGTH) {
    return `Keep it to ${TONE_STYLE_MAX_LENGTH} characters or fewer (now ${text.length}).`;
  }
  return null;
}

// The Detail slider's per-channel length limits, as GET /api/identity returns them
// (LENGTH_LIMITS_RESPONSE in src/channels/http/routes/identity.ts): the table the identity
// block renders, so the preview never drifts from what Curia is told.
export interface LengthLimits {
  rows: ReadonlyArray<{ id: string; label: string }>;
  bands: ReadonlyArray<{ maxVerbosity: number; label: string; limits: Readonly<Record<string, string>> }>;
}

// The preview under the Detail slider: the band's name and each channel's limit.
export function lengthPreview(
  table: LengthLimits,
  verbosity: number,
): { band: string; lines: Array<{ label: string; limit: string }> } | null {
  const band = table.bands.find(b => verbosity <= b.maxVerbosity) ?? table.bands[table.bands.length - 1];
  if (!band) return null;
  return {
    band: band.label,
    lines: table.rows.map(r => ({ label: r.label, limit: band.limits[r.id] ?? '' })),
  };
}

/**
 * The PUT /api/autonomy body for the band picked in the wizard, or null when the picked
 * band is the current one (the score stays exactly as it is).
 */
export function autonomyChange(
  currentScore: number,
  band: AutonomyBand,
): { score: number; reason: string } | null {
  if (bandForScore(currentScore) === band) return null;
  return { score: scoreForBand(band), reason: 'Set via onboarding wizard' };
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

