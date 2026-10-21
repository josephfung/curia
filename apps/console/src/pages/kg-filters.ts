// Client-side filter state for the KG explorer (#351). Pure helpers so the
// filter semantics can be unit-tested without Cytoscape or React.
//
// Semantics: values are OR'd within an axis and the axes are AND'd together.
// An axis with nothing selected places no constraint on that axis, so the
// empty filter shows everything.

export type KgFilterAxis = 'types' | 'sensitivities';

export interface KgFilter {
  types: ReadonlySet<string>;
  sensitivities: ReadonlySet<string>;
}

export interface KgFilterable {
  type: string;
  sensitivity: string;
}

export interface KgFilterOption {
  value: string;
  count: number;
}

// Canonical order for sensitivity levels, least to most sensitive.
export const SENSITIVITY_LEVELS = ['public', 'internal', 'confidential', 'restricted'] as const;

// The API can return an empty sensitivity; the explorer treats that as
// `internal`. Canvas elements and sidebar results must normalise the same way
// or the two can disagree about whether a node passes the filter.
export const DEFAULT_SENSITIVITY = 'internal';

export function normalizeSensitivity(sensitivity: string | null | undefined): string {
  return sensitivity || DEFAULT_SENSITIVITY;
}

export function emptyFilter(): KgFilter {
  return { types: new Set(), sensitivities: new Set() };
}

export function isFilterActive(filter: KgFilter): boolean {
  return filter.types.size > 0 || filter.sensitivities.size > 0;
}

export function matchesFilter(node: KgFilterable, filter: KgFilter): boolean {
  if (filter.types.size > 0 && !filter.types.has(node.type)) return false;
  if (filter.sensitivities.size > 0 && !filter.sensitivities.has(node.sensitivity)) return false;
  return true;
}

/** Returns a new filter with `value` toggled on `axis`; the input is not mutated. */
export function toggleFilterValue(filter: KgFilter, axis: KgFilterAxis, value: string): KgFilter {
  const next = new Set(filter[axis]);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return { ...filter, [axis]: next };
}

/**
 * Builds the checklist options for each axis from the nodes currently on the
 * canvas. Selected values stay listed (with count 0) even when no loaded node
 * carries them, so an active filter can always be unchecked. All four
 * sensitivity levels are always listed, in canonical order, followed by any
 * unexpected values; types are listed alphabetically.
 */
export function filterOptions(
  nodes: readonly KgFilterable[],
  filter: KgFilter,
): { types: KgFilterOption[]; sensitivities: KgFilterOption[] } {
  const typeCounts = new Map<string, number>();
  const sensCounts = new Map<string, number>(SENSITIVITY_LEVELS.map(s => [s, 0]));
  for (const n of nodes) {
    typeCounts.set(n.type, (typeCounts.get(n.type) ?? 0) + 1);
    sensCounts.set(n.sensitivity, (sensCounts.get(n.sensitivity) ?? 0) + 1);
  }
  for (const t of filter.types) if (!typeCounts.has(t)) typeCounts.set(t, 0);
  for (const s of filter.sensitivities) if (!sensCounts.has(s)) sensCounts.set(s, 0);

  const canonical = new Set<string>(SENSITIVITY_LEVELS);
  const extraSens = [...sensCounts.keys()].filter(s => !canonical.has(s)).sort();

  return {
    types: [...typeCounts.keys()].sort().map(value => ({ value, count: typeCounts.get(value)! })),
    sensitivities: [...SENSITIVITY_LEVELS, ...extraSens].map(value => ({ value, count: sensCounts.get(value)! })),
  };
}
