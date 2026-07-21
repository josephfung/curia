// pin-resolution.ts — expand agent pinned_skills (skill bundle names) to tools
// + instruction blocks + capability flags.
//
// Pin target is a **skill** (bundle). Resolution expands member tools and, when
// the skill ships instructions / heartbeat / document_workspace flags, applies
// those. Synthetic singleton skills cover unbundled flat/MCP tools so existing
// pin lists that still name individual tools keep working.
//
// Fine-grained "pin skill but exclude tool" is intentionally unsupported (YAGNI).

import type { SkillRegistry } from './skill-registry.js';
import type { ToolRegistry } from './registry.js';
import type { Logger } from '../logger.js';

export interface PinResolution {
  /** Deduped tool names to pass to ToolRegistry.toToolDefinitions(). */
  toolNames: string[];
  /** Instruction bodies to append to the system prompt (non-empty only). */
  instructionBlocks: string[];
  /** True when any pinned skill sets heartbeat: true. */
  heartbeatEligible: boolean;
  /** True when any pinned skill sets document_workspace: true. */
  documentWorkspaceEnabled: boolean;
  /** Skill names that were successfully resolved. */
  resolvedSkills: string[];
}

/**
 * Resolve an agent's pinned_skills list against the SkillRegistry.
 * Unknown names that match a ToolRegistry tool are accepted as a transitional
 * fallback (warn once) so specialist YAMLs that still list atoms keep working
 * until they retarget to bundles.
 */
export function resolvePinnedSkills(
  pinnedSkills: string[],
  skillRegistry: SkillRegistry,
  toolRegistry: ToolRegistry,
  logger?: Logger,
  agentName?: string,
): PinResolution {
  const toolNames: string[] = [];
  const seenTools = new Set<string>();
  const instructionBlocks: string[] = [];
  const resolvedSkills: string[] = [];
  let heartbeatEligible = false;
  let documentWorkspaceEnabled = false;

  const pushTool = (name: string) => {
    if (seenTools.has(name)) return;
    seenTools.add(name);
    toolNames.push(name);
  };

  for (const pin of pinnedSkills) {
    const skill = skillRegistry.get(pin);
    if (skill) {
      resolvedSkills.push(pin);
      for (const t of skill.manifest.tools) pushTool(t);
      const body = skill.manifest.instructions.trim();
      if (body) instructionBlocks.push(body);
      if (skill.manifest.heartbeat) heartbeatEligible = true;
      if (skill.manifest.document_workspace) documentWorkspaceEnabled = true;
      continue;
    }

    // Transitional fallback: pin names a tool directly.
    if (toolRegistry.get(pin)) {
      logger?.warn(
        { agent: agentName, pin },
        'pinned_skills entry is a tool name; prefer pinning its skill bundle (ADR-031 Phase 2)',
      );
      pushTool(pin);
      continue;
    }

    logger?.warn(
      { agent: agentName, pin },
      'Pinned skill not found in SkillRegistry (and not a loaded tool); skipping',
    );
  }

  return {
    toolNames,
    instructionBlocks,
    heartbeatEligible,
    documentWorkspaceEnabled,
    resolvedSkills,
  };
}

/** Append instruction blocks to a system prompt (blank-line separated). */
export function appendSkillInstructions(systemPrompt: string, blocks: string[]): string {
  if (blocks.length === 0) return systemPrompt;
  return `${systemPrompt}\n\n${blocks.join('\n\n')}`;
}
