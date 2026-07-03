import { describe, it, expect } from 'vitest';
import {
  PREMADE_COUNT,
  characterSheetIndexForAgent,
  characterSheetKey,
  characterSheetFile,
} from './character-sheets.js';

describe('characterSheetIndexForAgent', () => {
  it('is stable for the same agent id', () => {
    expect(characterSheetIndexForAgent('coordinator')).toBe(characterSheetIndexForAgent('coordinator'));
  });

  it('always returns an index in [1, PREMADE_COUNT]', () => {
    for (const id of ['a', 'coordinator', 'ceo-inbox', 'calendar', 'x'.repeat(40), '']) {
      const idx = characterSheetIndexForAgent(id);
      expect(idx).toBeGreaterThanOrEqual(1);
      expect(idx).toBeLessThanOrEqual(PREMADE_COUNT);
    }
  });

  it('distributes across many sheets (not all identical)', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(characterSheetIndexForAgent(`agent-${i}`));
    expect(seen.size).toBeGreaterThan(10);
  });

  it('formats zero-padded keys and filenames', () => {
    expect(characterSheetKey(7)).toBe('char-07');
    expect(characterSheetFile(7)).toBe('Premade_Character_32x32_07.png');
    expect(characterSheetFile(20)).toBe('Premade_Character_32x32_20.png');
  });
});
