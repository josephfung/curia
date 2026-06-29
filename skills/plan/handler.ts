// handler.ts — plan skill (#1237).
//
// Rows-direct decomposition: writes child task rows and the progress.plan block.
// Symmetric with checkpoint — platform-owned durable state, runtime-LLM-driven.

import type { SkillHandler, SkillContext, SkillResult } from '../../src/skills/types.js';
import { boundTaskFromMetadata } from '../../src/agents/resumable-task.js';
import {
  buildPlanStepDescriptors,
  countMaterializationKinds,
  existingTaskIdForStep,
  findRemovedChildTaskIds,
  parsePlanStepsInput,
  resolveBlockedByTaskId,
  validateDeliverableStepId,
  type PlanStepInput,
} from '../../src/agents/plan-execution.js';
import { computePlanRollup, readPlanBlock } from '../../src/db/plan-progress.js';
import type { TaskOriginator } from '../../src/contacts/types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_STATUSES = new Set(['done', 'cancelled']);

export class PlanHandler implements SkillHandler {
  async execute(ctx: SkillContext): Promise<SkillResult> {
    const input = ctx.input as {
      task_id?: string;
      goal?: string;
      steps?: unknown;
      deliverable_step_id?: string | null;
      next?: string;
    };

    const bound = boundTaskFromMetadata(ctx.taskMetadata as Record<string, unknown> | undefined);
    const taskId = input.task_id ?? bound?.taskId;
    if (!taskId || typeof taskId !== 'string') {
      return {
        success: false,
        error: 'Missing task_id — provide it explicitly or run on a task-bound scheduler wake',
      };
    }
    if (!UUID_RE.test(taskId)) {
      return { success: false, error: 'task_id must be a valid UUID' };
    }

    const steps = parsePlanStepsInput(input.steps);
    if (!steps) {
      return { success: false, error: 'Missing or invalid required input: steps (non-empty array)' };
    }

    const deliverableStepId = validateDeliverableStepId(input.deliverable_step_id, steps);
    if (deliverableStepId === undefined) {
      return {
        success: false,
        error: 'deliverable_step_id must be null or reference a step id in steps',
      };
    }

    if (!input.next || typeof input.next !== 'string' || !input.next.trim()) {
      return { success: false, error: 'Missing required input: next (non-empty string)' };
    }

    if (!ctx.taskRepo) {
      return {
        success: false,
        error: 'plan: taskRepo not available — check ExecutionLayer configuration.',
      };
    }

    const parent = await ctx.taskRepo.getTask(taskId);
    if (!parent) {
      return { success: false, error: `Task not found: ${taskId}` };
    }
    if (TERMINAL_STATUSES.has(parent.status)) {
      return { success: false, error: `Task ${taskId} is in a terminal state` };
    }

    for (const step of steps) {
      if (step.target_agent_id !== ctx.agentId) {
        if (!ctx.agentRegistry) {
          return {
            success: false,
            error: 'plan: agentRegistry not available — cannot validate target_agent_id.',
          };
        }
        if (!ctx.agentRegistry.has(step.target_agent_id)) {
          return {
            success: false,
            error: `target_agent_id '${step.target_agent_id}' is not a registered agent`,
          };
        }
      }
      if (step.blocked_by_step_id && !steps.some((s) => s.id === step.blocked_by_step_id)) {
        return {
          success: false,
          error: `blocked_by_step_id '${step.blocked_by_step_id}' is not a step in this plan`,
        };
      }
    }

    const existingPlan = readPlanBlock(parent.progress);
    const newStepIds = new Set(steps.map((s) => s.id));
    const stepTaskIds: Record<string, string | null> = {};
    const originator = (ctx.taskMetadata?.originator as TaskOriginator | undefined) ?? null;
    const creatorAgentId = ctx.agentId ?? 'system';

    ctx.log.info(
      {
        taskId,
        stepCount: steps.length,
        ...countMaterializationKinds(steps),
        goal: input.goal?.slice(0, 120),
      },
      'Executing plan decomposition',
    );

    try {
      // First pass: create or reuse materialized child rows (blocked_by resolved in pass two).
      for (const step of steps) {
        if (step.materialize === false) {
          stepTaskIds[step.id] = null;
          continue;
        }

        const priorTaskId = existingTaskIdForStep(existingPlan, step.id);
        if (priorTaskId) {
          const priorChild = await ctx.taskRepo.getTask(priorTaskId);
          if (priorChild && priorChild.parentTaskId === taskId) {
            stepTaskIds[step.id] = priorTaskId;
            continue;
          }
        }

        const child = await ctx.taskRepo.createTask({
          agentId: step.target_agent_id,
          title: step.title,
          description: step.description,
          parentTaskId: taskId,
          waitingOnContactId: step.waiting_on_contact_id ?? undefined,
          waitingOnText: step.waiting_on_text ?? undefined,
          source: parent.source as 'ceo' | 'agent' | 'scheduler' | 'coordinator',
          sourceAgentId: step.target_agent_id,
          createdBy: creatorAgentId,
          originator,
          resumable: step.resumable === true,
        });
        stepTaskIds[step.id] = child.id;
      }

      // Second pass: wire intra-plan dependencies now that all step ids are mapped.
      for (const step of steps) {
        if (step.materialize === false) continue;
        const childTaskId = stepTaskIds[step.id];
        if (!childTaskId) continue;

        const blockedByTaskId = resolveBlockedByTaskId(step.blocked_by_step_id, stepTaskIds);
        if (blockedByTaskId) {
          await ctx.taskRepo.updateTask(childTaskId, { blockedByTaskId }, ctx.agentId);
        }
      }

      // Adaptive re-plan: cancel open children removed from the plan.
      const removedChildIds = findRemovedChildTaskIds(existingPlan, newStepIds);
      for (const childId of removedChildIds) {
        const child = await ctx.taskRepo.getTask(childId);
        if (child && !TERMINAL_STATUSES.has(child.status)) {
          await ctx.taskRepo.updateTask(
            childId,
            { status: 'cancelled', progressNote: 'Removed from plan during re-plan' },
            ctx.agentId,
          );
        }
      }

      const descriptors = buildPlanStepDescriptors(steps, stepTaskIds);
      const childStatuses: Record<string, string> = {};
      for (const descriptor of descriptors) {
        if (!descriptor.taskId) continue;
        const child = await ctx.taskRepo.getTask(descriptor.taskId);
        if (child) childStatuses[descriptor.taskId] = child.status;
      }
      const rollup = computePlanRollup(descriptors, childStatuses);

      const planResult = await ctx.taskRepo.setPlanBlock(
        taskId,
        {
          steps: descriptors,
          deliverableStepId,
          done: rollup.done,
          total: rollup.total,
          next: input.next.trim(),
        },
        ctx.agentId,
      );

      if ('ok' in planResult && planResult.ok === false) {
        if (planResult.code === 'block_overflow') {
          return {
            success: false,
            error: `Plan block exceeds cap (${planResult.bytes} bytes, max ${planResult.maxBytes})`,
          };
        }
        return { success: false, error: planResult.message ?? 'Failed to write plan block' };
      }

      const { block } = planResult as { task: unknown; block: { total: number; done: number } };
      const materialization = countMaterializationKinds(steps);

      return {
        success: true,
        data: {
          task_id: taskId,
          done: block.done,
          total: block.total,
          deliverable_step_id: deliverableStepId,
          steps: descriptors.map((d) => ({ id: d.id, task_id: d.taskId })),
          materialized: materialization.heterogeneousRows + materialization.iterateLeaves,
          iterate_leaves: materialization.iterateLeaves,
          lazy_steps: materialization.lazySteps,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, taskId }, 'Failed to execute plan');
      return { success: false, error: `Failed to execute plan: ${message}` };
    }
  }
}

export type { PlanStepInput };
