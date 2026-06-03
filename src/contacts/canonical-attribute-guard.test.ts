// canonical-attribute-guard.test.ts
//
// Unit tests for the canonical contact attribute guard.
// Tests attribute resolution, phone normalization, and patch building.

import { describe, it, expect } from 'vitest';
import { resolveCanonicalField, normalizePhone, buildCanonicalPatch } from './canonical-attribute-guard.js';

describe('resolveCanonicalField', () => {
  it('maps known attribute keys to ContactCanonicalFields keys', () => {
    expect(resolveCanonicalField('timezone')).toBe('timezone');
    expect(resolveCanonicalField('tz')).toBe('timezone');
    expect(resolveCanonicalField('job_title')).toBe('title');
    expect(resolveCanonicalField('title')).toBe('title');
    expect(resolveCanonicalField('organization')).toBe('organization');
    expect(resolveCanonicalField('employer')).toBe('organization');
    expect(resolveCanonicalField('company')).toBe('organization');
    expect(resolveCanonicalField('current_employer')).toBe('organization');
    expect(resolveCanonicalField('email')).toBe('primaryEmail');
    expect(resolveCanonicalField('primary_email')).toBe('primaryEmail');
    expect(resolveCanonicalField('phone')).toBe('primaryPhone');
    expect(resolveCanonicalField('phone_number')).toBe('primaryPhone');
    expect(resolveCanonicalField('mobile')).toBe('primaryPhone');
    expect(resolveCanonicalField('preferred_name')).toBe('preferredName');
    expect(resolveCanonicalField('nickname')).toBe('preferredName');
    expect(resolveCanonicalField('locale')).toBe('locale');
    expect(resolveCanonicalField('language')).toBe('locale');
    expect(resolveCanonicalField('location')).toBe('location');
    expect(resolveCanonicalField('home_city')).toBe('location');
    expect(resolveCanonicalField('current_location')).toBe('location');
    expect(resolveCanonicalField('city')).toBe('location');
    expect(resolveCanonicalField('pronouns')).toBe('pronouns');
    expect(resolveCanonicalField('linkedin')).toBe('linkedinUrl');
    expect(resolveCanonicalField('linkedin_url')).toBe('linkedinUrl');
    expect(resolveCanonicalField('bio')).toBe('bio');
    expect(resolveCanonicalField('biography')).toBe('bio');
    expect(resolveCanonicalField('birthday')).toBe('birthday');
    expect(resolveCanonicalField('birthdate')).toBe('birthday');
    expect(resolveCanonicalField('dob')).toBe('birthday');
  });

  it('is case-insensitive', () => {
    expect(resolveCanonicalField('TIMEZONE')).toBe('timezone');
    expect(resolveCanonicalField('Job_Title')).toBe('title');
    expect(resolveCanonicalField('PHONE')).toBe('primaryPhone');
  });

  it('returns undefined for non-canonical attributes', () => {
    expect(resolveCanonicalField('preferred_airline')).toBeUndefined();
    expect(resolveCanonicalField('dietary_preference')).toBeUndefined();
    expect(resolveCanonicalField('active_project')).toBeUndefined();
    expect(resolveCanonicalField('funding_stage')).toBeUndefined();
  });

  it('returns undefined for role (excluded from deny-list)', () => {
    // role is ambiguous (categorical system role vs job title) and excluded intentionally.
    expect(resolveCanonicalField('role')).toBeUndefined();
  });
});

describe('normalizePhone', () => {
  it('normalizes North American 10-digit formats to E.164', () => {
    expect(normalizePhone('4165551234')).toBe('+14165551234');
    expect(normalizePhone('416-555-1234')).toBe('+14165551234');
    expect(normalizePhone('(416) 555-1234')).toBe('+14165551234');
    expect(normalizePhone('416.555.1234')).toBe('+14165551234');
    expect(normalizePhone('416 555 1234')).toBe('+14165551234');
  });

  it('normalizes international formats with explicit country code', () => {
    expect(normalizePhone('+14165551234')).toBe('+14165551234');
    expect(normalizePhone('+1 (416) 555-1234')).toBe('+14165551234');
    expect(normalizePhone('+1-416-555-1234')).toBe('+14165551234');
    expect(normalizePhone('+447911123456')).toBe('+447911123456');
  });

  it('returns null for strings that cannot be normalized', () => {
    expect(normalizePhone('not a phone number')).toBeNull();
    expect(normalizePhone('555-1234')).toBeNull(); // 7 digit — no area code
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('000-000-0000')).toBeNull(); // invalid number
  });
});

describe('buildCanonicalPatch', () => {
  it('returns null for non-canonical attributes', () => {
    expect(buildCanonicalPatch('preferred_airline', 'Air Canada')).toBeNull();
    expect(buildCanonicalPatch('dietary_preference', 'vegetarian')).toBeNull();
  });

  it('returns a fields patch for simple string attributes', () => {
    const result = buildCanonicalPatch('timezone', 'America/Toronto');
    expect(result).not.toBeNull();
    expect(result?.fallbackToKg).toBe(false);
    if (result && !result.fallbackToKg) {
      expect(result.fields).toEqual({ timezone: 'America/Toronto' });
    }
  });

  it('returns a fields patch for organization', () => {
    const result = buildCanonicalPatch('company', 'Acme Corp');
    expect(result).not.toBeNull();
    expect(result?.fallbackToKg).toBe(false);
    if (result && !result.fallbackToKg) {
      expect(result.fields).toEqual({ organization: 'Acme Corp' });
    }
  });

  it('normalizes phone numbers to E.164 for phone attributes', () => {
    const result = buildCanonicalPatch('phone', '(416) 555-1234');
    expect(result).not.toBeNull();
    expect(result?.fallbackToKg).toBe(false);
    if (result && !result.fallbackToKg) {
      expect(result.fields).toEqual({ primaryPhone: '+14165551234' });
    }
  });

  it('returns fallbackToKg when phone cannot be normalized', () => {
    const result = buildCanonicalPatch('phone', 'not-a-phone');
    expect(result).not.toBeNull();
    expect(result?.fallbackToKg).toBe(true);
  });

  it('returns fallbackToKg for mobile with unnormalizable number', () => {
    const result = buildCanonicalPatch('mobile', '555-1234'); // 7-digit local, no area code
    expect(result).not.toBeNull();
    expect(result?.fallbackToKg).toBe(true);
  });

  it('is case-insensitive on attribute key', () => {
    const result = buildCanonicalPatch('TIMEZONE', 'America/Toronto');
    expect(result).not.toBeNull();
    expect(result?.fallbackToKg).toBe(false);
  });
});
