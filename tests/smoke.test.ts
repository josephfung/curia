// Smoke test — ensures the test runner is wired correctly.
// Real tests will be added in subsequent tasks.
import { describe, it, expect } from 'vitest';

describe('project bootstrap', () => {
  it('test runner is operational', () => {
    expect(true).toBe(true);
  });
});
