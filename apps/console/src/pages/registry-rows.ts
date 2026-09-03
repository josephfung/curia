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
  /** Raw pinned_skills for an agent — a mix of bundle names and first-class tool pins
   *  (ADR-032). Distinct from `tools`, which means bundle membership on a skill. Used
   *  by collateralPins to warn before a bundle disable strips a directly-pinned tool.
   *  Agents only. */
  pinnedTools?: string[];
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
 * Map an entry's own `kind` to its URL path segment under /api/registry/.
 *
 * Routing must key off the entry's own kind, not the page it happens to render on — a
 * bundle row (`kind: 'skill'`) shown on the /tools page still lives at
 * /api/registry/skills/:name, not /api/registry/tools/:name. Getting this wrong sent
 * every bundle enable/disable/install from the console to the tools endpoint, which
 * 400s because no *tool* manifest exists under the bundle's name (finding #1).
 */
export function registryPathSegment(kind: RegistryEntry['kind']): 'skills' | 'tools' | 'agents' {
  if (kind === 'skill') return 'skills';
  if (kind === 'agent') return 'agents';
  return 'tools';
}

/**
 * Why uninstall is refused for this entry, or null when it is allowed.
 *
 * Mirrors the server guard in RegistryService.uninstall: an ENABLED bundle cannot be
 * uninstalled, because deleting the skill_registry row leaves every member tool_registry
 * row enabled — and runtime tool availability reads tool_registry alone, so those tools
 * stay loaded and callable with no bundle owning them. Disable first; that cascades.
 *
 * Deliberately NOT stricter than the server. A bundle whose manifest is missing derives
 * state 'ghost', not 'enabled', and the server permits that delete precisely because
 * clearing a ghost row is the only way to remove one — blocking it here would leave the
 * row with no console action at all. Plain tools and agents are never blocked.
 *
 * Returned string is shown as the button's tooltip, so it must say what to do instead.
 */
export function uninstallBlockedReason(entry: RegistryEntry): string | null {
  if (entry.kind !== 'skill' || entry.state !== 'enabled') return null;
  // Mirror the server's second condition too: it only refuses when the member list is
  // READABLE, i.e. when "disable first" is advice that actually works. A bundle whose
  // SKILL.md fails to parse has metadata === null and derives state 'enabled' (the
  // directory is on disk, so it is not a ghost) — and disable() rejects it for the same
  // unreadable-member-list reason. Blocking uninstall here as well would leave that row
  // with no console action at all, which is the dead end this guard exists to avoid.
  if (entry.metadata?.tools == null) return null;
  return 'Disable this bundle first — uninstalling it now would leave its member tools '
    + 'enabled and callable with no bundle owning them.';
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

/**
 * Member tools of `row` that some agent pins directly, by tool name.
 *
 * Disabling a bundle cascades to its members, which would strip those tools from an
 * agent that never asked for the bundle at all. The operator sees this list before
 * confirming. Only enabled agents count — a disabled agent loses nothing.
 */
export function collateralPins(
  row: Row,
  agents: RegistryEntry[],
): Array<{ tool: string; agents: string[] }> {
  const memberNames = new Set(row.members.map(m => m.name));
  const byTool = new Map<string, string[]>();

  for (const agent of agents) {
    if (agent.state !== 'enabled') continue;
    for (const pin of agent.metadata?.pinnedTools ?? []) {
      if (!memberNames.has(pin)) continue;
      const list = byTool.get(pin);
      if (list) list.push(agent.name);
      else byTool.set(pin, [agent.name]);
    }
  }

  return [...byTool.entries()].map(([tool, names]) => ({ tool, agents: names }));
}
