import { describe, it, expect } from 'vitest';
import { emptyFilter, filterOptions, isFilterActive, matchesFilter, normalizeSensitivity, toggleFilterValue } from './kg-filters.js';
import type { KgFilter } from './kg-filters.js';

const filter = (types: string[], sensitivities: string[]): KgFilter => ({
  types: new Set(types),
  sensitivities: new Set(sensitivities),
});

describe('matchesFilter', () => {
  it('matches everything when no filter is active', () => {
    expect(matchesFilter({ type: 'person', sensitivity: 'restricted' }, emptyFilter())).toBe(true);
  });

  it('ORs values within an axis', () => {
    const f = filter(['person', 'organization'], []);
    expect(matchesFilter({ type: 'person', sensitivity: 'public' }, f)).toBe(true);
    expect(matchesFilter({ type: 'organization', sensitivity: 'public' }, f)).toBe(true);
    expect(matchesFilter({ type: 'project', sensitivity: 'public' }, f)).toBe(false);
  });

  it('ANDs across axes', () => {
    // The issue's worked example: Person OR Organization, AND internal OR confidential.
    const f = filter(['person', 'organization'], ['internal', 'confidential']);
    expect(matchesFilter({ type: 'person', sensitivity: 'internal' }, f)).toBe(true);
    expect(matchesFilter({ type: 'organization', sensitivity: 'confidential' }, f)).toBe(true);
    expect(matchesFilter({ type: 'person', sensitivity: 'restricted' }, f)).toBe(false);
    expect(matchesFilter({ type: 'project', sensitivity: 'internal' }, f)).toBe(false);
  });

  it('leaves an axis unconstrained when nothing is selected on it', () => {
    const f = filter([], ['restricted']);
    expect(matchesFilter({ type: 'fact', sensitivity: 'restricted' }, f)).toBe(true);
    expect(matchesFilter({ type: 'fact', sensitivity: 'public' }, f)).toBe(false);
  });
});

describe('toggleFilterValue', () => {
  it('adds then removes a value without mutating the input', () => {
    const start = emptyFilter();
    const on = toggleFilterValue(start, 'types', 'person');
    expect(on.types.has('person')).toBe(true);
    expect(start.types.size).toBe(0);
    const off = toggleFilterValue(on, 'types', 'person');
    expect(off.types.size).toBe(0);
    expect(on.types.has('person')).toBe(true);
  });

  it('touches only the named axis', () => {
    const f = toggleFilterValue(filter(['person'], []), 'sensitivities', 'public');
    expect([...f.types]).toEqual(['person']);
    expect([...f.sensitivities]).toEqual(['public']);
  });
});

describe('isFilterActive', () => {
  it('is false for the empty filter and true once either axis has a value', () => {
    expect(isFilterActive(emptyFilter())).toBe(false);
    expect(isFilterActive(filter(['person'], []))).toBe(true);
    expect(isFilterActive(filter([], ['public']))).toBe(true);
  });
});

describe('filterOptions', () => {
  const nodes = [
    { type: 'person', sensitivity: 'internal' },
    { type: 'person', sensitivity: 'restricted' },
    { type: 'fact', sensitivity: 'internal' },
  ];

  it('lists types present on the canvas alphabetically with counts', () => {
    expect(filterOptions(nodes, emptyFilter()).types).toEqual([
      { value: 'fact', count: 1 },
      { value: 'person', count: 2 },
    ]);
  });

  it('always lists the four sensitivity levels in canonical order', () => {
    expect(filterOptions(nodes, emptyFilter()).sensitivities).toEqual([
      { value: 'public', count: 0 },
      { value: 'internal', count: 2 },
      { value: 'confidential', count: 0 },
      { value: 'restricted', count: 1 },
    ]);
  });

  it('keeps selected values listed when no loaded node carries them', () => {
    const opts = filterOptions(nodes, filter(['project'], ['secret']));
    expect(opts.types).toContainEqual({ value: 'project', count: 0 });
    expect(opts.sensitivities.at(-1)).toEqual({ value: 'secret', count: 0 });
  });
});

describe('normalizeSensitivity', () => {
  it('maps an empty or missing sensitivity to internal, matching the canvas elements', () => {
    expect(normalizeSensitivity('')).toBe('internal');
    expect(normalizeSensitivity(null)).toBe('internal');
    expect(normalizeSensitivity(undefined)).toBe('internal');
    expect(normalizeSensitivity('restricted')).toBe('restricted');
  });

  it('lets an empty-sensitivity node pass an internal filter', () => {
    const f = { types: new Set<string>(), sensitivities: new Set(['internal']) };
    expect(matchesFilter({ type: 'person', sensitivity: normalizeSensitivity('') }, f)).toBe(true);
  });
});
