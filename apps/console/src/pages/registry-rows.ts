// registry-rows.ts — merges the three registry endpoints into the /tools row model.
// Extracted from RegistrySettings.tsx so the tree-building and unresolved-pin logic
// can be unit tested without rendering the page.

export type DerivedState = 'uninstalled' | 'installed' | 'enabled' | 'ghost';

export interface ManifestMetadata {
  name: string;
  description: string;
  version: string;
  actionRisk?: string | number;
  sensitivity?: string;
  capabilities?: string[];
  role?: string;
  modelTier?: string;
  // PR2 (#939): vault keys a skill declares in install.requires_secrets. Cross-referenced
  // against GET /api/vault/status to show configured/missing status and gate install/enable.
  requiresSecrets?: string[];
  /** Member tool names — skill bundles only. */
  tools?: string[];
  /** Agents whose pinned_skills reference this bundle — skill bundles only. */
  pinnedBy?: string[];
}

export interface RegistryEntry {
  name: string;
  kind: 'tool' | 'agent' | 'skill';
  state: DerivedState;
  metadata: ManifestMetadata | null;
  manifestError?: string;
  installedAt: string | null;
  installedBy: string | null;
  enabledAt: string | null;
  enabledBy: string | null;
}

export type RowKind = 'bundle' | 'tool';

/** One top-level row in the merged /tools view. A bundle carries its members
 *  (rendered read-only underneath); a standalone tool carries none. */
export interface Row {
  entry: RegistryEntry;
  rowKind: RowKind;
  members: RegistryEntry[];
  pinnedBy: string[];
  /** Enabled agents that pin this bundle while it is not enabled. Non-empty = broken:
   *  those agents boot with the bundle's tools missing from their function list. */
  unresolvedFor: string[];
}

/**
 * Build the merged row list: every bundle first (in the order returned), then any
 * tool not claimed by a bundle.
 *
 * A tool is "claimed" only when a bundle's on-disk manifest lists it. A ghost bundle
 * has no manifest, so its former members fall back to standalone rows rather than
 * disappearing from the page entirely.
 */
export function buildRows(
  skills: RegistryEntry[],
  tools: RegistryEntry[],
  agents: RegistryEntry[],
): Row[] {
  const toolByName = new Map(tools.map(t => [t.name, t]));
  const enabledAgents = new Set(agents.filter(a => a.state === 'enabled').map(a => a.name));
  const claimed = new Set<string>();

  const bundleRows: Row[] = skills.map(entry => {
    const memberNames = entry.metadata?.tools ?? [];
    const members: RegistryEntry[] = [];
    for (const name of memberNames) {
      const tool = toolByName.get(name);
      claimed.add(name);
      // A member declared in the manifest but missing from tool_registry discovery is
      // still worth showing — render it as uninstalled rather than dropping it.
      members.push(tool ?? {
        name, kind: 'tool', state: 'uninstalled', metadata: null,
        installedAt: null, installedBy: null, enabledAt: null, enabledBy: null,
      });
    }
    const pinnedBy = entry.metadata?.pinnedBy ?? [];
    return {
      entry,
      rowKind: 'bundle',
      members,
      pinnedBy,
      unresolvedFor: entry.state === 'enabled'
        ? []
        : pinnedBy.filter(a => enabledAgents.has(a)),
    };
  });

  const toolRows: Row[] = tools
    .filter(t => !claimed.has(t.name))
    .map(entry => ({ entry, rowKind: 'tool', members: [], pinnedBy: [], unresolvedFor: [] }));

  return [...bundleRows, ...toolRows];
}
