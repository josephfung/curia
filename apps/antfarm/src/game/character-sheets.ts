/** Deterministic 1-of-20 premade LimeZu character sheet per agent id.
 *
 * The staged asset master (curia-deploy custom/assets/antfarm) ships 20 ready-made
 * Modern Interiors character spritesheets. v1 picks one per agent deterministically
 * (generator-part compositing is deferred post-v1 — that layer library isn't staged).
 * Uses the SAME hash as the placeholder appearance map so a given agent's identity is
 * consistent whether real art or placeholders are rendered. */

import { hashAgentId } from './agent-appearance.js';

export const PREMADE_COUNT = 20;

/** 1-based index (matches the 1-based Premade_Character_32x32_NN.png filenames). */
export function characterSheetIndexForAgent(agentId: string): number {
  return (hashAgentId(agentId) % PREMADE_COUNT) + 1;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Phaser texture key for a sheet index. */
export function characterSheetKey(index: number): string {
  return `char-${pad2(index)}`;
}

/** Runtime PNG filename (under limezu/characters/) for a sheet index. */
export function characterSheetFile(index: number): string {
  return `Premade_Character_32x32_${pad2(index)}.png`;
}
