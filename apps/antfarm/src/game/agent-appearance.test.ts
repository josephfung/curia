import { describe, it, expect } from 'vitest';
import { appearanceForAgent, appearanceKey } from './agent-appearance.js';

describe('appearanceForAgent', () => {
  it('returns stable appearance for the same agent id', () => {
    const a = appearanceForAgent('calendar-specialist');
    const b = appearanceForAgent('calendar-specialist');
    expect(appearanceKey(a)).toBe(appearanceKey(b));
  });

  it('usually differs across agent ids', () => {
    const a = appearanceForAgent('coordinator');
    const b = appearanceForAgent('ceo-inbox');
    expect(appearanceKey(a)).not.toBe(appearanceKey(b));
  });

  it('maps variant into 0–3', () => {
    const appearance = appearanceForAgent('research-analyst');
    expect(appearance.variant).toBeGreaterThanOrEqual(0);
    expect(appearance.variant).toBeLessThanOrEqual(3);
  });
});
