// Tests for ExecutiveProfileService — validation, YAML mapping, and prompt compilation.
//
// These are unit tests that exercise the service's pure-function exports directly,
// without needing a database or a full service instance.
// The service's DB lifecycle (initialize, update, reload, history) follows the same
// pattern as OfficeIdentityService and is covered by integration tests.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import type { ExecutiveProfile } from '../../../src/executive/types.js';
import { validateProfile, compileWritingVoiceBlock } from '../../../src/executive/service.js';

describe('Executive profile YAML schema', () => {
  it('loads the default config/executive-profile.yaml', () => {
    const configPath = path.resolve(import.meta.dirname, '../../../config/executive-profile.yaml');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = yaml.load(raw) as { executive?: { writing_voice?: unknown } };

    expect(parsed.executive).toBeDefined();
    expect(parsed.executive!.writing_voice).toBeDefined();
  });

  it('has the expected default structure', () => {
    const configPath = path.resolve(import.meta.dirname, '../../../config/executive-profile.yaml');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = yaml.load(raw) as {
      executive: {
        writing_voice: {
          tone: string[];
          formality: number;
          patterns: string[];
          vocabulary: { prefer: string[]; avoid: string[] };
          sign_off: string;
        };
      };
    };

    const voice = parsed.executive.writing_voice;
    expect(Array.isArray(voice.tone)).toBe(true);
    expect(typeof voice.formality).toBe('number');
    expect(voice.formality).toBeGreaterThanOrEqual(0);
    expect(voice.formality).toBeLessThanOrEqual(100);
    expect(Array.isArray(voice.patterns)).toBe(true);
    expect(voice.vocabulary).toHaveProperty('prefer');
    expect(voice.vocabulary).toHaveProperty('avoid');
    expect(typeof voice.sign_off).toBe('string');
  });
});

describe('validateProfile', () => {
  const validProfile: ExecutiveProfile = {
    writingVoice: {
      tone: ['direct', 'warm'],
      formality: 50,
      patterns: ['Short sentences.'],
      vocabulary: { prefer: ['folks'], avoid: ['synergy'] },
      signOff: '-- Joseph',
    },
  };

  it('accepts a valid profile without throwing', () => {
    expect(() => validateProfile(validProfile)).not.toThrow();
  });

  it('rejects a profile missing writingVoice', () => {
    expect(() => validateProfile({} as ExecutiveProfile)).toThrow('Executive profile requires writingVoice');
  });

  it('rejects formality outside 0-100', () => {
    const bad: ExecutiveProfile = {
      writingVoice: { ...validProfile.writingVoice, formality: 150 },
    };
    expect(() => validateProfile(bad)).toThrow(
      'writingVoice.formality must be an integer between 0 and 100',
    );
  });

  it('rejects non-integer formality', () => {
    const bad: ExecutiveProfile = {
      writingVoice: { ...validProfile.writingVoice, formality: 50.5 },
    };
    expect(() => validateProfile(bad)).toThrow(
      'writingVoice.formality must be an integer between 0 and 100',
    );
  });

  it('accepts exactly 3 tone descriptors', () => {
    const profile: ExecutiveProfile = {
      writingVoice: { ...validProfile.writingVoice, tone: ['direct', 'warm', 'confident'] },
    };
    expect(() => validateProfile(profile)).not.toThrow();
  });

  it('rejects more than 3 tone descriptors', () => {
    const bad: ExecutiveProfile = {
      writingVoice: { ...validProfile.writingVoice, tone: ['a', 'b', 'c', 'd'] },
    };
    expect(() => validateProfile(bad)).toThrow(
      'writingVoice.tone may contain at most 3 descriptors',
    );
  });

  it('rejects non-string tone entries', () => {
    const bad = {
      writingVoice: { ...validProfile.writingVoice, tone: [1, 2] },
    } as unknown as ExecutiveProfile;
    expect(() => validateProfile(bad)).toThrow('writingVoice.tone must be an array of strings');
  });

  it('rejects non-string patterns entries', () => {
    const bad = {
      writingVoice: { ...validProfile.writingVoice, patterns: [42] },
    } as unknown as ExecutiveProfile;
    expect(() => validateProfile(bad)).toThrow('writingVoice.patterns must be an array of strings');
  });

  it('rejects missing vocabulary', () => {
    const bad = {
      writingVoice: { ...validProfile.writingVoice, vocabulary: null },
    } as unknown as ExecutiveProfile;
    expect(() => validateProfile(bad)).toThrow(
      'writingVoice.vocabulary must have prefer and avoid string arrays',
    );
  });

  it('rejects non-string signOff', () => {
    const bad = {
      writingVoice: { ...validProfile.writingVoice, signOff: 42 },
    } as unknown as ExecutiveProfile;
    expect(() => validateProfile(bad)).toThrow('writingVoice.signOff must be a string');
  });
});

