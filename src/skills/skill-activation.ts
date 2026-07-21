// skill-activation.ts — Phase 3a (#1495) unified discovery + activation helpers.
//
// Design §6 (docs/wip/2026-07-16-tools-skills-architecture-design.md):
//   Tier 0 — pinned (eager at bootstrap; unchanged)
//   Tier 1 — task-active (durable progress.activeSkills; re-loaded on wake)
//   Tier 2 — discovery (toolSearch kind:'skill' when allow_discovery)
//
// Activation never widens authority: member tools still pass allowed_callers /
// action_risk at invoke time; we only surface tools the agent may already call.

import type { SkillRegistry } from './skill-registry.js';
import type { ToolRegistry } from './registry.js';
import type { RegisteredSkill } from './skill-types.js';
import {
  ACTIVE_SKILLS_CAP,
  readActiveSkillsBlock,
  type ActiveSkillEntry,
} from '../db/active-skills-progress.js';
import { appendSkillInstructions } from './pin-resolution.js';

export const SKILL_ACTIVATE_TOOL_NAME = 'skill-activate';
export const SKILL_ACTIVATION_PROTOCOL = 'skill_activation' as const;

export interface DiscoveryHit {
  name: string;
  description: string;
  kind: 'tool' | 'skill';
}

export interface SkillActivationResult {
  skill: string;
  /** Member tools the calling agent is allowed to invoke (allowed_callers). */
  tools: string[];
  /** Member tools skipped because allowed_callers excludes the agent. */
  skippedTools: string[];
  /** SKILL.md body (may be empty for instruction-light bundles). */
  instructions: string;
}

export interface SkillActivationFailure {
  error: string;
}

/**
 * Unified discovery: non-synthetic skills as kind:'skill', orphan/synthetic-owned
 * tools as kind:'tool'. Matching a member atom promotes its owning skill instead
 * of returning the atom (closes the Phase 2 gap where task-create could be
 * invoked without the tasks discipline block).
 */
export function unifiedToolSearch(options: {
  query: string;
  toolRegistry: ToolRegistry;
  skillRegistry: SkillRegistry;
  agentId: string;
  /** Tool names excluded from results (e.g. tool-registry, skill-activate). */
  excludeToolNames?: ReadonlySet<string>;
}): DiscoveryHit[] {
  const {
    query,
    toolRegistry,
    skillRegistry,
    agentId,
    excludeToolNames = new Set(['tool-registry', SKILL_ACTIVATE_TOOL_NAME]),
  } = options;

  const results: DiscoveryHit[] = [];
  const seenSkills = new Set<string>();
  const seenTools = new Set<string>();

  const pushSkill = (skill: RegisteredSkill) => {
    if (skill.synthetic) return;
    if (seenSkills.has(skill.manifest.name)) return;
    seenSkills.add(skill.manifest.name);
    results.push({
      name: skill.manifest.name,
      description: skill.manifest.description,
      kind: 'skill',
    });
  };

  for (const skill of skillRegistry.search(query)) {
    pushSkill(skill);
  }

  for (const tool of toolRegistry.search(query)) {
    const name = tool.manifest.name;
    if (excludeToolNames.has(name)) continue;

    const allowed = tool.manifest.allowed_callers;
    if (allowed && allowed.length > 0 && !allowed.includes(agentId)) continue;

    const owner = skillRegistry.toolOwner(name);
    if (owner && !owner.synthetic) {
      // Prefer the bundle — activation loads tools + instructions together.
      pushSkill(owner);
      continue;
    }

    if (seenTools.has(name)) continue;
    seenTools.add(name);
    results.push({
      name,
      description: tool.manifest.description,
      kind: 'tool',
    });
  }

  return results;
}

/** Whether the agent may call this tool given allowed_callers. */
export function agentMayCallTool(
  toolRegistry: ToolRegistry,
  toolName: string,
  agentId: string,
): boolean {
  const entry = toolRegistry.get(toolName);
  if (!entry) return false;
  const allowed = entry.manifest.allowed_callers;
  if (!allowed || allowed.length === 0) return true;
  return allowed.includes(agentId);
}

/**
 * Resolve activation of a skill for an agent. Does not mutate registries.
 * Synthetic skills cannot be activated (they are pin-resolution shims only).
 */
