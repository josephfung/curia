import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DEFAULT_OFFICE_IDENTITY } from '../../../src/identity/defaults.js';
import { legacyStyle, normalizeIdentity } from '../../../src/identity/normalize.js';
import { OfficeIdentityService } from '../../../src/identity/service.js';
import type { OfficeIdentity } from '../../../src/identity/types.js';
import type { EventBus } from '../../../src/bus/bus.js';
import { createLogger } from '../../../src/logger.js';

// A row as the previous release wrote it (#2143).
const LEGACY = {
  assistant: { name: 'Nathan Curia', title: 'Office of the CEO', emailSignature: '--\nNathan' },
  tone: { baseline: ['candid', 'warm', 'direct'], verbosity: 20, directness: 90 },
  behavioralPreferences: ['Call me Joe'],
  decisionStyle: { externalActions: 'conservative', internalAnalysis: 'proactive' },
  constraints: ['Never impersonate the principal'],
};

/** validateIdentity() through a subclass, the way the scenario fixture service reaches it. */
class Validator extends OfficeIdentityService {
  constructor() {
    super({} as Pool, createLogger('silent'), {} as EventBus);
  }
  check(config: OfficeIdentity): void {
    this.validateIdentity(config);
  }
}
const validator = new Validator();

describe('normalizeIdentity (#2143)', () => {
  it('turns tone words and directness into a written style', () => {
    const out = normalizeIdentity(LEGACY);
    expect(out.tone).toEqual({
      style: 'Candid, warm and direct. State positions plainly; avoid softening language.',
      verbosity: 20,
    });
    expect(out).not.toHaveProperty('decisionStyle');
    expect(out.behavioralPreferences).toEqual(['Call me Joe']);
    expect(out.assistant.name).toBe('Nathan Curia');
  });

  it('joins one and two words naturally', () => {
    expect(legacyStyle(['dry'], undefined)).toBe('Dry.');
    expect(legacyStyle(['warm', 'direct'], 75)).toBe('Warm and direct. Be direct; minimize unnecessary hedging and qualification.');
  });

  // The edge rows the design names: each must come out passing validation, because
  // behavioral-preferences-update does get(), edit, update() on whatever was stored.
  const edges: Record<string, unknown> = {
    'empty baseline': { ...LEGACY, tone: { baseline: [], verbosity: 50, directness: 40 } },
    'missing directness': { ...LEGACY, tone: { baseline: ['calm'], verbosity: 50 } },
    'missing decisionStyle': { ...LEGACY, decisionStyle: undefined },
    'style plus legacy keys': {
      ...LEGACY,
      tone: { style: 'Dry.\nSounds like: "Done."', baseline: ['warm'], verbosity: 50, directness: 10 },
    },
    'a blank style': { ...LEGACY, tone: { style: '   ', baseline: ['frank'], verbosity: 50 } },
  };
  for (const [label, row] of Object.entries(edges)) {
    it(`normalizes a row with ${label} into a valid identity`, () => {
      const out = normalizeIdentity(row);
      expect(() => validator.check(out)).not.toThrow();
      expect(out.tone).not.toHaveProperty('baseline');
      expect(out.tone).not.toHaveProperty('directness');
      expect(out).not.toHaveProperty('decisionStyle');
    });
  }

  it('uses the default style when there are no usable tone words', () => {
    expect(normalizeIdentity(edges['empty baseline']).tone.style).toBe(DEFAULT_OFFICE_IDENTITY.tone.style);
  });

  it('adds no stray sentence for a missing directness', () => {
    expect(normalizeIdentity(edges['missing directness']).tone.style).toBe('Calm.');
  });

  it('keeps a written style and drops the legacy keys beside it', () => {
    expect(normalizeIdentity(edges['style plus legacy keys']).tone)
      .toEqual({ style: 'Dry.\nSounds like: "Done."', verbosity: 50 });
  });

  it('leaves a current row as it is', () => {
    expect(normalizeIdentity(DEFAULT_OFFICE_IDENTITY)).toEqual(DEFAULT_OFFICE_IDENTITY);
  });

  it('passes a non-object through for the validator and renderer to report', () => {
    expect(normalizeIdentity(null)).toBeNull();
  });
});
