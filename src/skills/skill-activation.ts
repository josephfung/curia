// skill-activation.ts — Phase 3a (#1495) unified discovery + activation helpers.
//
// Activation tiers (docs/adr/031-tools-vs-skills-vocabulary.md,
// docs/adr/032-polymorphic-pins-and-mcp-as-skill.md):
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
import { readSkillResource } from './skill-resources.js';

import {
  formatActivatedSkillInstructionBlock,
  formatSkillReferenceBlock,
} from './skill-instruction-format.js';

export {
  formatActivatedSkillInstructionBlock,
  formatSkillReferenceBlock,
};

export const SKILL_ACTIVATE_TOOL_NAME = 'skill-activate';
/** Voice-bridge-only tools excluded from text-turn discovery (#1614). */
export const ASYNC_OFFRAMP_TOOL_NAME = 'async-offramp';
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
  /** Progressive-disclosure files under references/ (Phase 3). */
  references: string[];
  /** Progressive-disclosure files under assets/ (Phase 3). */
  assets: string[];
  /**
   * When skill-activate was called with `reference`, the loaded file payload.
   * Absent on plain activation.
   */
  referenceContent?: {
    path: string;
    content: string;
    truncated: boolean;
  };
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
  /** Tool names excluded from results (e.g. tool-registry, skill-activate, async-offramp). */
  excludeToolNames?: ReadonlySet<string>;
}): DiscoveryHit[] {
  const {
    query,
    toolRegistry,
    skillRegistry,
    agentId,
    excludeToolNames = new Set([
      'tool-registry',
      SKILL_ACTIVATE_TOOL_NAME,
      // Voice-only: injected by the voice tool bridge, never discoverable on text (#1614).
      ASYNC_OFFRAMP_TOOL_NAME,
    ]),
  } = options;

  const results: DiscoveryHit[] = [];
  const seenSkills = new Set<string>();
  const seenTools = new Set<string>();

  const pushSkill = (skill: RegisteredSkill) => {
    if (skill.synthetic) return;
    if (seenSkills.has(skill.manifest.name)) return;
    // Activation would refuse it, so offering it only costs the agent a round (#1958).
    if (skillReservedForOtherAgents(skill, toolRegistry, agentId)) return;
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

    // Single source of truth for the allowed_callers rule (see agentMayCallTool).
    if (!agentMayCallTool(toolRegistry, name, agentId)) continue;

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

/**
 * Whether every member tool the agent could otherwise use is withheld from it by
 * allowed_callers: at least one registered member names other callers, and none is
 * callable by this agent.
 *
 * Such a bundle belongs to other agents (the calendar bundle to @calendar). Activating it
 * would add no tools and splice in instructions written for its owner, and searching it
 * up would invite exactly that. A bundle whose members are merely unregistered (an MCP
 * server that is down) is a different failure and does not count.
 */
export function skillReservedForOtherAgents(
  skill: RegisteredSkill,
  toolRegistry: ToolRegistry,
  agentId: string,
): boolean {
  let withheld = false;
  for (const toolName of skill.manifest.tools) {
    if (!toolRegistry.get(toolName)) continue;
    if (agentMayCallTool(toolRegistry, toolName, agentId)) return false;
    withheld = true;
  }
  return withheld;
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
 *
 * Optional `reference` loads one progressive-disclosure file from the skill's
 * `references/` or `assets/` tree (Phase 3). Activation never widens authority.
 */
export function resolveSkillActivation(options: {
  skillName: string;
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
  agentId: string;
  /** Optional reference/asset path to load into context (Phase 3). */
  reference?: string;
}): SkillActivationResult | SkillActivationFailure {
  const { skillName, skillRegistry, toolRegistry, agentId, reference } = options;
  const name = skillName.trim();
  if (!name) return { error: 'skill name is required' };

  const skill = skillRegistry.get(name);
  if (!skill) return { error: `Unknown skill: ${name}` };
  if (skill.synthetic) {
    return { error: `Cannot activate synthetic skill '${name}' — pin or discover a real bundle` };
  }

  if (skillReservedForOtherAgents(skill, toolRegistry, agentId)) {
    return {
      error:
        `Skill '${name}' has no tools you can call: they are reserved for other agents. `
        + 'Delegate the work to the agent that owns this capability instead.',
    };
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

  const references = skill.manifest.references ?? [];
  const assets = skill.manifest.assets ?? [];

  let referenceContent: SkillActivationResult['referenceContent'];
  if (reference !== undefined && reference.trim() !== '') {
    if (!skill.dir) {
      return { error: `Skill '${name}' has no on-disk directory — cannot load references` };
    }
    const read = readSkillResource(skill.dir, reference, { references, assets });
    if (!read.ok) return { error: read.error };
    referenceContent = {
      path: read.path,
      content: read.content,
      truncated: read.truncated,
    };
  }

  return {
    skill: skill.manifest.name,
    tools,
    skippedTools,
    instructions: skill.manifest.instructions.trim(),
    references: [...references],
    assets: [...assets],
    referenceContent,
  };
}

/**
 * On wake: re-load every skill activated on the task, most recently used first,
 * capped at ACTIVE_SKILLS_CAP (#2764). No relevance filter and no pinned-skill
 * exclusion — under on_demand a listed skill is not already in the tool set, and
 * even under eager the wake must restore activated tools that may have been
 * dropped from the working list. `pinnedSkillNames` and `relevanceText` remain
 * in the options object for call-site compatibility; they are unused.
 */
export function selectActiveSkillsForWake(options: {
  progress: Record<string, unknown> | undefined | null;
  pinnedSkillNames: ReadonlySet<string> | readonly string[];
  skillRegistry: SkillRegistry;
  relevanceText: string;
  cap?: number;
}): string[] {
  const cap = options.cap ?? ACTIVE_SKILLS_CAP;
  void options.pinnedSkillNames;
  void options.relevanceText;

  const stored = readActiveSkillsBlock(options.progress)?.skills ?? [];
  if (stored.length === 0) return [];

  const kept: Array<{ name: string; activatedAt: string }> = [];
  for (const entry of stored) {
    const skill = options.skillRegistry.get(entry.name);
    if (!skill || skill.synthetic) continue;
    kept.push({ name: entry.name, activatedAt: entry.activatedAt });
  }

  kept.sort((a, b) => b.activatedAt.localeCompare(a.activatedAt));
  return kept.slice(0, cap).map((s) => s.name);
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
  const payload: Record<string, unknown> = {
    _curia_protocol: SKILL_ACTIVATION_PROTOCOL,
    skill: result.skill,
    tools: result.tools,
    skippedTools: result.skippedTools,
    instructions: result.instructions,
    instructionsLoaded: result.instructions.length > 0,
    references: result.references,
    assets: result.assets,
  };
  if (result.referenceContent) {
    payload.referenceContent = result.referenceContent;
  }
  return payload;
}

/**
 * Metadata ack for a skill activation (#1505 / #2764).
 *
 * Under append-only delivery (#2764 / ADR-070) the runtime composes the tool
 * result as this ack plus the SKILL.md body (and any reference content) so the
 * prompt prefix stays cacheable. Bodies are no longer spliced as system messages.
 */
export function buildSkillActivationAck(
  activation: SkillActivationResult,
): Record<string, unknown> {
  const ack: Record<string, unknown> = {
    _curia_protocol: SKILL_ACTIVATION_PROTOCOL,
    skill: activation.skill,
    tools: activation.tools,
    skippedTools: activation.skippedTools,
    instructionsLoaded: activation.instructions.length > 0,
    references: activation.references,
    assets: activation.assets,
  };
  if (activation.referenceContent) {
    ack.referenceContent = {
      path: activation.referenceContent.path,
      truncated: activation.referenceContent.truncated,
      loaded: true,
    };
  }
  return ack;
}

/**
 * Append-only skill-activate tool result (#2764): JSON ack, then the instruction
 * block and optional reference body as plain text after a delimiter. The runtime
 * builds this so long bodies bypass sanitize truncation of the JSON envelope.
 */
export function buildSkillActivationToolResult(
  activation: SkillActivationResult,
): string {
  const ack = buildSkillActivationAck(activation);
  const parts: string[] = [JSON.stringify(ack)];
  const instructionBlock = formatActivatedSkillInstructionBlock(
    activation.skill,
    activation.instructions,
    { references: activation.references, assets: activation.assets },
  );
  if (instructionBlock) {
    parts.push('', instructionBlock);
  }
  if (activation.referenceContent) {
    parts.push(
      '',
      formatSkillReferenceBlock(
        activation.skill,
        activation.referenceContent.path,
        activation.referenceContent.content,
        activation.referenceContent.truncated,
      ),
    );
  }
  return parts.join('\n');
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
  const references = Array.isArray(obj.references)
    ? obj.references.filter((t): t is string => typeof t === 'string')
    : [];
  const assets = Array.isArray(obj.assets)
    ? obj.assets.filter((t): t is string => typeof t === 'string')
    : [];

  let referenceContent: SkillActivationResult['referenceContent'];
  if (obj.referenceContent && typeof obj.referenceContent === 'object' && !Array.isArray(obj.referenceContent)) {
    const rc = obj.referenceContent as Record<string, unknown>;
    if (
      typeof rc.path === 'string' &&
      typeof rc.content === 'string' &&
      typeof rc.truncated === 'boolean'
    ) {
      referenceContent = {
        path: rc.path,
        content: rc.content,
        truncated: rc.truncated,
      };
    }
  }

  return {
    skill: obj.skill.trim(),
    tools: obj.tools as string[],
    skippedTools,
    instructions,
    references,
    assets,
    referenceContent,
  };
}

/** MRU order helper for tests / callers inspecting entries. */
export function sortActiveSkillEntriesMru(entries: ActiveSkillEntry[]): ActiveSkillEntry[] {
  return [...entries].sort((a, b) => b.activatedAt.localeCompare(a.activatedAt));
}
