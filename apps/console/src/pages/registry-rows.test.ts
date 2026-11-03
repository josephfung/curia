import { describe, it, expect } from 'vitest';
import { buildRows, collateralPins, drawerOptionalSecrets, drawerRequiredSecrets, formatCapabilities, registryPathSegment, uninstallBlockedReason } from './registry-rows.js';
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

describe('registryPathSegment', () => {
  // Regression guard for finding #1: the drawer's act() used to route on the *page's*
  // kind (`kindPath`) instead of the entry's own kind, so a bundle row (kind: 'skill')
  // rendered on the /tools page sent every action to /api/registry/tools/:name — which
  // 400s because no tool manifest exists under the bundle's name. Nothing exercised the
  // request URL before, so this pins the mapping directly.
  it('maps a bundle (skill) entry to the skills segment', () => {
    expect(registryPathSegment('skill')).toBe('skills');
  });

  it('maps a tool entry to the tools segment', () => {
    expect(registryPathSegment('tool')).toBe('tools');
  });

  it('maps an agent entry to the agents segment', () => {
    expect(registryPathSegment('agent')).toBe('agents');
  });
});

describe('buildRows', () => {
  it('nests member tools under their bundle and leaves standalone tools flat', () => {
    const rows = buildRows(
      [bundle('ceo-inbox', ['ceo-inbox-list'], [], 'enabled')],
      [entry('ceo-inbox-list'), entry('delegate')],
      [],
    );

    expect(rows.map(r => r.entry.name)).toEqual(['ceo-inbox', 'delegate']);
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

describe('collateralPins', () => {
  const row = {
    entry: bundle('ceo-inbox', ['ceo-inbox-search', 'ceo-inbox-list'], [], 'enabled'),
    rowKind: 'bundle' as const,
    members: [entry('ceo-inbox-search'), entry('ceo-inbox-list')],
    pinnedBy: [],
    unresolvedFor: [],
  };

  it('reports member tools pinned individually by other agents', () => {
    const agents = [
      entry('T2125-expense-tracker', {
        kind: 'agent', state: 'enabled',
        metadata: { name: 'T2125-expense-tracker', description: 'd', version: '1.0.0',
          pinnedTools: ['ceo-inbox-search'] },
      }),
    ];

    expect(collateralPins(row, agents)).toEqual([
      { tool: 'ceo-inbox-search', agents: ['T2125-expense-tracker'] },
    ]);
  });

  // Brief's original name implied this exercises "the bundle owner itself" too, but the
  // assertion below only ever covers the empty-agents case — renamed to match reality.
  it('returns nothing when no other agent pins a member', () => {
    expect(collateralPins(row, [])).toEqual([]);
  });
});

describe('uninstallBlockedReason', () => {
  it('blocks an enabled bundle and explains the member-tool consequence', () => {
    const reason = uninstallBlockedReason(
      bundle('ceo-inbox', ['ceo-inbox-list'], [], 'enabled'),
    );
    expect(reason).toMatch(/disable/i);
    expect(reason).toMatch(/member tool/i);
  });

  it('allows an installed-but-not-enabled bundle', () => {
    expect(
      uninstallBlockedReason(bundle('ceo-inbox', ['ceo-inbox-list'], [], 'installed')),
    ).toBeNull();
  });

  it('allows a ghost bundle — clearing the row is the only way to remove one', () => {
    // A ghost has a registry row but no manifest, so its members are unknowable and the
    // server permits the delete. The console must not be stricter than the server here,
    // or the row becomes unremovable from the UI.
    expect(
      uninstallBlockedReason(entry('dead-bundle', { kind: 'skill', state: 'ghost' })),
    ).toBeNull();
  });

  it('never blocks a plain tool or an agent, even when enabled', () => {
    expect(uninstallBlockedReason(entry('delegate', { state: 'enabled' }))).toBeNull();
    expect(
      uninstallBlockedReason(entry('coordinator', { kind: 'agent', state: 'enabled' })),
    ).toBeNull();
  });
});

describe('uninstallBlockedReason — must mirror the server, not exceed it', () => {
  it('allows an enabled bundle whose manifest failed to parse', () => {
    // metadata === null means the member list is unreadable. The server permits this delete
    // precisely because there is no cascade route: disable() also rejects it, so blocking
    // here too would leave the row with no console action at all. Note the derived state is
    // 'enabled' (not 'ghost') — the directory IS on disk, its SKILL.md just doesn't parse —
    // which is why keying only on state was wrong.
    expect(
      uninstallBlockedReason(
        entry('broken-bundle', { kind: 'skill', state: 'enabled', metadata: null }),
      ),
    ).toBeNull();
  });

  it('still blocks an enabled bundle whose members are readable', () => {
    expect(
      uninstallBlockedReason(bundle('ceo-inbox', ['ceo-inbox-list'], [], 'enabled')),
    ).not.toBeNull();
  });
});

describe('formatCapabilities (#2028)', () => {
  it('labels skill-activate taskRepo as optional beside its required capability', () => {
    expect(formatCapabilities(['skillRegistry'], ['taskRepo']))
      .toBe('skillRegistry · Optional: taskRepo');
  });

  it('renders a tool with no optional capabilities as it does today', () => {
    expect(formatCapabilities(['skillRegistry'], undefined)).toBe('skillRegistry');
    expect(formatCapabilities(['skillRegistry'], [])).toBe('skillRegistry');
    expect(formatCapabilities(['bus', 'agentRegistry'], undefined)).toBe('bus, agentRegistry');
    expect(formatCapabilities([], undefined)).toBe('—');
    expect(formatCapabilities(undefined, undefined)).toBeNull();
  });

  it('shows an optional-only list without a required prefix', () => {
    expect(formatCapabilities(undefined, ['taskRepo'])).toBe('Optional: taskRepo');
    expect(formatCapabilities([], ['taskRepo', 'verification'])).toBe('Optional: taskRepo, verification');
  });
});

describe('drawerOptionalSecrets', () => {
  // #2445: bundle member rows are read-only, so web-search's optional tavily_api_key was
  // reachable nowhere on /tools until the bundle drawer listed its members' keys.
  const tool = (name: string, optionalSecrets: { name: string; purpose: string }[]) =>
    entry(name, { metadata: { name, description: 'd', version: '1.0.0', optionalSecrets } });

  it('returns a tool its own optional secrets', () => {
    const t = tool('web-search', [{ name: 'tavily_api_key', purpose: 'raises limits' }]);
    expect(drawerOptionalSecrets(t, undefined)).toEqual([{ name: 'tavily_api_key', purpose: 'raises limits' }]);
  });

  it("returns a bundle its members' optional secrets, first declaration winning", () => {
    const rows = buildRows(
      [bundle('web', ['web-search', 'web-fetch', 'web-browser'], [], 'enabled')],
      [
        tool('web-search', [{ name: 'tavily_api_key', purpose: 'raises limits' }]),
        tool('web-fetch', [{ name: 'tavily_api_key', purpose: 'other' }]),
        entry('web-browser'),
      ],
      [],
    );
    const row = rows[0]!;
    expect(drawerOptionalSecrets(row.entry, row)).toEqual([{ name: 'tavily_api_key', purpose: 'raises limits' }]);
  });

  it('leaves out a key another member requires, since it still gates the bundle', () => {
    const rows = buildRows(
      [bundle('web', ['web-search', 'web-fetch'], [], 'enabled')],
      [
        tool('web-search', [{ name: 'shared', purpose: 'p' }, { name: 'extra', purpose: 'q' }]),
        entry('web-fetch', { metadata: { name: 'web-fetch', description: 'd', version: '1.0.0', requiresSecrets: ['shared'] } }),
      ],
      [],
    );
    const row = rows[0]!;
    expect(drawerOptionalSecrets(row.entry, row)).toEqual([{ name: 'extra', purpose: 'q' }]);
    // It moves to the required list rather than vanishing.
    expect(drawerRequiredSecrets(row.entry, row)).toEqual(['shared']);
  });

  it('returns nothing for an agent or a bundle without its row', () => {
    expect(drawerOptionalSecrets(entry('coordinator', { kind: 'agent' }), undefined)).toEqual([]);
    expect(drawerOptionalSecrets(bundle('web', ['web-search'], [], 'enabled'), undefined)).toEqual([]);
  });
});

describe('drawerRequiredSecrets', () => {
  // Mirrors RegistryService.assertBundleSecretsConfigured: a bundle's install/enable is
  // refused until every member's required key is set, so the drawer must show those keys.
  const requiring = (name: string, requiresSecrets: string[]) =>
    entry(name, { metadata: { name, description: 'd', version: '1.0.0', requiresSecrets } });

  it('returns a tool its own required secrets', () => {
    expect(drawerRequiredSecrets(requiring('signal-send', ['signal_key']), undefined)).toEqual(['signal_key']);
  });

  it("returns a bundle the deduplicated union of its members' required secrets", () => {
    const rows = buildRows(
      [bundle('b', ['t1', 't2', 't3'], [], 'installed')],
      [requiring('t1', ['k1', 'k2']), requiring('t2', ['k2']), entry('t3')],
      [],
    );
    const row = rows[0]!;
    expect(drawerRequiredSecrets(row.entry, row)).toEqual(['k1', 'k2']);
  });

  it('returns nothing for an agent or a bundle without its row', () => {
    expect(drawerRequiredSecrets(entry('coordinator', { kind: 'agent' }), undefined)).toEqual([]);
    expect(drawerRequiredSecrets(bundle('b', ['t1'], [], 'installed'), undefined)).toEqual([]);
  });
});
