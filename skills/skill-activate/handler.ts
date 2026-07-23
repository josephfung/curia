// handler.ts — skill-activate (#1495 Phase 3a).
//
// Activates a skill (bundle) for the current task: resolves member tools the
// calling agent may invoke and returns the SKILL.md instruction body. The
// agent runtime expands the working tool list and injects instructions;
// durable state is written to tasks.progress.activeSkills when a task is bound
// via taskMetadata (never via an LLM-supplied task_id — cross-task write risk).

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import {
  buildSkillActivationProtocol,
  resolveSkillActivation,
} from '../../src/skills/skill-activation.js';
import {
  activateSkillInBlock,
  prepareActiveSkillsBlock,
  readActiveSkillsBlock,
} from '../../src/db/active-skills-progress.js';
import { boundTaskFromMetadata } from '../../src/agents/resumable-task.js';

export class SkillActivateHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
    const input = ctx.input as { skill?: string; reference?: string };
    const skillName = typeof input.skill === 'string' ? input.skill.trim() : '';
    if (!skillName) {
      return { success: false, error: 'Missing required input: skill (non-empty string)' };
    }
    const reference = typeof input.reference === 'string' ? input.reference : undefined;

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
    const resolved = resolveSkillActivation({
      skillName,
      skillRegistry: ctx.skillRegistry,
      toolRegistry: ctx.toolRegistry,
      agentId,
      reference,
    });
    if ('error' in resolved) {
      return { success: false, error: resolved.error };
    }

    // Persist only to the runtime-bound task (taskMetadata) — never accept an
    // LLM-supplied task_id (would allow cross-task writes into another row's
    // activeSkills).
    const bound = boundTaskFromMetadata(ctx.taskMetadata as Record<string, unknown> | undefined);
    const taskId = bound?.taskId;

    if (taskId && ctx.taskRepo) {
      try {
        const task = await ctx.taskRepo.getTask(taskId);
        if (task) {
          const next = activateSkillInBlock(
            readActiveSkillsBlock(task.progress),
            resolved.skill,
          );
          const prepared = prepareActiveSkillsBlock(next);
          if (prepared.ok) {
            await ctx.taskRepo.setActiveSkillsBlock(taskId, next, agentId);
          } else {
            ctx.log.warn(
              { skill: resolved.skill, taskId, prepared },
              'skill-activate: could not prepare activeSkills block — activation still applies in-memory',
            );
          }
        }
      } catch (err) {
        ctx.log.warn(
          { err, skill: resolved.skill, taskId },
          'skill-activate: failed to persist activeSkills — activation still applies in-memory',
        );
      }
    }

    return {
      success: true,
      data: buildSkillActivationProtocol(resolved),
    };
  }
}

export default new SkillActivateHandler();
