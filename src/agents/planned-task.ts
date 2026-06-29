// planned-task.ts — platform harness for the plan primitive (#1237).
//
// Symmetric with resumable-task.ts (#1173): fixed-slot guidance and per-turn
// dynamic skill pinning — not author-editable agent YAML.

import { isPlannedStep, readPlanBlock, type PlanProgressBlock } from '../db/plan-progress.js';
import { isResumableTask, type BoundTaskContext } from './resumable-task.js';

export const PLAN_SKILL_NAME = 'plan';

/** Bound tasks that may decompose via `plan` (complex parents — not iterate leaves). */
export function shouldOfferPlanSkill(ctx: Pick<BoundTaskContext, 'errorBudget' | 'tags' | 'progress'>): boolean {
  if (isPlannedStep(ctx.progress ?? {})) return true;
  // Iterate leaves are resumable-only; they checkpoint, they do not plan.
  return !isResumableTask(ctx);
}

export function buildPlanTaskGuidanceBlock(existingPlan?: PlanProgressBlock | null): string {
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
      `- Next: ${existingPlan.next}`,
      existingPlan.deliverableStepId
        ? `- Deliverable step: \`${existingPlan.deliverableStepId}\``
        : '- Deliverable: default child-summary rollup',
    );
  }

  return lines.join('\n');
}

export function readExistingPlan(progress: Record<string, unknown> | undefined): PlanProgressBlock | null {
  return readPlanBlock(progress ?? {});
}

export function isPlannedParentTask(ctx: Pick<BoundTaskContext, 'progress'>): boolean {
  return isPlannedStep(ctx.progress ?? {});
}