describe('compileWritingVoiceBlock', () => {
  const testProfile: ExecutiveProfile = {
    writingVoice: {
      tone: ['direct', 'warm'],
      formality: 40,
      patterns: [
        'Short sentences. Rarely more than 15 words.',
        'Uses em dashes freely',
      ],
      vocabulary: {
        prefer: ['straightforward', 'folks'],
        avoid: ['leverage', 'synergy'],
      },
      signOff: '-- Joseph',
    },
  };

  it('includes the executive name in the header', () => {
    const block = compileWritingVoiceBlock(testProfile, 'Joseph Fung');
    expect(block).toContain("Joseph Fung's name");
  });

  it('includes tone descriptors', () => {
    const block = compileWritingVoiceBlock(testProfile, 'Joseph');
    expect(block).toContain('direct and warm');
  });

  it('includes formality guidance for score <= 50', () => {
    const block = compileWritingVoiceBlock(testProfile, 'Joseph');
    expect(block).toContain('conversationally but with structure');
  });

  it('includes formality guidance for high formality', () => {
    const formalProfile: ExecutiveProfile = {
      writingVoice: { ...testProfile.writingVoice, formality: 90 },
    };
    const block = compileWritingVoiceBlock(formalProfile, 'Joseph');
    expect(block).toContain('Formal and precise');
  });

  it('includes writing patterns', () => {
    const block = compileWritingVoiceBlock(testProfile, 'Joseph');
    expect(block).toContain('Short sentences');
    expect(block).toContain('em dashes');
  });

  it('includes vocabulary preferences', () => {
    const block = compileWritingVoiceBlock(testProfile, 'Joseph');
    expect(block).toContain('Prefer: straightforward, folks');
    expect(block).toContain('Avoid: leverage, synergy');
  });

  it('includes sign-off', () => {
    const block = compileWritingVoiceBlock(testProfile, 'Joseph');
    expect(block).toContain('End emails with: -- Joseph');
  });

  it('omits vocabulary section when both lists are empty', () => {
    const noVocab: ExecutiveProfile = {
      writingVoice: {
        ...testProfile.writingVoice,
        vocabulary: { prefer: [], avoid: [] },
      },
    };
    const block = compileWritingVoiceBlock(noVocab, 'Joseph');
    expect(block).not.toContain('**Vocabulary:**');
  });

  it('omits sign-off section when empty', () => {
    const noSignOff: ExecutiveProfile = {
      writingVoice: { ...testProfile.writingVoice, signOff: '' },
    };
    const block = compileWritingVoiceBlock(noSignOff, 'Joseph');
    expect(block).not.toContain('**Sign-off:**');
  });

  it('distinguishes assistant voice from executive voice', () => {
    const block = compileWritingVoiceBlock(testProfile, 'Joseph');
    expect(block).toContain('NOT your (the assistant\'s) voice');
    expect(block).toContain('the executive\'s voice');
  });
});

describe('interpolateRuntimeContext with executive_voice_block', () => {
  // The ${executive_voice_block} injection path was removed (Task 4, #957). The
  // placeholder, if ever present in a template, now has no special handling and is
  // left literal — confirmed below so a future re-introduction of the token is intentional.
  it('leaves placeholder literal when no executive voice block provided', async () => {
    const { interpolateRuntimeContext } = await import('../../../src/agents/loader.js');
    const template = 'Before ${executive_voice_block} after';
    const result = interpolateRuntimeContext(template, {});
    expect(result).toBe('Before ${executive_voice_block} after');
  });
});
