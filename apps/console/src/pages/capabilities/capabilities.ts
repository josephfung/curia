// Capabilities (#2358 section 4): plain-language switches over the registry. A capability
// is a group of agents, skill bundles and standalone tools that are switched together, so a
// pinned bundle is never left off under an enabled agent. The list lives here, not in the
// page. Pure: no React, no fetch.
import type { RegistryEntry } from '../registry-rows.js';

export type CapabilityId = 'meetings' | 'debriefs' | 'research' | 'tasks' | 'diagnostics' | 'triage';

export interface Capability {
  id: CapabilityId;
  label: string;
  /** What it does for the principal; `p` is how the page names them. */
  description: (p: string) => string;
  agents: readonly string[];
  bundles: readonly string[];
  /** Standalone tools (in no bundle). */
  tools: readonly string[];
  /**
   * Always on: the onboarding sessions run on it, so it has no switch anywhere.
   * Off in Setup: the principal turns it on during onboarding, so the Setup page shows it
   * off and locked; Settings can switch it.
   */
  lock?: 'always-on' | 'principal-in-onboarding';
}

export const CAPABILITIES: readonly Capability[] = [
  {
    id: 'meetings', label: 'Meetings', lock: 'always-on',
    description: (p) => `Agendas before a meeting, notes during it, minutes after. ${p}’s onboarding sessions run on this.`,
    agents: [], bundles: ['meetings'], tools: ['meeting-notes-start', 'meeting-agenda-load'],
  },
  {
    id: 'debriefs', label: 'Meeting debriefs',
    description: (p) => `After a meeting, Curia asks ${p} a few quick questions and files the follow-ups.`,
    agents: ['meeting-debrief'], bundles: [], tools: [],
  },
  {
    id: 'research', label: 'Web research',
    description: () => 'Searches and reads the web, and hands bigger questions to a research analyst who writes up the findings.',
    agents: ['research-analyst'], bundles: ['web'], tools: [],
  },
  {
    id: 'tasks', label: 'Projects and tasks',
    description: (p) => `Keeps track of work ${p} hands off, and follows up until it’s done.`,
    agents: [], bundles: ['tasks'], tools: [],
  },
  {
    id: 'diagnostics', label: 'Diagnostics',
    description: (p) => `${p} can ask Curia why something didn’t work, and get a plain answer. Reads Curia’s own audit log.`,
    agents: ['diagnostics'], bundles: ['diagnostics'], tools: [],
  },
  {
    id: 'triage', label: 'Email triage', lock: 'principal-in-onboarding',
    description: (p) => `Sorts and labels ${p}’s inbox, and archives what doesn’t need attention.`,
    agents: ['ceo-inbox'], bundles: ['ceo-inbox', 'learning'], tools: [],
  },
];

export interface RegistryLists {
  agents: readonly RegistryEntry[];
  skills: readonly RegistryEntry[];
  tools: readonly RegistryEntry[];
}

/** One registry entry a capability covers, as the routes name it. */
export interface Member {
  kind: 'agents' | 'skills' | 'tools';
  name: string;
}

export function members(cap: Capability): Member[] {
  return [
    ...cap.bundles.map((name) => ({ kind: 'skills' as const, name })),
    ...cap.tools.map((name) => ({ kind: 'tools' as const, name })),
    ...cap.agents.map((name) => ({ kind: 'agents' as const, name })),
  ];
}

function find(lists: RegistryLists, m: Member): RegistryEntry | undefined {
  return lists[m.kind].find((e) => e.name === m.name);
}

export type CapabilityState =
  | { kind: 'on' }
  | { kind: 'off' }
  /** Some members on, some off: switching sets them all one way. */
  | { kind: 'partly'; off: string[] }
  /** A member this server doesn't have (not on disk, or its manifest is broken). */
  | { kind: 'unavailable'; missing: string[] };

export function capabilityState(cap: Capability, lists: RegistryLists): CapabilityState {
  const all = members(cap);
  const missing = all.filter((m) => {
    const e = find(lists, m);
    return !e || e.state === 'ghost' || e.manifestError !== undefined;
  }).map((m) => m.name);
  if (missing.length > 0) return { kind: 'unavailable', missing };
  const off = all.filter((m) => find(lists, m)!.state !== 'enabled').map((m) => m.name);
  if (off.length === 0) return { kind: 'on' };
  if (off.length === all.length) return { kind: 'off' };
  return { kind: 'partly', off };
}

/**
 * The registry calls that switch a capability, in order. On: bundles and tools first, then
 * agents, so an agent is never enabled over a missing pin. Off: agents first, then what they
 * pin. A member already in the wanted state is skipped; one never installed has nothing to
 * disable.
 */
export function switchPlan(cap: Capability, on: boolean, lists: RegistryLists): Array<Member & { action: 'install-enable' | 'disable' }> {
  const ordered = on ? members(cap) : [...members(cap)].reverse();
  const plan: Array<Member & { action: 'install-enable' | 'disable' }> = [];
  for (const m of ordered) {
    const state = find(lists, m)?.state;
    if (on && state !== 'enabled') plan.push({ ...m, action: 'install-enable' });
    if (!on && state === 'enabled') plan.push({ ...m, action: 'disable' });
  }
  return plan;
}

/**
 * Enabled agents outside the capability that pin one of its bundles, or one of its bundles'
 * tools directly: turning it off takes those tools away from them too. Names the agent and
 * what it would lose, for the warning before turning off.
 */
export function outsidePins(cap: Capability, lists: RegistryLists): Array<{ agent: string; loses: string }> {
  const own = new Set(cap.agents);
  const out: Array<{ agent: string; loses: string }> = [];
  for (const agent of lists.agents) {
    if (own.has(agent.name) || agent.state !== 'enabled') continue;
    const pins = new Set(agent.metadata?.pinnedTools ?? []);
    for (const bundle of cap.bundles) {
      const memberTools = lists.skills.find((s) => s.name === bundle)?.metadata?.tools ?? [];
      if (pins.has(bundle)) out.push({ agent: agent.name, loses: bundle });
      else {
        const direct = memberTools.filter((t) => pins.has(t));
        if (direct.length > 0) out.push({ agent: agent.name, loses: direct.join(', ') });
      }
    }
    for (const tool of cap.tools) if (pins.has(tool)) out.push({ agent: agent.name, loses: tool });
  }
  return out;
}

/** The confirm text before turning a capability off, or null when nothing else is affected. */
export function offWarning(cap: Capability, lists: RegistryLists): string | null {
  const pins = outsidePins(cap, lists);
  if (pins.length === 0) return null;
  const lines = pins.map((p) => `• ${p.agent} also uses ${p.loses}`);
  return `Turning off ${cap.label} also takes these away from other parts of Curia:\n${lines.join('\n')}\n\nTurn it off anyway?`;
}
