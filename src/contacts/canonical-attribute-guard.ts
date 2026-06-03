// src/contacts/canonical-attribute-guard.ts
//
// Write-side guard for canonical contact attributes.
//
// When an agent calls memory-store (or extract-facts triggers) with an attribute
// that is now a canonical column on the contacts table (e.g. "timezone", "title",
// "organization"), this module detects the match and redirects the write to
// ContactService.updateContactFields() instead of the KG.
//
// Why this matters: KG facts and the contacts table would otherwise diverge — the
// assembler would return the structured value from the contacts row AND an unfiltered
// KG fact with the same information. Centralising canonical attributes on the Contact
// record eliminates that duplication and gives specialists a single reliable read path.
//
// E.164 phone normalization: the `primary_phone` column has a CHECK constraint
// (^\+[1-9][0-9]{6,14}$). Values from agents arrive in human-readable formats
// ("(416) 555-1234", "+1 416-555-1234", etc.) so we normalise via libphonenumber-js
// before writing. If normalization fails, we fall back to letting the KG write through
// (logged as a warning so the gap is observable).

import { parsePhoneNumber, isValidPhoneNumber, ParseError } from 'libphonenumber-js';
import type { ContactCanonicalFields } from './types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Deny-list: KG attribute keys → ContactCanonicalFields key
//
// Keys are lowercase; the guard normalises incoming attribute keys before lookup.
// Note: 'role' is intentionally excluded — it is too ambiguous (could be a
// categorical system role or a job title). Let those facts flow to the KG.
// ──────────────────────────────────────────────────────────────────────────────

export const CANONICAL_ATTRIBUTE_MAP: ReadonlyMap<string, keyof ContactCanonicalFields> = new Map([
  ['preferred_name', 'preferredName'],
  ['nickname',       'preferredName'],
  ['job_title',      'title'],
  ['title',          'title'],
  ['organization',   'organization'],
  ['employer',       'organization'],
  ['company',        'organization'],
  ['current_employer', 'organization'],
  ['email',          'primaryEmail'],
  ['primary_email',  'primaryEmail'],
  ['phone',          'primaryPhone'],
  ['phone_number',   'primaryPhone'],
  ['mobile',         'primaryPhone'],
  ['timezone',       'timezone'],
  ['tz',             'timezone'],
  ['locale',         'locale'],
  ['language',       'locale'],
  ['home_city',      'location'],
  ['current_location', 'location'],
  ['location',       'location'],
  ['city',           'location'],
  ['pronouns',       'pronouns'],
  ['linkedin',       'linkedinUrl'],
  ['linkedin_url',   'linkedinUrl'],
  ['bio',            'bio'],
  ['biography',      'bio'],
  ['birthday',       'birthday'],
  ['birthdate',      'birthday'],
  ['dob',            'birthday'],
]);

/**
 * Check whether a KG attribute key is in the canonical deny-list.
 * Case-insensitive. Returns the ContactCanonicalFields key if matched,
 * undefined if the attribute should flow through to the KG.
 */
export function resolveCanonicalField(
  attribute: string,
): keyof ContactCanonicalFields | undefined {
  return CANONICAL_ATTRIBUTE_MAP.get(attribute.trim().toLowerCase());
}

/**
 * Normalize a phone number string to E.164 format.
 *
 * Attempts libphonenumber-js parsing with a fallback to North American
 * default country (US) for unqualified 10-digit numbers. Returns null if
 * the value cannot be parsed to a valid E.164 string — callers should
 * fall back to the KG write path in that case.
 */
export function normalizePhone(value: string): string | null {
  try {
    // First try parsing as-is (handles values that already include country code).
    if (isValidPhoneNumber(value)) {
      const parsed = parsePhoneNumber(value);
      return parsed.format('E.164');
    }

    // Fallback: try treating as a North American number (US default country).
    // This handles "416-555-1234", "(416) 555 1234", etc.
    if (isValidPhoneNumber(value, 'US')) {
      const parsed = parsePhoneNumber(value, 'US');
      return parsed.format('E.164');
    }

    // Fallback: try Canadian country code (CA shares the NANP with US).
    if (isValidPhoneNumber(value, 'CA')) {
      const parsed = parsePhoneNumber(value, 'CA');
      return parsed.format('E.164');
    }

    return null;
  } catch (err) {
    // Only swallow ParseError (expected "invalid input" path from libphonenumber-js).
    // Re-throw everything else so programming errors in this function are not masked
    // as "failed to normalize" — they'd silently fall through to KG writes everywhere.
    if (err instanceof ParseError) {
      return null;
    }
    throw err;
  }
}

/**
 * Build a ContactCanonicalFields patch object for a single attribute/value pair.
 *
 * Returns null in two cases:
 *   - The attribute is not in the canonical deny-list (caller should write to KG).
 *   - The attribute IS canonical but the value failed normalization (e.g. a phone
 *     number that cannot be parsed to E.164). In this case `fallbackToKg` is true
 *     in the returned tuple so the caller can log and write to the KG instead.
 */
export function buildCanonicalPatch(
  attribute: string,
  value: string,
): { fields: ContactCanonicalFields; fallbackToKg: false } | { fallbackToKg: true; reason: string } | null {
  const fieldKey = resolveCanonicalField(attribute);
  if (!fieldKey) return null; // Not a canonical attribute — let KG write through.

  if (fieldKey === 'primaryPhone') {
    const normalized = normalizePhone(value);
    if (!normalized) {
      return {
        fallbackToKg: true,
        reason: `Phone value could not be normalized to E.164: "${value}". Writing to KG instead.`,
      };
    }
    return { fields: { primaryPhone: normalized }, fallbackToKg: false };
  }

  return { fields: { [fieldKey]: value } as ContactCanonicalFields, fallbackToKg: false };
}
