// handler.ts — plan skill (#1237).
//
// Rows-direct decomposition: writes child task rows and the progress.plan block.
// Symmetric with checkpoint — platform-owned durable state, runtime-LLM-driven.

import type { ToolHandler, ToolContext, ToolResult } from '../../src/skills/types.js';
import { boundTaskFromMetadata } from '../../src/agents/resumable-task.js';
import { DEFAULT_RESUMABLE_CEILINGS } from '../../src/config.js';
import {
  detectPlanAdaptiveBreach,
  escalatePlanAdaptiveBreach,
  readPlanAdaptiveState,
  resolvePlanDepthForWrite,
} from '../../src/agents/plan-adaptive-replan.js';
import {
  buildPlanStepDescriptors,
  countMaterializationKinds,
  existingTaskIdForStep,
  findRemovedChildTaskIds,
  parsePlanStepInput,
  parsePlanStepsInput,
  planStepDriftsFromChild,
  preflightPlanBlockWrite,
  resolveBlockedByTaskId,
  validateDeliverableStepId,
  validatePlanStepsGraph,
  type PlanStepInput,
} from '../../src/agents/plan-execution.js';
import { computePlanRollup, readPlanBlock } from '../../src/db/plan-progress.js';
import type { TaskRow } from '../../src/db/queries/tasks.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_STATUSES = new Set(['done', 'cancelled', 'failed']);

export class PlanHandler implements ToolHandler {
  async execute(ctx: ToolContext): Promise<ToolResult> {
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
      const rawSteps = Array.isArray(input.steps) ? input.steps : [];
      const parsedSteps: PlanStepInput[] = [];
      for (const item of rawSteps) {
        const step = parsePlanStepInput(item);
        if (step) parsedSteps.push(step);
      }
      const graphError = parsedSteps.length > 0 ? validatePlanStepsGraph(parsedSteps) : null;
      if (graphError) {
        return { success: false, error: graphError };
      }
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

    const resumableCeilings = ctx.resumableCeilings ?? DEFAULT_RESUMABLE_CEILINGS;

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
    }

    const existingPlan = readPlanBlock(parent.progress);
    const isReplan = existingPlan !== null;
    const existingAdaptive = readPlanAdaptiveState(parent.progress);
    const immediateParent = parent.parentTaskId
      ? await ctx.taskRepo.getTask(parent.parentTaskId)
      : null;
    const planDepth = resolvePlanDepthForWrite(parent, immediateParent, isReplan);
    const replanCount = (existingAdaptive?.replanCount ?? 0) + (isReplan ? 1 : 0);

    const breach = detectPlanAdaptiveBreach(
      { planDepth, replanCount: isReplan ? replanCount : (existingAdaptive?.replanCount ?? 0) },
      resumableCeilings,
      parent.errorBudget,
    );
    if (breach) {
      await escalatePlanAdaptiveBreach({
        bus: ctx.bus,
        taskRepo: ctx.taskRepo,
        logger: ctx.log,
        task: parent,
        breach,
        agentId: ctx.agentId ?? 'system',
      });
      return { success: false, error: breach.message };
    }

    const newStepIds = new Set(steps.map((s) => s.id));
    const stepTaskIds: Record<string, string | null> = {};
    const originator = parent.originator;
    const creatorAgentId = ctx.agentId ?? 'system';
    const next = input.next.trim();
    const createdTaskIds: string[] = [];

    const preflight = preflightPlanBlockWrite(steps, existingPlan, deliverableStepId, next);
    if (!preflight.ok) {
      if (preflight.code === 'block_overflow') {
        return {
          success: false,
          error: `Plan block exceeds cap (${preflight.bytes} bytes, max ${preflight.maxBytes})`,
        };
      }
      return { success: false, error: preflight.message ?? 'plan block failed validation' };
    }

    ctx.log.info(
      {
        taskId,
        stepCount: steps.length,
        ...countMaterializationKinds(steps),
        goal: input.goal?.slice(0, 120),
      },
      'Executing plan decomposition',
    );

    const rollbackCreatedTasks = async (): Promise<void> => {
      for (const childId of createdTaskIds) {
        const child = await ctx.taskRepo!.getTask(childId);
        if (child && !TERMINAL_STATUSES.has(child.status)) {
          await ctx.taskRepo!.updateTask(
            childId,
            { status: 'cancelled', progressNote: 'Plan write failed — rolling back created child' },
            ctx.agentId,
          );
        }
      }
    };

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
            if (!planStepDriftsFromChild(step, priorChild)) {
              stepTaskIds[step.id] = priorTaskId;
              continue;
            }
            if (!TERMINAL_STATUSES.has(priorChild.status)) {
              await ctx.taskRepo.updateTask(
                priorTaskId,
                { status: 'cancelled', progressNote: 'Replaced during plan reconcile' },
                ctx.agentId,
              );
            }
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
        createdTaskIds.push(child.id);
        stepTaskIds[step.id] = child.id;
      }

      // Second pass: wire intra-plan dependencies now that all step ids are mapped.
      for (const step of steps) {
        if (step.materialize === false) continue;
        const childTaskId = stepTaskIds[step.id];
        if (!childTaskId) continue;

        const blockedByTaskId = resolveBlockedByTaskId(step.blocked_by_step_id, stepTaskIds);
        await ctx.taskRepo.updateTask(
          childTaskId,
          { blockedByTaskId: blockedByTaskId ?? null },
          ctx.agentId,
        );
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
          next,
        },
        ctx.agentId,
      );

      if ('ok' in planResult && planResult.ok === false) {
        await rollbackCreatedTasks();
        if (planResult.code === 'block_overflow') {
          return {
            success: false,
            error: `Plan block exceeds cap (${planResult.bytes} bytes, max ${planResult.maxBytes})`,
          };
        }
        return { success: false, error: planResult.message ?? 'Failed to write plan block' };
      }

      const { block } = planResult as { task: TaskRow; block: { total: number; done: number } };
      const materialization = countMaterializationKinds(steps);

      await ctx.taskRepo.persistPlanAdaptiveState(taskId, {
        planDepth,
        replanCount,
        pendingSignals: [],
      });

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
      await rollbackCreatedTasks();
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err, taskId }, 'Failed to execute plan');
      return { success: false, error: `Failed to execute plan: ${message}` };
    }
  }
}

export type { PlanStepInput };
