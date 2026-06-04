// render.test.ts — unit + snapshot tests for the pure digest renderer.
import { describe, it, expect } from 'vitest';
import { humanizeAge } from './render.js';

// Fixed clock for deterministic spans. 2026-06-03T12:00:00.000Z.
const NOW_MS = Date.parse('2026-06-03T12:00:00.000Z');

describe('humanizeAge', () => {
  it('renders <1h for spans under an hour', () => {
    expect(humanizeAge('2026-06-03T11:30:00.000Z', NOW_MS)).toBe('<1h');
  });

  it('renders hours under a day', () => {
    expect(humanizeAge('2026-06-03T07:00:00.000Z', NOW_MS)).toBe('5h');
  });

  it('renders days under two weeks', () => {
    expect(humanizeAge('2026-05-31T12:00:00.000Z', NOW_MS)).toBe('3d');
  });

  it('renders weeks at and beyond 14 days', () => {
    expect(humanizeAge('2026-05-20T12:00:00.000Z', NOW_MS)).toBe('2w');
  });

  it('clamps future/zero spans to <1h', () => {
    expect(humanizeAge('2026-06-03T13:00:00.000Z', NOW_MS)).toBe('<1h');
  });
});
