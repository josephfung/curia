import { describe, it, expect } from 'vitest';
import { getRecapEligibleSkillNames } from './recap-skills.js';

describe('getRecapEligibleSkillNames', () => {
  it('includes medium-risk calendar-respond-to-invite and excludes none-risk reads', () => {
    const names = getRecapEligibleSkillNames();
    expect(names.has('calendar-respond-to-invite')).toBe(true);
    expect(names.has('memory-query')).toBe(false);
    expect(names.has('activity-log')).toBe(false);
  });
});
