import { describe, it, expect } from 'vitest';
import { buildContactViewFields, kgNodeHref, formatDateTime, type ContactViewModel } from './contacts-utils.js';

// A fully-empty contact except for the always-present tier/kind.
const EMPTY: ContactViewModel = {
  tier: 'known',
  kind: 'person',
  notes: null,
  preferredName: null,
  pronouns: null,
  role: null,
  title: null,
  organization: null,
  primaryEmail: null,
  primaryPhone: null,
  timezone: null,
  locale: null,
  location: null,
  linkedinUrl: null,
  bio: null,
  birthday: null,
  kgNodeId: null,
};

describe('buildContactViewFields', () => {
  it('returns only tier and kind for an otherwise-empty contact', () => {
    const fields = buildContactViewFields(EMPTY);
    expect(fields.map(f => f.key)).toEqual(['tier', 'kind']);
    expect(fields.find(f => f.key === 'tier')).toMatchObject({ label: 'Tier', value: 'known', kind: 'text' });
  });

  it('omits blank and whitespace-only values (no blank rows)', () => {
    const fields = buildContactViewFields({ ...EMPTY, title: '   ', organization: '' });
    expect(fields.some(f => f.key === 'title')).toBe(false);
    expect(fields.some(f => f.key === 'organization')).toBe(false);
  });

  it('trims surrounding whitespace from values', () => {
    const fields = buildContactViewFields({ ...EMPTY, title: '  CEO  ' });
    expect(fields.find(f => f.key === 'title')?.value).toBe('CEO');
  });

  it('tags email, phone, linkedin, and KG node with their render kinds', () => {
    const fields = buildContactViewFields({
      ...EMPTY,
      primaryEmail: 'a@b.com',
      primaryPhone: '+15551234567',
      linkedinUrl: 'https://linkedin.com/in/x',
      kgNodeId: 'node-1',
    });
    const byKey = Object.fromEntries(fields.map(f => [f.key, f.kind]));
    expect(byKey['primaryEmail']).toBe('email');
    expect(byKey['primaryPhone']).toBe('phone');
    expect(byKey['linkedinUrl']).toBe('url');
    expect(byKey['kgNodeId']).toBe('kg');
  });

  it('includes notes only when set', () => {
    expect(buildContactViewFields(EMPTY).some(f => f.key === 'notes')).toBe(false);
    const withNotes = buildContactViewFields({ ...EMPTY, notes: 'hello' });
    expect(withNotes.find(f => f.key === 'notes')).toMatchObject({ value: 'hello' });
  });

  it('orders fields by section (identity → work → contact → … → system)', () => {
    const fields = buildContactViewFields({
      ...EMPTY,
      preferredName: 'Al',
      title: 'CEO',
      primaryEmail: 'a@b.com',
      notes: 'n',
    });
    const keys = fields.map(f => f.key);
    expect(keys.indexOf('preferredName')).toBeLessThan(keys.indexOf('title'));
    expect(keys.indexOf('title')).toBeLessThan(keys.indexOf('primaryEmail'));
    expect(keys.indexOf('primaryEmail')).toBeLessThan(keys.indexOf('tier'));
    expect(keys.indexOf('tier')).toBeLessThan(keys.indexOf('notes'));
  });
});

describe('kgNodeHref', () => {
  it('builds a /kg deep link with the node id', () => {
    expect(kgNodeHref('abc-123')).toBe('/kg?node=abc-123');
  });

  it('URL-encodes the node id', () => {
    expect(kgNodeHref('a b&c')).toBe('/kg?node=a%20b%26c');
  });
});

describe('formatDateTime', () => {
  it('returns the raw input for an unparseable timestamp', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });

  it('produces a non-empty localized string for a valid ISO timestamp', () => {
    const out = formatDateTime('2024-01-02T03:04:05Z');
    expect(out).not.toBe('2024-01-02T03:04:05Z');
    expect(out.length).toBeGreaterThan(0);
  });
});
