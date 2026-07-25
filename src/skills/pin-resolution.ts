// pin-resolution.ts — expand agent pinned_skills to tools + instruction blocks
// + capability flags.
//
// Pins are polymorphic (ADR-032): a pin may name a skill (bundle), a tool, or an
// MCP-projected skill. Skill pins expand member tools + instructions; tool pins
// resolve to exactly that one tool (never siblings). The skill remains the
// install/enable unit; the pin is the per-agent runtime-availability unit.
//
// Fine-grained "pin skill but exclude tool" is intentionally unsupported (YAGNI).
//
// Scheduled agents (#1501): unresolved pins still skip-and-continue (the agent
// may run with a reduced toolset), but bootstrap logs at error so monitoring
// can catch blind cron runs.

import type { SkillRegistry } from './skill-registry.js';
import type { ToolRegistry } from './registry.js';
import type { Logger } from '../logger.js';
import { formatActivatedSkillInstructionBlock } from './skill-instruction-format.js';

export type PinReferentKind = 'skill' | 'tool';

export type UnresolvedPinReason = 'not_found' | 'member_tools_missing';

/** A pin that did not fully resolve against the live registries. */
export interface UnresolvedPin {
  pin: string;
  reason: UnresolvedPinReason;
  /** Present when reason is member_tools_missing — tools absent from ToolRegistry. */
  missingTools?: string[];
}

export interface PinResolution {
  /** Deduped tool names to pass to ToolRegistry.toToolDefinitions(). */
  toolNames: string[];
  /** Instruction bodies to append to the system prompt (non-empty only). */
  instructionBlocks: string[];
  /** True when any pinned skill sets heartbeat: true. */
  heartbeatEligible: boolean;
  /** True when any pinned skill sets document_workspace: true. */
  documentWorkspaceEnabled: boolean;
  /** Skill names that were successfully resolved (bundle / MCP-projected). */
  resolvedSkills: string[];
  /** Per-pin referent kind for auditability (ADR-032). */
  resolvedPins: Array<{ pin: string; kind: PinReferentKind }>;
  /** Pins that were skipped or only partially expanded. */
  unresolvedPins: UnresolvedPin[];
}

/**
 * Resolve an agent's pinned_skills list against SkillRegistry + ToolRegistry.
 *
 * Resolution order per pin name:
 * 1. SkillRegistry hit (bundle or MCP-projected skill, including synthetic
 *    singletons) → expand members + instructions/flags.
 * 2. Else ToolRegistry hit → first-class single-tool pin (ADR-032).
 * 3. Else warn and skip (recorded in unresolvedPins).
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
  const resolvedPins: Array<{ pin: string; kind: PinReferentKind }> = [];
  const unresolvedPins: UnresolvedPin[] = [];
  let heartbeatEligible = false;
  let documentWorkspaceEnabled = false;

  const pushTool = (name: string, via: string): boolean => {
    if (seenTools.has(name)) return true;
    if (!toolRegistry.get(name)) {
      logger?.warn(
        { agent: agentName, tool: name, via },
        'Pinned skill expands to a tool that is not loaded; skipping tool definition',
      );
      return false;
    }
    seenTools.add(name);
    toolNames.push(name);
    return true;
  };

  for (const pin of pinnedSkills) {
    const skill = skillRegistry.get(pin);
    if (skill) {
      resolvedSkills.push(pin);
      resolvedPins.push({ pin, kind: 'skill' });
      const missingTools: string[] = [];
      for (const t of skill.manifest.tools) {
        if (!pushTool(t, pin)) missingTools.push(t);
      }
      if (missingTools.length > 0) {
        unresolvedPins.push({ pin, reason: 'member_tools_missing', missingTools });
      }
      // Prefer the shared formatter when the skill has progressive-disclosure
      // files so pinned imports get the references index. Native instruction
      // blocks without references stay as the raw body (no activation wrapper).
      const refs = skill.manifest.references ?? [];
      const assets = skill.manifest.assets ?? [];
      if (refs.length > 0 || assets.length > 0) {
        const block = formatActivatedSkillInstructionBlock(
          skill.manifest.name,
          skill.manifest.instructions,
          { references: refs, assets },
        );
        if (block) instructionBlocks.push(block);
      } else {
        const body = skill.manifest.instructions.trim();
        if (body) instructionBlocks.push(body);
      }
      if (skill.manifest.heartbeat) heartbeatEligible = true;
      if (skill.manifest.document_workspace) documentWorkspaceEnabled = true;
      if (!skill.synthetic) {
        logger?.debug?.(
          {
            agent: agentName,
            pin,
            kind: 'skill',
            tools: skill.manifest.tools,
            synthetic: false,
          },
          'Resolved capability pin',
        );
      }
      continue;
    }

    // First-class tool pin (ADR-032 polymorphic pins). Resolves to exactly this
    // tool — never the owning bundle's siblings.
    if (toolRegistry.get(pin)) {
      resolvedPins.push({ pin, kind: 'tool' });
      pushTool(pin, pin);
      logger?.debug?.(
        { agent: agentName, pin, kind: 'tool' },
        'Resolved capability pin',
      );
      continue;
    }

    unresolvedPins.push({ pin, reason: 'not_found' });
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
    resolvedPins,
    unresolvedPins,
  };
}

/**
 * Emit an error-level monitoring signal when a scheduled agent boots with
 * unresolved pinned skills. Schedules still load — the agent may try to run —
 * but the error is visible in logs for ops (#1501 / curia-deploy#181).
 *
 * Non-scheduled agents keep the per-pin warn from resolvePinnedSkills only.
 */
export function reportScheduledPinGaps(
  agentName: string,
  resolution: PinResolution,
  hasSchedule: boolean,
  logger: Logger,
): void {
  if (!hasSchedule || resolution.unresolvedPins.length === 0) return;

  // Error-level so log-based alerting / monitoring catches the gap — warn alone
  // is what let deploy agents run blind for hours (#1501 / curia-deploy#181).
  logger.error(
    {
      agent: agentName,
      unresolvedPins: resolution.unresolvedPins,
    },
    'Scheduled agent has unresolved pinned skills — toolset is reduced vs declared pins',
  );
}

/** Append instruction blocks to a system prompt (blank-line separated). */
export function appendSkillInstructions(systemPrompt: string, blocks: string[]): string {
  if (blocks.length === 0) return systemPrompt;
  return `${systemPrompt}\n\n${blocks.join('\n\n')}`;
}
