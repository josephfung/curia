import { describe, it, expect } from 'vitest';
import { DECOR_PROPS, DECOR_SINGLES, decorTextureKey } from './decor.js';
import { STAGE_WIDTH, STAGE_HEIGHT } from './world-layout.js';

describe('decor manifest', () => {
  it('has unique prop ids', () => {
    const ids = DECOR_PROPS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('places every prop within the stage bounds', () => {
    for (const p of DECOR_PROPS) {
      expect(p.x, `${p.id} x`).toBeGreaterThanOrEqual(0);
      expect(p.x, `${p.id} x`).toBeLessThanOrEqual(STAGE_WIDTH);
      expect(p.y, `${p.id} y`).toBeGreaterThanOrEqual(0);
      expect(p.y, `${p.id} y`).toBeLessThanOrEqual(STAGE_HEIGHT);
    }
  });

  it('crop sources carry a full region and a source sheet', () => {
    for (const p of DECOR_PROPS) {
      if (p.source.kind !== 'crop') continue;
      expect(p.source.from, `${p.id} from`).toBeTruthy();
      expect(p.source.sw, `${p.id} sw`).toBeGreaterThan(0);
      expect(p.source.sh, `${p.id} sh`).toBeGreaterThan(0);
    }
  });

  it('DECOR_SINGLES is the deduped set of single-sourced prop numbers', () => {
    const expected = new Set(
      DECOR_PROPS.flatMap((p) => (p.source.kind === 'single' ? [p.source.single] : [])),
    );
    expect(new Set(DECOR_SINGLES)).toEqual(expected);
    expect(DECOR_SINGLES.length).toBe(expected.size); // no duplicates
  });

  it('derives a namespaced texture key per prop', () => {
    expect(decorTextureKey('bookcase')).toBe('decor-bookcase');
  });
});
