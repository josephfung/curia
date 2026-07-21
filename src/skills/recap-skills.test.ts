import { describe, it, expect } from 'vitest';
import { getRecapEligibleToolNames } from './recap-skills.js';

describe('getRecapEligibleToolNames', () => {
  it('includes medium-risk calendar-respond-to-invite and excludes none-risk reads', () => {
    const names = getRecapEligibleToolNames();
    expect(names.has('calendar-respond-to-invite')).toBe(true);
    expect(names.has('memory-query')).toBe(false);
    expect(names.has('activity-log')).toBe(false);
  });
});
