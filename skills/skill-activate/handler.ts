// handler.ts — skill-activate (#1495 Phase 3a / #2764).
//
// Activates one or more skills (bundles) for the current task: resolves member
// tools the calling agent may invoke and returns each SKILL.md instruction body.
// The agent runtime expands the working tool list and delivers instructions
// append-only in the tool result (#2764 / ADR-070). Durable state is written to
// tasks.progress.activeSkills when a task is bound via taskMetadata (never via
// an LLM-supplied task_id — cross-task write risk).

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import {
  buildSkillActivationProtocol,
  resolveSkillActivation,
  type SkillActivationResult,
} from '../../src/skills/skill-activation.js';
import {
  activateSkillInBlock,
  prepareActiveSkillsBlock,
  readActiveSkillsBlock,
} from '../../src/db/active-skills-progress.js';
import { boundTaskFromMetadata } from '../../src/agents/resumable-task.js';

function collectSkillNames(input: { skill?: string; skills?: unknown }): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const name = raw.trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };
  if (Array.isArray(input.skills)) {
    for (const entry of input.skills) {
      if (typeof entry === 'string') push(entry);
    }
  }
  if (typeof input.skill === 'string') push(input.skill);
  return names;
}

async function persistActivation(
  ctx: ToolContext,
  skillName: string,
  agentId: string,
): Promise<void> {
  const bound = boundTaskFromMetadata(ctx.taskMetadata as Record<string, unknown> | undefined);
  const taskId = bound?.taskId;

  if (taskId && !ctx.taskRepo) {
    // taskRepo is optional (#2024): absent in the test-mode stack, never on a real
    // bound task. Without it the activation lasts only this turn, not past a wake.
    ctx.log.warn({ taskId, skill: skillName }, 'skill-activate: bound task but no taskRepo — activation will not survive a wake');
  }
  if (taskId && ctx.taskRepo) {
    try {
      const task = await ctx.taskRepo.getTask(taskId);
      if (task) {
        const next = activateSkillInBlock(
          readActiveSkillsBlock(task.progress),
          skillName,
        );
        const prepared = prepareActiveSkillsBlock(next);
        if (prepared.ok) {
          await ctx.taskRepo.setActiveSkillsBlock(taskId, next, agentId);
        } else {
          ctx.log.warn(
            { skill: skillName, taskId, prepared },
            'skill-activate: could not prepare activeSkills block — activation still applies in-memory',
          );
        }
      }
    } catch (err) {
      ctx.log.warn(
        { err, skill: skillName, taskId },
        'skill-activate: failed to persist activeSkills — activation still applies in-memory',
      );
    }
  }
}

export class SkillActivateHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const input = ctx.input as { skill?: string; skills?: unknown; reference?: string };
    const skillNames = collectSkillNames(input);
    if (skillNames.length === 0) {
      return {
        success: false,
        error: 'Missing required input: skill or skills (non-empty string / string array)',
      };
    }
    const reference = typeof input.reference === 'string' ? input.reference : undefined;
    if (reference !== undefined && skillNames.length > 1) {
      return {
        success: false,
        error: 'skill-activate: `reference` applies to a single skill — pass `skill` alone when loading a reference file',
      };
    }

    if (!ctx.skillRegistry) {
      return {
        success: false,
        error: 'skill-activate: skillRegistry not available — check ExecutionLayer configuration.',
      };
    }
    if (!ctx.toolRegistry) {
      return {
        success: false,
        error: 'skill-activate: toolRegistry not available — check ExecutionLayer configuration.',
      };
    }

    const agentId = ctx.agentId ?? 'system';
    const activations: SkillActivationResult[] = [];
    const errors: string[] = [];
    // allow_discovery:false agents may only activate their listed skills (#2764).
    // Code pre-activation uses resolveSkillActivationForAgent and skips this gate.
    const allowlist = ctx.activatableSkills;

    for (const skillName of skillNames) {
      if (allowlist && !allowlist.has(skillName)) {
        errors.push(
          `${skillName}: not in this agent's listed skills — activate only skills listed in your system prompt`,
        );
        continue;
      }
      const resolved = resolveSkillActivation({
        skillName,
        skillRegistry: ctx.skillRegistry,
        toolRegistry: ctx.toolRegistry,
        agentId,
        reference: skillNames.length === 1 ? reference : undefined,
      });
      if ('error' in resolved) {
        errors.push(`${skillName}: ${resolved.error}`);
        continue;
      }
      await persistActivation(ctx, resolved.skill, agentId);
      activations.push(resolved);
    }

    if (activations.length === 0) {
      return {
        success: false,
        error: errors.length > 0
          ? errors.join('; ')
          : 'skill-activate: no skills activated',
      };
    }

    // Single-skill shape stays backwards compatible for the runtime protocol parser.
    if (activations.length === 1) {
      const data = buildSkillActivationProtocol(activations[0]!);
      if (errors.length > 0) data.partialErrors = errors;
      return { success: true, data };
    }

    return {
      success: true,
      data: {
        _curia_protocol: 'skill_activation_batch',
        activations: activations.map((a) => buildSkillActivationProtocol(a)),
        ...(errors.length > 0 ? { partialErrors: errors } : {}),
      },
    };
  }
}

export default new SkillActivateHandler();
