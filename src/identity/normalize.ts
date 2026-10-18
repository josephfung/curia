// normalize.ts — read-time migration of stored office identities to the current shape.
//
// office_identity_versions.config is JSONB, and rows written before the tone & style rework
// (#2143) carry tone.baseline (1–3 tone words), tone.directness and decisionStyle instead
// of tone.style. Every read of a stored config goes through normalizeIdentity(), so the
// rest of the system only ever sees the current shape. Nothing is written back: the
// normalized shape is persisted by the next real write (an operator save, or a
// behavioral-preferences-update call). Writing at boot was rejected for rollback safety:
// the previous release reads tone.baseline and would break on a new-shape row.
// See docs/wip/2026-10-15-tone-and-style-design.md, "Migration".

import { DEFAULT_OFFICE_IDENTITY } from './defaults.js';
import type { OfficeIdentity } from './types.js';

/** Keys that only legacy rows carry. Always stripped, even when tone.style is present. */
export const LEGACY_TONE_KEYS = ['baseline', 'directness'] as const;
export const LEGACY_TOP_LEVEL_KEYS = ['decisionStyle'] as const;

// The sentences the old renderer emitted for tone.directness, kept so a migrated style
// says what the operator's slider said.
function directnessSentence(score: number): string {
  if (score <= 25) return 'Be measured; acknowledge uncertainty with appropriate qualification.';
  if (score <= 50) return 'Lean toward directness but hedge where genuinely uncertain.';
  if (score <= 75) return 'Be direct; minimize unnecessary hedging and qualification.';
  return 'State positions plainly; avoid softening language.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** "Candid, warm and direct." from ['candid', 'warm', 'direct']. */
function joinToneWords(words: string[]): string {
  const phrase = words.length === 1
    ? words[0]!
    : `${words.slice(0, -1).join(', ')} and ${words.at(-1)!}`;
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}.`;
}

/**
 * The style a legacy row's tone words and directness amount to. No usable tone words
 * (`baseline: []` was valid) means the default style; a missing directness adds nothing.
 */
export function legacyStyle(baseline: unknown, directness: unknown): string {
  const words = Array.isArray(baseline)
    ? baseline.filter((w): w is string => typeof w === 'string' && w.trim() !== '').map(w => w.trim())
    : [];
  if (words.length === 0) return DEFAULT_OFFICE_IDENTITY.tone.style;
  const parts = [joinToneWords(words)];
  if (typeof directness === 'number' && Number.isFinite(directness)) parts.push(directnessSentence(directness));
  return parts.join(' ');
}

/**
 * A stored config in the current shape. A legacy row (no usable tone.style) gets a style
 * built from its tone words and directness. Legacy keys are always dropped, so a
 * half-migrated row never reaches a writer with keys validation rejects. The result
 * passes validateIdentity() whenever the row's other fields do.
 *
 * A value that is not an object at all is returned as is: there is nothing to migrate,
 * and the renderer and validator report it.
 */
export function normalizeIdentity(raw: unknown): OfficeIdentity {
  if (!isRecord(raw)) return raw as OfficeIdentity;
  const rest: Record<string, unknown> = { ...raw };
  for (const key of LEGACY_TOP_LEVEL_KEYS) delete rest[key];
  const tone = isRecord(raw['tone']) ? raw['tone'] : {};
  const { baseline, directness, ...currentTone } = tone;
  const style = typeof currentTone['style'] === 'string' && currentTone['style'].trim() !== ''
    ? currentTone['style']
    : legacyStyle(baseline, directness);
  // The other fields are as stored; validateIdentity() and the renderer check them.
  return { ...rest, tone: { ...currentTone, style } } as unknown as OfficeIdentity;
}
