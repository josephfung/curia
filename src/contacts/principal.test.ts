// principal.test.ts — unit tests for originator helpers.

import { describe, it, expect } from 'vitest';
import { getInitiatingTier, isExternalOriginatorMissingTier } from './principal.js';

function meta(originator: Record<string, unknown> | undefined): Record<string, unknown> {
  return originator === undefined ? {} : { originator };
}

const baseExternal = {
  contactId: 'c-1',
  systemRole: null,
  channel: 'email',
  initiatedAt: '2026-06-19T00:00:00.000Z',
};

describe('getInitiatingTier', () => {
  it('returns the tier for an external originator', () => {
    expect(getInitiatingTier(meta({ ...baseExternal, tier: 'known' }))).toBe('known');
  });

  it('returns null for system/agent originators and when tier/originator/metadata are absent', () => {
    expect(getInitiatingTier(meta({ ...baseExternal, systemRole: 'system', tier: null }))).toBeNull();
    expect(getInitiatingTier(meta({ ...baseExternal, systemRole: 'agent', tier: 'unknown' }))).toBeNull();
    expect(getInitiatingTier(meta({ ...baseExternal }))).toBeNull(); // no tier field
    expect(getInitiatingTier(meta(undefined))).toBeNull();
    expect(getInitiatingTier(undefined)).toBeNull();
  });
});

describe('isExternalOriginatorMissingTier (#1059 fail-closed trigger)', () => {
  it('is true only when an external originator has no resolved tier', () => {
    expect(isExternalOriginatorMissingTier(meta({ ...baseExternal }))).toBe(true); // tier absent
    expect(isExternalOriginatorMissingTier(meta({ ...baseExternal, tier: null }))).toBe(true);
  });

  it('is false when the external originator carries a tier', () => {
    expect(isExternalOriginatorMissingTier(meta({ ...baseExternal, tier: 'known' }))).toBe(false);
    expect(isExternalOriginatorMissingTier(meta({ ...baseExternal, tier: 'unknown' }))).toBe(false);
  });

  it('is false for system/agent originators (not externally initiated)', () => {
    expect(isExternalOriginatorMissingTier(meta({ ...baseExternal, systemRole: 'system', tier: null }))).toBe(false);
    expect(isExternalOriginatorMissingTier(meta({ ...baseExternal, systemRole: 'agent' }))).toBe(false);
  });

  it('is false when there is no originator or no metadata', () => {
    expect(isExternalOriginatorMissingTier(meta(undefined))).toBe(false);
    expect(isExternalOriginatorMissingTier(undefined)).toBe(false);
  });
});
