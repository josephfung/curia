import type { SceneDirective } from '@curia/shared-types';

export interface DeskSlot {
  agentId: string;
  row: 'boss' | 'floor';
  column: number;
}

export interface RegistryAgent {
  name: string;
  metadata?: { role?: string } | null;
}

/**
 * Ids that show up as delegation targets but are NOT agents — they're channels/rooms (e.g. the
 * "bullpen", a shared discussion space). These must never get a desk, label, or agent sprite: a
 * delegation "to the bullpen" is a conversation in a room, not a handoff to a person. A walk toward
 * one resolves to open floor instead (see deskPositionForAgent). Reserve the space, render nothing.
 */
export const NON_AGENT_TARGETS = new Set<string>(['bullpen']);

/** Extract agent ids referenced by directives (excluding non-agent rooms/channels). */
export function agentIdsFromDirectives(directives: SceneDirective[]): Set<string> {
  const ids = new Set<string>();
  for (const d of directives) {
    if ('agentId' in d && typeof d.agentId === 'string' && !NON_AGENT_TARGETS.has(d.agentId)) {
      ids.add(d.agentId);
    }
    if (d.kind === 'agent.walk' && 'targetAgentId' in d && !NON_AGENT_TARGETS.has(d.targetAgentId)) {
      ids.add(d.targetAgentId);
    }
  }
  return ids;
}

/**
 * Build desk layout: coordinator (or first boss-role agent) up front, others on the floor.
 * Union of registry agents and any ids seen in the loaded window/stream.
 */
export function buildDeskLayout(
  registryAgents: RegistryAgent[],
  directiveAgentIds: Iterable<string>,
): DeskSlot[] {
  const names = new Set<string>();
  for (const agent of registryAgents) names.add(agent.name);
  for (const id of directiveAgentIds) names.add(id);
  // Defensive: never mint a desk for a non-agent room/channel, whatever the caller passed.
  for (const id of NON_AGENT_TARGETS) names.delete(id);

  const coordinator = registryAgents.find((a) => a.metadata?.role === 'coordinator')?.name
    ?? [...names].find((n) => n === 'coordinator')
    ?? [...names][0]
    ?? 'coordinator';

  const floorAgents = [...names].filter((n) => n !== coordinator).sort();
  const slots: DeskSlot[] = [{ agentId: coordinator, row: 'boss', column: 0 }];

  floorAgents.forEach((agentId, index) => {
    slots.push({ agentId, row: 'floor', column: index });
  });

  return slots;
}

export function ensureAgentDesk(
  layout: DeskSlot[],
  agentId: string,
): DeskSlot[] {
  if (NON_AGENT_TARGETS.has(agentId)) return layout; // rooms/channels never get a desk
  if (layout.some((s) => s.agentId === agentId)) return layout;
  const floorCount = layout.filter((s) => s.row === 'floor').length;
  return [...layout, { agentId, row: 'floor', column: floorCount }];
}

/** Stable key for comparing desk rosters (agent ids + positions). */
export function deskLayoutKey(desks: DeskSlot[]): string {
  return desks
    .map((d) => `${d.agentId}:${d.row}:${d.column}`)
    .sort()
    .join('|');
}

/** Stable key for the union of registry + directive agent ids. */
export function agentRosterKey(
  registryAgents: RegistryAgent[],
  directiveAgentIds: Iterable<string>,
): string {
  const ids = new Set<string>();
  for (const agent of registryAgents) ids.add(agent.name);
  for (const id of directiveAgentIds) ids.add(id);
  return [...ids].sort().join('\0');
}
