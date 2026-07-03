/** Deterministic LimeZu-style character parts from agent id (stable across sessions). */

export interface AgentAppearance {
  skinTone: number;
  hairColor: number;
  outfitColor: number;
  accessoryColor: number;
  /** Frame offset within the character sheet (0–3). */
  variant: number;
}

export function hashAgentId(agentId: string): number {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = (hash * 31 + agentId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

const SKIN_TONES = [0xf5d0a9, 0xe8b88a, 0xc68642, 0x8d5524, 0xffdbac];
const HAIR_COLORS = [0x2c1810, 0x5a3825, 0x8b6914, 0xc0c0c0, 0xd4574a, 0x1a1a2e];
const OUTFIT_COLORS = [0x3d5a80, 0x6b9080, 0xa4c3b2, 0xe07a5f, 0x81b29a, 0x457b9d, 0xf4a261];
const ACCESSORY_COLORS = [0xffd166, 0xef476f, 0x06d6a0, 0x118ab2, 0x8338ec];

export function appearanceForAgent(agentId: string): AgentAppearance {
  const h = hashAgentId(agentId);
  return {
    skinTone: SKIN_TONES[h % SKIN_TONES.length]!,
    hairColor: HAIR_COLORS[(h >> 3) % HAIR_COLORS.length]!,
    outfitColor: OUTFIT_COLORS[(h >> 6) % OUTFIT_COLORS.length]!,
    accessoryColor: ACCESSORY_COLORS[(h >> 9) % ACCESSORY_COLORS.length]!,
    variant: h % 4,
  };
}

/** Two agents with different ids should usually differ in at least one part. */
export function appearanceKey(appearance: AgentAppearance): string {
  return `${appearance.skinTone}-${appearance.hairColor}-${appearance.outfitColor}-${appearance.accessoryColor}-${appearance.variant}`;
}
