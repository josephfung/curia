// tests/scenarios/reach.ts — tools the coordinator can reach mid-turn (#2050, #2059).
//
// Offered tools are the turn's starting list. skill-activate adds a skill's member
// tools; tool-registry adds standalone tools. Either way, a tool test mode cannot
// serve (a missing capability) is refused up front, so an unstubbed call counts as
// a stub hole instead of a missing-capability error production never shows.

export interface ReachInput {
  /** Tools the coordinator is offered at the start of the turn. */
  offered: ReadonlySet<string>;
  /** Tools already known to be unservable (offered tools with missing capabilities). */
  unavailable: ReadonlySet<string>;
  /** Member tools skill-activate would hand over, across every skill. */
  activated: readonly string[];
  /** Tools a tool-registry search would return. */
  discovered: readonly string[];
  missingCapabilities: (tool: string) => readonly string[];
}

export interface Reach {
  reachable: Set<string>;
  unavailable: Set<string>;
}

/**
 * Reachable tools, and the unservable subset of them. Activated and discovered
 * tools are considered only while the coordinator can call skill-activate or
 * tool-registry; a tool that loads them is not itself reachable through them.
 */
export function applyReach(input: ReachInput): Reach {
  const reachable = new Set(input.offered);
  const unavailable = new Set(input.unavailable);
  const callable = (tool: string): boolean => input.offered.has(tool) && !input.unavailable.has(tool);

  const consider = (names: readonly string[]): void => {
    for (const tool of names) {
      reachable.add(tool);
      if (input.missingCapabilities(tool).length > 0) unavailable.add(tool);
    }
  };

  if (callable('skill-activate')) consider(input.activated);
  if (callable('tool-registry')) consider(input.discovered);
  return { reachable, unavailable };
}