export function resolveSkillActivation(options: {
  skillName: string;
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
  agentId: string;
}): SkillActivationResult | SkillActivationFailure {
  const { skillName, skillRegistry, toolRegistry, agentId } = options;
  const name = skillName.trim();
  if (!name) return { error: 'skill name is required' };

  const skill = skillRegistry.get(name);
  if (!skill) return { error: `Unknown skill: ${name}` };
  if (skill.synthetic) {
    return { error: `Cannot activate synthetic skill '${name}' — pin or discover a real bundle` };
  }

  const tools: string[] = [];
  const skippedTools: string[] = [];
  for (const toolName of skill.manifest.tools) {
    if (!toolRegistry.get(toolName)) {
      skippedTools.push(toolName);
      continue;
    }
    if (agentMayCallTool(toolRegistry, toolName, agentId)) {
      tools.push(toolName);
    } else {
      skippedTools.push(toolName);
    }
  }

  return {
    skill: skill.manifest.name,
    tools,
    skippedTools,
    instructions: skill.manifest.instructions.trim(),
  };
}

/**
 * On wake: treat stored active skills as a strong prior, re-check relevance
 * against the current step text, and cap the set. Pinned skills are excluded
 * (already eager in the bootstrap prompt).
 */
export function selectActiveSkillsForWake(options: {
  progress: Record<string, unknown> | undefined | null;
  pinnedSkillNames: ReadonlySet<string> | readonly string[];
  skillRegistry: SkillRegistry;
  relevanceText: string;
  cap?: number;
}): string[] {
  const cap = options.cap ?? ACTIVE_SKILLS_CAP;
  const pinned = options.pinnedSkillNames instanceof Set
    ? options.pinnedSkillNames
    : new Set(options.pinnedSkillNames);

  const stored = readActiveSkillsBlock(options.progress)?.skills ?? [];
  if (stored.length === 0) return [];

  const relevance = options.relevanceText.toLowerCase();
  const scored: Array<{ name: string; relevant: boolean; activatedAt: string }> = [];

  for (const entry of stored) {
    if (pinned.has(entry.name)) continue;
    const skill = options.skillRegistry.get(entry.name);
    if (!skill || skill.synthetic) continue;

    const haystack = [
      skill.manifest.name,
      skill.manifest.description,
      ...skill.manifest.tools,
    ].join(' ').toLowerCase();
    const relevant = relevance.length === 0
      || haystack.split(/[^a-z0-9]+/).some((token) => token.length >= 3 && relevance.includes(token))
      || relevance.split(/[^a-z0-9]+/).some((token) => token.length >= 3 && haystack.includes(token));

    scored.push({ name: entry.name, relevant, activatedAt: entry.activatedAt });
  }

  // Relevant first (strong prior that still matches), then MRU by activatedAt.
  scored.sort((a, b) => {
    if (a.relevant !== b.relevant) return a.relevant ? -1 : 1;
    return b.activatedAt.localeCompare(a.activatedAt);
  });

  return scored.slice(0, cap).map((s) => s.name);
}

/** Format a system-message block for a lazily activated skill's instructions. */
export function formatActivatedSkillInstructionBlock(
  skillName: string,
  instructions: string,
): string | null {
  const body = instructions.trim();
  if (!body) return null;
  return `[Activated skill: ${skillName}]\n\n${body}`;
}

/** Apply multiple instruction blocks onto a system prompt (pinned path reuse). */
export function applyActivatedSkillInstructions(
  systemPrompt: string,
  blocks: string[],
): string {
  return appendSkillInstructions(systemPrompt, blocks);
}

/** Build the protocol payload returned by skill-activate for the runtime. */
export function buildSkillActivationProtocol(
  result: SkillActivationResult,
): Record<string, unknown> {
  return {
    _curia_protocol: SKILL_ACTIVATION_PROTOCOL,
    skill: result.skill,
    tools: result.tools,
    skippedTools: result.skippedTools,
    instructions: result.instructions,
    instructionsLoaded: result.instructions.length > 0,
  };
}

/** Parse a skill-activate tool result; null when not an activation protocol payload. */
export function parseSkillActivationProtocol(data: unknown): SkillActivationResult | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;
  if (obj._curia_protocol !== SKILL_ACTIVATION_PROTOCOL) return null;
  if (typeof obj.skill !== 'string' || !obj.skill.trim()) return null;
  if (!Array.isArray(obj.tools) || !obj.tools.every((t) => typeof t === 'string')) return null;
  const skippedTools = Array.isArray(obj.skippedTools)
    ? obj.skippedTools.filter((t): t is string => typeof t === 'string')
    : [];
  const instructions = typeof obj.instructions === 'string' ? obj.instructions : '';
  return {
    skill: obj.skill.trim(),
    tools: obj.tools as string[],
    skippedTools,
    instructions,
  };
}

/** MRU order helper for tests / callers inspecting entries. */
export function sortActiveSkillEntriesMru(entries: ActiveSkillEntry[]): ActiveSkillEntry[] {
  return [...entries].sort((a, b) => b.activatedAt.localeCompare(a.activatedAt));
}
