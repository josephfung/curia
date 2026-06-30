// planned-task.ts — platform harness for the plan primitive (#1237).
//
// Symmetric with resumable-task.ts (#1173): fixed-slot guidance and per-turn
// dynamic skill pinning — not author-editable agent YAML.

import { isPlannedStep, readPlanBlock, type PlanProgressBlock } from '../db/plan-progress.js';
import { isResumableTask, type BoundTaskContext } from './resumable-task.js';
import {
  buildPlanDivergenceGuidanceBlock,
  readPlanAdaptiveState,
} from './plan-adaptive-replan.js';
import type { ToolDefinition } from './llm/provider.js';

export const PLAN_SKILL_NAME = 'plan';

/** Bound tasks that may decompose via `plan` (complex parents — not iterate leaves). */
export function shouldOfferPlanSkill(ctx: Pick<BoundTaskContext, 'errorBudget' | 'tags' | 'progress'>): boolean {
  if (isPlannedStep(ctx.progress ?? {})) return true;
  // Iterate leaves are resumable-only; they checkpoint, they do not plan.
  return !isResumableTask(ctx);
}

/** Strip control chars / newlines from persisted plan text before prompt injection. */
export function sanitizePlanPromptText(value: string): string {
  return value
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\r?\n/g, ' ')
    .replace(/`/g, '\'')
    .trim();
}

export function buildPlanTaskGuidanceBlock(
  existingPlan?: PlanProgressBlock | null,
  progress?: Record<string, unknown>,
): string {
  const lines = [
    '## Planned Task',
    '',
    'You are executing a goal that may require decomposition. Choose the right representation:',
    '',
    '- **`plan`** — ~10 heterogeneous steps with dependencies (kickoff design, multi-party',
    '  coordination). Materializes child task rows. Progressive: only expand a step when picked up.',
    '- **Iterate leaf** — one high-count homogeneous sweep (1,300 follows). A *single* child row',
    '  with `resumable: true` and the `checkpoint` loop — emphatically not one row per item.',
    '- **Atomic leaf** — completes in one invocation; no child rows.',
    '',
    'Altitude rule: ~10 child rows for a complex goal, not 1,300. Synthesis is just the last',
    'planned step — mark it with `deliverable_step_id`; no special machinery.',
    '',
    'Call `plan` with step descriptors. Set `materialize: false` on steps that should stay',
    'lazy until a prior step completes. Re-running `plan` reconciles against existing children',
    'by step `id` — never duplicate.',
  ];

  if (existingPlan) {
    lines.push(
      '',
      '### Current plan',
      `- Progress: ${existingPlan.done} / ${existingPlan.total}`,
      `- Next: ${sanitizePlanPromptText(existingPlan.next)}`,
      existingPlan.deliverableStepId
        ? `- Deliverable step: \`${sanitizePlanPromptText(existingPlan.deliverableStepId)}\``
        : '- Deliverable: default child-summary rollup',
    );
  }

  const divergenceBlock = buildPlanDivergenceGuidanceBlock(
    readPlanAdaptiveState(progress ?? {})?.pendingSignals ?? [],
  );
  if (divergenceBlock) {
    lines.push('', divergenceBlock);
  }

  return lines.join('\n');
}

export function readExistingPlan(progress: Record<string, unknown> | undefined): PlanProgressBlock | null {
  return readPlanBlock(progress ?? {});
}

export function isPlannedParentTask(ctx: Pick<BoundTaskContext, 'progress'>): boolean {
  return isPlannedStep(ctx.progress ?? {});
}

/** Runtime wiring: append plan guidance and auto-pin the plan tool for eligible bound tasks. */
export function applyPlanHarness(options: {
  boundTaskCtx: BoundTaskContext;
  workingToolDefs: ToolDefinition[] | null | undefined;
  getToolDefinitions: (names: string[]) => ToolDefinition[];
  effectiveSystemPrompt: string;
}): { effectiveSystemPrompt: string; workingToolDefs: ToolDefinition[] | null | undefined } {
  if (!shouldOfferPlanSkill(options.boundTaskCtx)) {
    return {
      effectiveSystemPrompt: options.effectiveSystemPrompt,
      workingToolDefs: options.workingToolDefs,
    };
  }

  let workingToolDefs = options.workingToolDefs;
  const effectiveSystemPrompt = `${options.effectiveSystemPrompt}\n\n${buildPlanTaskGuidanceBlock(
    readExistingPlan(options.boundTaskCtx.progress),
    options.boundTaskCtx.progress,
  )}`;

  if (!workingToolDefs) {
    workingToolDefs = [];
  }
  const hasPlan = workingToolDefs.some((tool) => tool.name === PLAN_SKILL_NAME);
  if (!hasPlan) {
    const planDefs = options.getToolDefinitions([PLAN_SKILL_NAME]);
    if (planDefs.length > 0) {
      workingToolDefs = [...workingToolDefs, ...planDefs];
    }
  }

  return { effectiveSystemPrompt, workingToolDefs };
}
