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
import { agentMayCallTool, skillReservedForOtherAgents } from './skill-activation.js';

export type PinReferentKind = 'skill' | 'tool';

export type UnresolvedPinReason = 'not_found' | 'member_tools_missing' | 'caller_not_allowed';

/** A pin that did not fully resolve against the live registries. */
export interface UnresolvedPin {
  pin: string;
  reason: UnresolvedPinReason;
  /** Present when reason is member_tools_missing — tools absent from ToolRegistry. */
  missingTools?: string[];
  /**
   * Present when reason is caller_not_allowed — tools the agent was NOT given because
   * their allowed_callers excludes it (#2646). The execution layer would refuse every call.
   */
  withheldTools?: string[];
}

/** How skill pins expand (#2764, ADR-070). Tool pins are always loaded. */
export type SkillLoadingMode = 'eager' | 'on_demand';

/** A skill pin under on_demand: name + description only until activation. */
export interface ListedSkill {
  name: string;
  description: string;
}

export interface PinResolution {
  /** Deduped tool names to pass to ToolRegistry.toToolDefinitions(). */
  toolNames: string[];
  /** Instruction bodies to append to the system prompt (non-empty only). Eager mode. */
  instructionBlocks: string[];
  /** The skill each entry of `instructionBlocks` came from, index for index. */
  instructionBlockSkills: string[];
  /**
   * Skill pins under on_demand: listed for the model, body/tools deferred (#2764).
   * Empty in eager mode.
   */
  listedSkills: ListedSkill[];
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

/** True when allowed_callers is exactly ["system"]: no agent can ever call the tool. */
function isSystemOnlyTool(toolRegistry: ToolRegistry, name: string): boolean {
  const allowed = toolRegistry.get(name)?.manifest.allowed_callers;
  return allowed !== undefined && allowed.length === 1 && allowed[0] === 'system';
}

/**
 * Resolve an agent's pinned_skills list against SkillRegistry + ToolRegistry.
 *
 * Resolution order per pin name:
 * 1. SkillRegistry hit (bundle or MCP-projected skill, including synthetic
 *    singletons) → expand members + instructions/flags (eager), or list only
 *    (on_demand, #2764 / ADR-070).
 * 2. Else ToolRegistry hit → first-class single-tool pin (ADR-032).
 * 3. Else warn and skip (recorded in unresolvedPins).
 */
export function resolvePinnedSkills(
  pinnedSkills: string[],
  skillRegistry: SkillRegistry,
  toolRegistry: ToolRegistry,
  logger?: Logger,
  agentName?: string,
  mode: SkillLoadingMode = 'eager',
): PinResolution {
  const toolNames: string[] = [];
  const seenTools = new Set<string>();
  const instructionBlocks: string[] = [];
  const instructionBlockSkills: string[] = [];
  const listedSkills: ListedSkill[] = [];
  const resolvedSkills: string[] = [];
  const resolvedPins: Array<{ pin: string; kind: PinReferentKind }> = [];
  const unresolvedPins: UnresolvedPin[] = [];
  let heartbeatEligible = false;
  let documentWorkspaceEnabled = false;

  // Without an agent name there is no caller to check, so only the system-only rule applies.
  // assembleAgent always passes the name; the rule lives in agentMayCallTool so pins,
  // activation and discovery cannot drift apart (#2646).
  const callerMayNotUse = (name: string): boolean =>
    agentName !== undefined && !agentMayCallTool(toolRegistry, name, agentName);

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
      // A bundle none of whose tools the agent may call belongs to other agents. Pinning it
      // would add no tools and splice in instructions written for its owner, which is exactly
      // what activation refuses (skillReservedForOtherAgents), so the pin does not resolve (#2646).
      const reservedForOthers =
        agentName !== undefined && skillReservedForOtherAgents(skill, toolRegistry, agentName);
      if (!reservedForOthers) {
        resolvedSkills.push(pin);
        resolvedPins.push({ pin, kind: 'skill' });
      }
      const missingTools: string[] = [];
      const withheldTools: string[] = [];
      for (const t of skill.manifest.tools) {
        // A tool only the system may call (allowed_callers: ["system"]) is never offered to an
        // agent through a bundle. card-use-confirm lives in `web` so it ships with its siblings.
        // When the whole bundle is dropped below, though, name them: otherwise a bundle of
        // nothing but system-only tools vanishes with no gap for either reporter.
        if (isSystemOnlyTool(toolRegistry, t)) {
          if (reservedForOthers) withheldTools.push(t);
          continue;
        }
        // A member the agent may not call is withheld too: handing over the definition only
        // teaches the model a call that fails every time (#2646). Unloaded tools are a
        // different gap (missingTools), so check registration first.
        if (toolRegistry.get(t) && callerMayNotUse(t)) {
          withheldTools.push(t);
          continue;
        }
        // on_demand: do not expand member tools into the fixed set — activation loads them
        // (#2764). Still detect missing tools so bootstrap gaps stay loud.
        if (mode === 'on_demand') {
          if (!toolRegistry.get(t)) missingTools.push(t);
          continue;
        }
        if (!pushTool(t, pin)) missingTools.push(t);
      }
      if (missingTools.length > 0) {
        unresolvedPins.push({ pin, reason: 'member_tools_missing', missingTools });
      }
      if (withheldTools.length > 0) {
        unresolvedPins.push({ pin, reason: 'caller_not_allowed', withheldTools });
      }
      if (reservedForOthers) continue;
      // Flags apply from the pin in both modes (heartbeat / document workspace).
      if (skill.manifest.heartbeat) heartbeatEligible = true;
      if (skill.manifest.document_workspace) documentWorkspaceEnabled = true;
      if (mode === 'on_demand') {
        listedSkills.push({
          name: skill.manifest.name,
          description: skill.manifest.description.trim(),
        });
        if (!skill.synthetic) {
          logger?.debug?.(
            { agent: agentName, pin, kind: 'skill', mode: 'on_demand' },
            'Listed capability pin (on_demand)',
          );
        }
        continue;
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
        if (block) {
          instructionBlocks.push(block);
          instructionBlockSkills.push(pin);
        }
      } else {
        const body = skill.manifest.instructions.trim();
        if (body) {
          instructionBlocks.push(body);
          instructionBlockSkills.push(pin);
        }
      }
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
    if (toolRegistry.get(pin) && !isSystemOnlyTool(toolRegistry, pin)) {
      if (callerMayNotUse(pin)) {
        unresolvedPins.push({ pin, reason: 'caller_not_allowed', withheldTools: [pin] });
        continue;
      }
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
    instructionBlockSkills,
    listedSkills,
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
  // A pin that lost only some tools to allowed_callers is a misdeclared pin that
  // reportWithheldPinTools warns about. One that lost every tool (it is not in resolvedPins)
  // leaves the agent running blind, which is what this error exists to catch.
  const resolved = new Set(resolution.resolvedPins.map((r) => r.pin));
  const gaps = resolution.unresolvedPins.filter(
    (p) => p.reason !== 'caller_not_allowed' || !resolved.has(p.pin),
  );
  if (!hasSchedule || gaps.length === 0) return;

  // Error-level so log-based alerting / monitoring catches the gap — warn alone
  // is what let deploy agents run blind for hours (#1501 / curia-deploy#181).
  logger.error(
    {
      agent: agentName,
      unresolvedPins: gaps,
    },
    'Scheduled agent has unresolved pinned skills — toolset is reduced vs declared pins',
  );
}

/**
 * Warn, once per agent, about pinned tools withheld because allowed_callers excludes the
 * agent (#2646). Without it a misconfigured pin is only visible as a failed call at run
 * time: prod's social-media agent hit "restricted to agents" on calendar-list-events every
 * run. The fix is in the agent's pin list (or delegate to the owning agent), so name both.
 */
export function reportWithheldPinTools(
  agentName: string,
  resolution: PinResolution,
  logger: Logger,
): void {
  const withheld = resolution.unresolvedPins
    .filter((p) => p.reason === 'caller_not_allowed' && p.withheldTools && p.withheldTools.length > 0)
    .map((p) => ({ pin: p.pin, tools: p.withheldTools! }));
  if (withheld.length === 0) return;

  logger.warn(
    { agent: agentName, withheldTools: withheld },
    'Pinned tools withheld from agent: allowed_callers excludes it. Remove the pin or delegate to the owning agent',
  );
}

/** One agent contributing to the bundle → pinner map. `pinnedSkills: null` means the YAML did not parse. */
export interface AgentPinSource {
  name: string;
  pinnedSkills: readonly string[] | null;
  parseError?: string;
}

/**
 * Build the bundle → pinning-agents map used by the registry UI (#1724).
 *
 * An agent whose config failed to parse has unknown pins. Skipping it with
 * `config?.pinned_skills` dropped it out of the map with no signal — the same
 * blind spot the detector exists to catch. Log that omission at error. (#1898)
 */
export function collectPinnedByBundle(
  agents: readonly AgentPinSource[],
  logger: Logger,
): Map<string, string[]> {
  const pinnedByBundle = new Map<string, string[]>();
  for (const agent of agents) {
    if (agent.pinnedSkills === null) {
      logger.error(
        { agent: agent.name, parseError: agent.parseError },
        'Pin-gap detection: agent config failed to parse — skill pins are unknown and this agent is omitted from pinnedByBundle',
      );
      continue;
    }
    for (const pin of agent.pinnedSkills) {
      const list = pinnedByBundle.get(pin);
      if (list) list.push(agent.name);
      else pinnedByBundle.set(pin, [agent.name]);
    }
  }
  return pinnedByBundle;
}

/** Append instruction blocks to a system prompt (blank-line separated). */
export function appendSkillInstructions(systemPrompt: string, blocks: string[]): string {
  if (blocks.length === 0) return systemPrompt;
  return `${systemPrompt}\n\n${blocks.join('\n\n')}`;
}
