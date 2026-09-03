import { describe, it, expect } from 'vitest';
import { buildRows } from './registry-rows.js';
import type { RegistryEntry } from './registry-rows.js';

const entry = (name: string, over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  name, kind: 'tool', state: 'enabled', metadata: null,
  installedAt: null, installedBy: null, enabledAt: null, enabledBy: null, ...over,
});

const bundle = (name: string, tools: string[], pinnedBy: string[], state: RegistryEntry['state']) =>
  entry(name, {
    kind: 'skill', state,
    metadata: { name, description: 'd', version: '1.0.0', tools, pinnedBy },
  });

describe('buildRows', () => {
  it('nests member tools under their bundle and leaves standalone tools flat', () => {
    const rows = buildRows(
      [bundle('ceo-inbox', ['ceo-inbox-list'], [], 'enabled')],
      [entry('ceo-inbox-list'), entry('bullpen')],
      [],
    );

    expect(rows.map(r => r.entry.name)).toEqual(['ceo-inbox', 'bullpen']);
    expect(rows[0]!.rowKind).toBe('bundle');
    expect(rows[0]!.members.map(m => m.name)).toEqual(['ceo-inbox-list']);
    expect(rows[1]!.rowKind).toBe('tool');
    expect(rows[1]!.members).toEqual([]);
  });

  it('flags a non-enabled bundle pinned by an enabled agent', () => {
    const rows = buildRows(
      [bundle('ceo-inbox', ['ceo-inbox-list'], ['ceo-inbox'], 'installed')],
      [entry('ceo-inbox-list')],
      [entry('ceo-inbox', { kind: 'agent', state: 'enabled' })],
    );

    expect(rows[0]!.unresolvedFor).toEqual(['ceo-inbox']);
  });

  it('does not flag when the pinning agent is itself disabled', () => {
    const rows = buildRows(
      [bundle('learning', ['learn-x'], ['digest'], 'installed')],
      [entry('learn-x')],
      [entry('digest', { kind: 'agent', state: 'installed' })],
    );

    expect(rows[0]!.unresolvedFor).toEqual([]);
  });

  it('shows members for a bundle that is not installed', () => {
    const rows = buildRows(
      [bundle('ceo-inbox', ['ceo-inbox-list', 'ceo-inbox-read'], [], 'uninstalled')],
      [entry('ceo-inbox-list'), entry('ceo-inbox-read')],
      [],
    );

    expect(rows[0]!.members).toHaveLength(2);
  });

  it('keeps an orphaned member visible as a standalone row when its bundle has no manifest', () => {
    // Ghost bundle: DB row with no manifest, so metadata (and membership) is null.
    // The member must still appear somewhere — as a standalone row, not vanish.
    const rows = buildRows(
      [entry('ghost-bundle', { kind: 'skill', state: 'ghost', metadata: null })],
      [entry('orphan-tool')],
      [],
    );

    expect(rows.map(r => r.entry.name)).toEqual(['ghost-bundle', 'orphan-tool']);
  });
});
